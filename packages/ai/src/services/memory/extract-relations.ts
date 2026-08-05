import db from "@fretik/shared/db";
import { parseLlmJsonObject } from "@fretik/shared/lib/llm-json";
import {
  RESOLUTION_AUTO_THRESHOLD,
  RESOLUTION_SUGGEST_THRESHOLD,
} from "@fretik/shared/lib/resolution";
import { resolveLinkType } from "@fretik/shared/services/link-types/match";
import { bulkCreateLinks } from "@fretik/shared/services/links/bulk-create";
import { invalidateLink } from "@fretik/shared/services/links/invalidate";
import { generateText } from "ai";
import { z } from "zod";
import { telemetryFor } from "../../lib/langfuse";
import { resolveMemoryModel } from "../../lib/model-registry/team-model";
import { withNamedTrace } from "../../lib/trace-tool";

/**
 * Relation extraction (P8.4) — the second pass of the async resolver, run only
 * when an event already resolved to ≥2 records. Given the event text and those
 * records, a utility model extracts the typed relations the text ASSERTS
 * between them (`Alice — works_for → Acme`), which become `links` — the graph
 * finally carries facts, not just co-mentions.
 *
 * Trust, not truth: extracted edges are BANDED like mentions — `confirmed` at
 * ≥ RESOLUTION_AUTO_THRESHOLD, `suggested` in the review band, dropped below
 * RESOLUTION_SUGGEST_THRESHOLD — and `source: ai_inference`. Predicates are
 * canonicalized (`resolveLinkType`, trigram) so the catalog never sprawls
 * (`works_for` vs `employed_by`). Endpoints are constrained to the provided
 * records — a relation to an id the model invented is dropped.
 *
 * Change over time (Mem0-style, LLM-driven — cardinality can't help, every
 * link type is many-to-many): when the text supersedes a fact, the model names
 * the existing link it `invalidates`; we close it non-destructively
 * (`invalidateLink`, pointing at the new edge). Never deletes.
 */

const MAX_TEXT_CHARS = 8_000;
const MAX_RELATIONS = 12;
/** Off the hot path — sized for the slowest eligible model, see `extract-mentions.ts`. */
const EXTRACT_TIMEOUT_MS = 90_000;
const EXTRACT_TEMPERATURE = 0;
/** See `consolidate-episodes.ts`: sized so reasoning cannot starve the answer. */
const EXTRACT_MAX_OUTPUT_TOKENS = 12_000;

const relationsOutputSchema = z.object({
  relations: z
    .array(
      z.object({
        fromRecordId: z.string(),
        predicate: z.string().min(1),
        toRecordId: z.string(),
        confidence: z.number().min(0).max(1),
        invalidatesLinkId: z.string().optional(),
      }),
    )
    .default([]),
});

const SYSTEM_PROMPT = `Extract the typed relationships the text ASSERTS between the given records. Only relations the text actually states — not guesses, not co-occurrence.

Output strict JSON, nothing else:
{"relations":[{"fromRecordId":"<id>","predicate":"<verb_phrase>","toRecordId":"<id>","confidence":0.0,"invalidatesLinkId":"<id?>"}]}

- fromRecordId / toRecordId: ids from <records> ONLY. Never invent an id; a relation to something not in <records> → skip it.
- predicate: a short, reusable relation key in snake_case from the subject's side (e.g. "works_for", "supplies", "located_in", "parent_company_of"). Prefer an existing one from <known_relations>.
- confidence: 0..1 — how explicitly the text states this relation. 1.0 when stated outright; ≤0.4 when merely implied.
- invalidatesLinkId: set ONLY when the text makes an existing edge from <current_links> no longer true (a change, a correction) — the id of that edge. Omit otherwise.
- Max ${MAX_RELATIONS.toString()} relations, most explicit first. Nothing stated → {"relations":[]}.`;

interface RecordInfo {
  id: string;
  label: string;
  objectTypeId: string;
  typeLabel: string;
}

export interface ExtractRelationsResult {
  created: number;
  suggested: number;
  invalidated: number;
}

const ZERO: ExtractRelationsResult = {
  created: 0,
  suggested: 0,
  invalidated: 0,
};

