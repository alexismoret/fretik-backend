import db from "@fretik/shared/db";
import { resolveDocumentRecordIds } from "@fretik/shared/services/collection-records/resolve-document-record";
import { assertCanWriteRecord } from "@fretik/shared/services/collection-sharing/write-access";
import type { EventActor } from "@fretik/shared/services/domain-events/emit";
import { resolveLinkType } from "@fretik/shared/services/link-types/match";
import {
  bulkCreateLinks,
  type LinkInput,
} from "@fretik/shared/services/links/bulk-create";
import { invalidateLinks } from "@fretik/shared/services/links/invalidate";
import { tool } from "ai";
import { z } from "zod";
import { gateBuiltinWriteTool } from "../agents/shared/policy-tool-gate";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { workflowWriteBackstop } from "../agents/shared/workflow-write-backstop";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";
import { inProcessEvaluator } from "../services/decisions/in-process";

/**
 * Edges one call may carry, links or unlinks. Same reasoning as
 * `manageDrive`'s document cap: two ids per edge stay a few thousand tokens
 * for the model to write, and a load of thousands of records still links in
 * a handful of calls instead of one step per edge.
 */
export const MAX_LINKS_PER_CALL = 200;

const linkEndsSchema = z.object({
  fromRecordId: z.string().optional().describe("Source record."),
  fromDocumentId: z
    .string()
    .optional()
    .describe("Source = this uploaded file's document record."),
  toRecordId: z.string().optional().describe("Target record."),
  toDocumentId: z
    .string()
    .optional()
    .describe("Target = this uploaded file's document record."),
});

type LinkEnds = z.infer<typeof linkEndsSchema>;

/**
 * `manageLink` input schema. Exported for its test. The single-edge fields
 * stay: every call in an older conversation's history carries them, and one
 * edge is still the common case.
 */
export const manageLinkInputSchema = linkEndsSchema.extend({
  action: z.enum(["link", "unlink"]),
  relationKey: z
    .string()
    .max(60)
    .optional()
    .describe("Relation slug, e.g. 'works_for'. Required for link."),
  links: z
    .array(linkEndsSchema)
    .max(MAX_LINKS_PER_CALL)
    .optional()
    .describe(
      `Several edges over the same relationKey, each with a from end and a to end. For link. Max ${MAX_LINKS_PER_CALL.toString()}.`,
    ),
  linkId: z.string().optional().describe("Edge id to remove. For unlink."),
  linkIds: z
    .array(z.string())
    .max(MAX_LINKS_PER_CALL)
    .optional()
    .describe(
      `Edge ids to remove, all at once. For unlink. Max ${MAX_LINKS_PER_CALL.toString()}.`,
    ),
});

type ManageLinkInput = z.infer<typeof manageLinkInputSchema>;

const hasAnyEnd = (e: LinkEnds): boolean =>
  Boolean(e.fromRecordId ?? e.fromDocumentId ?? e.toRecordId ?? e.toDocumentId);

/**
 * The edges a `link` call asks for: the list, plus the top-level pair when
 * one is given (a single edge, or an older call's shape). Exported for its
 * test.
 */
export const requestedEdges = (input: ManageLinkInput): LinkEnds[] => {
  const top: LinkEnds = {
    fromRecordId: input.fromRecordId,
    fromDocumentId: input.fromDocumentId,
    toRecordId: input.toRecordId,
    toDocumentId: input.toDocumentId,
  };
  return [...(input.links ?? []), ...(hasAnyEnd(top) ? [top] : [])];
};

interface FailedEdge {
  index: number;
  reason: string;
}

const errMsg = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);
  // `throwHttpError` wraps `{ code, message }` as JSON; the agent needs the
  // sentence, not the envelope.
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      return parsed.message;
    }
  } catch {
    // Plain message already.
  }
  return raw;
};

/**
 * The records a caller may write, among `recordIds`: owner team, or a write
 * grant/share. One check per DISTINCT record, so a hundred edges from one
 * record cost one lookup. Returns the refusal reason per refused id.
 */
const refusedRecords = async (
  recordIds: readonly string[],
  teamId: string,
  organizationId: string,
): Promise<Map<string, string>> => {
  const refused = new Map<string, string>();
  const checks = await Promise.allSettled(
    [...new Set(recordIds)].map(async (recordId) => {
      await assertCanWriteRecord({ recordId, teamId, organizationId });
      return recordId;
    }),
  );
  [...new Set(recordIds)].forEach((recordId, i) => {
    const check = checks[i];
    if (check?.status === "rejected") {
      refused.set(recordId, errMsg(check.reason));
    }
  });
  return refused;
};