export const extractRelations = async (input: {
  text: string;
  recordIds: string[];
  teamId: string;
  organizationId: string;
  /** Force a registry profile — EVAL/BENCH ONLY. */
  modelProfileKey?: string;
}): Promise<ExtractRelationsResult> => {
  const { teamId, organizationId } = input;
  const text = input.text.trim().slice(0, MAX_TEXT_CHARS);
  const uniqueRecordIds = [...new Set(input.recordIds)];
  if (text.length === 0 || uniqueRecordIds.length < 2) return ZERO;

  // Records with their types (the relation endpoints + link-type validation).
  const recordRows = await db.query.objectRecords.findMany({
    where: { id: { in: uniqueRecordIds }, teamId },
    columns: { id: true, label: true, objectTypeId: true },
    with: { objectType: { columns: { label: true } } },
  });
  if (recordRows.length < 2) return ZERO;
  const records = new Map<string, RecordInfo>(
    recordRows.map((r) => [
      r.id,
      {
        id: r.id,
        label: r.label,
        objectTypeId: r.objectTypeId,
        typeLabel: r.objectType?.label ?? "record",
      },
    ]),
  );

  // Active edges already between these records — the invalidation candidates.
  const existingLinks = await db.query.links.findMany({
    where: {
      teamId,
      invalidatedAt: { isNull: true },
      fromRecordId: { in: uniqueRecordIds },
      toRecordId: { in: uniqueRecordIds },
    },
    columns: { id: true, fromRecordId: true, toRecordId: true },
    with: { linkType: { columns: { label: true } } },
  });
  const existingLinkIds = new Set(existingLinks.map((l) => l.id));

  // Known relation keys for canonicalization guidance — scoped to predicates
  // whose SUBJECT type is one of these records' types (the same axis
  // `resolveLinkType` dedups on, and now the same axis the uniqueness index
  // uses). Unscoped, a busy team's unrelated predicates would tempt the model
  // into borrowing a key valid for a different type pair, and the edge is then
  // rejected downstream. Relevant catalog only.
  const recordTypeIds = [
    ...new Set([...records.values()].map((r) => r.objectTypeId)),
  ];
  const catalog = await db.query.linkTypes.findMany({
    where: { teamId, fromObjectTypeId: { in: recordTypeIds } },
    columns: { key: true, label: true },
    limit: 40,
  });

  const recordBlock = [...records.values()]
    .map((r) => `- ${r.id} — ${r.label} (${r.typeLabel})`)
    .join("\n");
  const linkBlock =
    existingLinks.length > 0
      ? `\n\n<current_links>\n${existingLinks
          .map(
            (l) =>
              `- ${l.id}: ${records.get(l.fromRecordId)?.label ?? "?"} —${l.linkType?.label ?? "linked"}→ ${records.get(l.toRecordId)?.label ?? "?"}`,
          )
          .join("\n")}\n</current_links>`
      : "";
  const catalogBlock =
    catalog.length > 0
      ? `\n\n<known_relations>\n${catalog.map((c) => `- ${c.key}`).join("\n")}\n</known_relations>`
      : "";
  const prompt = `<text>\n${text}\n</text>\n\n<records>\n${recordBlock}\n</records>${linkBlock}${catalogBlock}`;

  // Called straight from the internal HTTP handler, so this is its own root
  // trace — name it, or it lands as `invoke_agent <model>` (see
  // `withNamedTrace`).
  const { text: raw } = await withNamedTrace(
    "memory-extract",
    { tags: [`team:${teamId}`], metadata: { teamId } },
    async () => {
      const { model } = await resolveMemoryModel(
        "memory-extract",
        teamId,
        input.modelProfileKey,
      );
      return generateText({
        model,
        instructions: SYSTEM_PROMPT,
        prompt,
        temperature: EXTRACT_TEMPERATURE,
        maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
        telemetry: telemetryFor("memory-extract"),
      });
    },
  );
  const parsed = relationsOutputSchema.safeParse(parseLlmJsonObject(raw));
  if (!parsed.success) return ZERO;

  // Keep only relations between two DISTINCT provided records, above the floor.
  const valid = parsed.data.relations
    .filter(
      (r) =>
        r.fromRecordId !== r.toRecordId &&
        records.has(r.fromRecordId) &&
        records.has(r.toRecordId) &&
        r.confidence >= RESOLUTION_SUGGEST_THRESHOLD,
    )
    .slice(0, MAX_RELATIONS);
  if (valid.length === 0) return ZERO;

  // Canonicalize each predicate against the catalog (may create a suggested
  // link type). A handful of distinct predicates per event → sequential is fine.
  const linkInputs: {
    linkTypeId: string;
    fromRecordId: string;
    toRecordId: string;
    confidence: number;
    status: "confirmed" | "suggested";
    invalidatesLinkId?: string;
  }[] = [];
  for (const r of valid) {
    const from = records.get(r.fromRecordId);
    const to = records.get(r.toRecordId);
    if (!from || !to) continue;
    // Per-relation, not per-pass: canonicalizing a predicate can fail on a
    // constraint the caller cannot see (it may create a link type), and one
    // unusable predicate must not cost the event its OTHER relations. This
    // used to throw all the way out — the memory-resolve worker then logged
    // "relation extraction unavailable" and dropped the whole pass, silently.
    let linkTypeId: string;
    try {
      ({ linkTypeId } = await resolveLinkType({
        organizationId,
        teamId,
        rawKey: r.predicate,
        fromObjectTypeId: from.objectTypeId,
        toObjectTypeId: to.objectTypeId,
      }));
    } catch (err) {
      console.warn(
        `[extract-relations] predicate "${r.predicate}" unresolvable for ${from.typeLabel}→${to.typeLabel}, skipping:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    linkInputs.push({
      linkTypeId,
      fromRecordId: r.fromRecordId,
      toRecordId: r.toRecordId,
      confidence: r.confidence,
      status:
        r.confidence >= RESOLUTION_AUTO_THRESHOLD ? "confirmed" : "suggested",
      invalidatesLinkId:
        r.invalidatesLinkId && existingLinkIds.has(r.invalidatesLinkId)
          ? r.invalidatesLinkId
          : undefined,
    });
  }

  const { ids } = await bulkCreateLinks({
    organizationId,
    teamId,
    source: "ai_inference",
    links: linkInputs.map((l) => ({
      linkTypeId: l.linkTypeId,
      fromRecordId: l.fromRecordId,
      toRecordId: l.toRecordId,
      confidence: l.confidence,
      status: l.status,
    })),
  });

  // Non-destructive supersession: close each named prior edge, pointing it at
  // the new edge that replaced it (only when the new edge was actually created).
  let invalidated = 0;
  for (const [i, l] of linkInputs.entries()) {
    const newId = ids[i];
    if (l.invalidatesLinkId && newId) {
      try {
        await invalidateLink({
          id: l.invalidatesLinkId,
          replacedByLinkId: newId,
        });
        invalidated++;
      } catch (err) {
        console.warn(
          `[extract-relations] invalidate ${l.invalidatesLinkId} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  const created = ids.filter((id) => id !== null).length;
  const suggested = linkInputs.filter(
    (l, i) => ids[i] !== null && l.status === "suggested",
  ).length;
  return { created, suggested, invalidated };
};