/**
 * Domain tool (deferred) — connect or disconnect records over a relation.
 * `link` resolves (or creates) the relation by key, scoped to the from-record's
 * type; `unlink` invalidates existing edges. Both journal a `domain_event`.
 *
 * Uploaded files are objects too: pass `fromDocumentId` / `toDocumentId` (a real
 * `documents.id`, e.g. from listDocuments) and the edge is made to that file's
 * `document_record` — the agent never resolves the mirror itself.
 *
 * **Takes LISTS.** Linking forty documents to one client was forty agent
 * steps, and the Python loader tells the agent to link a large load "in a
 * second pass" that had no batch path at all. One call is one policy
 * decision, one approval card and one set-based write (`bulkCreateLinks`),
 * with a per-edge outcome.
 */
export const createManageLinkTool = () =>
  tool({
    description: [
      "Connect or disconnect records over a relation.",
      "",
      "- link: relationKey + a from end + a to end, or `links` for several edges over that relation. Resolves the relation by key (creates it if new) and adds the edges.",
      "- unlink: linkIds (from getRecord's links).",
      "",
      `Each end is a record id (fromRecordId / toRecordId) OR an uploaded file id (fromDocumentId / toDocumentId — links to the file's document record). Several edges → ONE call (max ${MAX_LINKS_PER_CALL.toString()}), never one call per edge; read \`failed\` before reporting.`,
    ].join("\n"),
    inputSchema: manageLinkInputSchema,
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      const backstop = workflowWriteBackstop(ctx);
      if (backstop !== null) return backstop;
      const actor: EventActor = {
        actorType: "agent",
        actorUserId: ctx.userId ?? null,
        conversationId: ctx.conversationId ?? null,
      };

      try {
        if (input.action === "unlink") {
          const ids = [
            ...new Set([
              ...(input.linkIds ?? []),
              ...(input.linkId ? [input.linkId] : []),
            ]),
          ];
          if (ids.length === 0) {
            return toolError(
              TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
              "unlink requires linkIds.",
            );
          }
          if (ids.length > MAX_LINKS_PER_CALL) {
            return toolError(
              TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
              `unlink takes at most ${MAX_LINKS_PER_CALL.toString()} edges per call.`,
              "Split the list into several calls.",
            );
          }

          // Only this organization's edges, and only from records the caller
          // may write — the same rule `link` applies to the record gaining the
          // edge. An id alone used to be enough.
          const rows = await db.query.links.findMany({
            columns: { id: true, fromRecordId: true },
            where: { id: { in: ids }, organizationId: ctx.organizationId },
          });
          const refused = await refusedRecords(
            rows.map((r) => r.fromRecordId),
            ctx.teamId,
            ctx.organizationId,
          );
          const allowed = rows
            .filter((r) => !refused.has(r.fromRecordId))
            .map((r) => r.id);
          const failed = [
            ...ids
              .filter((id) => !rows.some((r) => r.id === id))
              .map((linkId) => ({ linkId, reason: "Link not found." })),
            ...rows
              .filter((r) => refused.has(r.fromRecordId))
              .map((r) => ({
                linkId: r.id,
                reason: refused.get(r.fromRecordId) ?? "Not writable.",
              })),
          ];
          if (allowed.length === 0) {
            return { ok: false, action: input.action, unlinked: 0, failed };
          }

          const gate = await gateBuiltinWriteTool(ctx, {
            toolName: "manageLink",
            args: { action: "unlink", linkIds: allowed },
          });
          if (gate !== null) return gate;
          const unlinked = await invalidateLinks({ ids: allowed, actor });
          return {
            ok: failed.length === 0,
            action: input.action,
            unlinked: unlinked.length,
            failed,
          };
        }

        // link
        const edges = requestedEdges(input);
        if (!input.relationKey || edges.length === 0) {
          return toolError(
            TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
            "link requires relationKey and at least one edge: a from end (fromRecordId or fromDocumentId) and a to end (toRecordId or toDocumentId), top-level or in `links`.",
          );
        }
        if (edges.length > MAX_LINKS_PER_CALL) {
          return toolError(
            TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
            `link takes at most ${MAX_LINKS_PER_CALL.toString()} edges per call.`,
            "Split the list into several calls.",
          );
        }

        // Files → their document records, in one read for every edge.
        const mirrors = await resolveDocumentRecordIds({
          documentIds: edges.flatMap((e) => [
            ...(e.fromDocumentId ? [e.fromDocumentId] : []),
            ...(e.toDocumentId ? [e.toDocumentId] : []),
          ]),
          teamId: ctx.teamId,
        });
        const failed: FailedEdge[] = [];
        const resolved: { index: number; from: string; to: string }[] = [];
        edges.forEach((edge, index) => {
          const from =
            edge.fromRecordId ??
            (edge.fromDocumentId
              ? mirrors.get(edge.fromDocumentId)
              : undefined);
          const to =
            edge.toRecordId ??
            (edge.toDocumentId ? mirrors.get(edge.toDocumentId) : undefined);
          if (from && to) {
            resolved.push({ index, from, to });
            return;
          }
          const pendingFile =
            (edge.fromDocumentId && !edge.fromRecordId && !from) ||
            (edge.toDocumentId && !edge.toRecordId && !to);
          failed.push({
            index,
            reason: pendingFile
              ? "No document record for this file yet — it may still be processing."
              : "An edge needs a from end and a to end.",
          });
        });

        // Owner team or a write grant/share on each record gaining an edge.
        const refused = await refusedRecords(
          resolved.map((r) => r.from),
          ctx.teamId,
          ctx.organizationId,
        );
        const writable = resolved.filter((r) => {
          const reason = refused.get(r.from);
          if (reason !== undefined) failed.push({ index: r.index, reason });
          return reason === undefined;
        });

        // The relation resolves per source TYPE, so once per distinct type.
        const fromRows =
          writable.length > 0
            ? await db.query.collectionRecords.findMany({
                columns: { id: true, collectionId: true },
                where: {
                  id: { in: [...new Set(writable.map((r) => r.from))] },
                },
              })
            : [];
        const typeOf = new Map(fromRows.map((r) => [r.id, r.collectionId]));
        const linkTypeByCollection = new Map<string, string>();
        for (const collectionId of new Set(typeOf.values())) {
          // One per source type — usually one, and the resolver may ask the
          // decision model, so these stay sequential rather than fanned out.
          // eslint-disable-next-line no-await-in-loop
          const { linkTypeId } = await resolveLinkType({
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            rawKey: input.relationKey,
            fromCollectionId: collectionId,
            byMeaning: inProcessEvaluator,
          });
          linkTypeByCollection.set(collectionId, linkTypeId);
        }

        const toWrite: (LinkInput & { index: number })[] = [];
        for (const r of writable) {
          const collectionId = typeOf.get(r.from);
          const linkTypeId =
            collectionId === undefined
              ? undefined
              : linkTypeByCollection.get(collectionId);
          if (linkTypeId === undefined) {
            failed.push({ index: r.index, reason: "Record not found." });
            continue;
          }
          toWrite.push({
            index: r.index,
            linkTypeId,
            fromRecordId: r.from,
            toRecordId: r.to,
          });
        }
        if (toWrite.length === 0) {
          return {
            ok: false,
            action: input.action,
            linked: 0,
            failed: failed.sort((a, b) => a.index - b.index),
          };
        }

        // ONE gate for the whole set; the stored args are exactly what
        // `TOOL_CALL_APPLY.manageLink` writes on a grant.
        const gate = await gateBuiltinWriteTool(ctx, {
          toolName: "manageLink",
          args: {
            action: "link",
            links: toWrite.map(({ linkTypeId, fromRecordId, toRecordId }) => ({
              linkTypeId,
              fromRecordId,
              toRecordId,
            })),
          },
        });
        if (gate !== null) return gate;

        const { ids, errors } = await bulkCreateLinks({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          links: toWrite.map(({ linkTypeId, fromRecordId, toRecordId }) => ({
            linkTypeId,
            fromRecordId,
            toRecordId,
          })),
          actor,
        });
        const errorAt = new Map(errors.map((e) => [e.index, e.error]));
        toWrite.forEach((w, i) => {
          const error = errorAt.get(i);
          if (error !== undefined)
            failed.push({ index: w.index, reason: error });
        });
        const created = ids.filter((id): id is string => id !== null);
        const [onlyId] = created;
        return {
          ok: failed.length === 0,
          action: input.action,
          linked: created.length,
          // An edge that was already there is a no-op, not a failure.
          alreadyLinked: toWrite.length - created.length - errors.length,
          ...(created.length === 1 && onlyId ? { linkId: onlyId } : {}),
          // `index` points into `links` (the top-level pair, if any, last).
          failed: failed.sort((a, b) => a.index - b.index),
        };
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
          `manageLink ${input.action} failed: ${errMsg(err)}`,
        );
      }
    },
  });
