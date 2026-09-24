import { and, eq } from "drizzle-orm";
import { resolveAccess } from "../../authz/access";
import { restrictionColumns } from "../../authz/legacy-privacy";
import { atLeast } from "../../authz/levels";
import type { Principal } from "../../authz/principal";
import db from "../../db";
import { pages } from "../../db/schema";
import {
  badRequest,
  forbidden,
  notFound,
  throwHttpError,
} from "../../lib/errors";
import {
  UpdatePageSchema,
  type PageResponse,
  type UpdatePageInput,
} from "../../schemas/pages";
import { keepAccessAfterRestricting } from "../access/keep-access";
import { resyncVectorUserScope } from "../ai-vectors/resync-user-scope";
import { ensurePageCompiled } from "./compile";
import { derivePageDescription } from "./derive-description";
import { ensurePageDatasetIndexes } from "./ensure-dataset-indexes";
import { sanitizePageDefinition } from "./sanitize";
import { serializePage } from "./serialize";
import { validatePageDefinitionConnections } from "./validate-connections";
import { refreshPageVectors } from "./vector-refresh";
import type {
  PageVersionActor,
  PageVersionMeta,
  PageVersionOperation,
} from "./versions";
import { trimPageVersions, writePageVersion } from "./versions";
import { pageAccessWhere } from "./visibility";

/**
 * Patch a page. Any field may be omitted; the definition, when present, is
 * replaced wholesale (the agent regenerates the tree rather than patching it)
 * and sanitized on the way in.
 *
 * Editing a PUBLISHED page does not change what the public URL serves —
 * `publishedDefinition` is a separate snapshot, refreshed only by publishing
 * again. That is what lets a team iterate on a live page without leaking
 * half-built states to anonymous viewers.
 */
export const updatePage = async (params: {
  pageId: string;
  teamId: string;
  actingUserId: string;
  /** Who is asking; editing takes `edit`, changing who sees it `full`. */
  principal: Principal;
  input: UpdatePageInput;
  /**
   * The conversation doing the writing, when there is one. It only ever fills a
   * NULL: a page carries the chat that AUTHORED it, and a later edit from
   * another conversation must not re-parent it. This exists because the hub's
   * "New page" button creates a row with no conversation and the agent then
   * fills it in — without the backfill those pages stay orphaned forever, which
   * is why the provenance column read empty across the board.
   */
  sourceConversationId?: string;
  /** Who is writing, for the history. Defaults to the acting human. */
  actor?: PageVersionActor;
  /** `review-round` marks a checkpoint the review loop can restore. */
  versionOperation?: PageVersionOperation;
  versionMeta?: PageVersionMeta;
}): Promise<{ page: PageResponse; warnings: string[] }> => {
  const input = UpdatePageSchema.parse(params.input);

  const existing = await db.query.pages.findFirst({
    columns: {
      id: true,
      definition: true,
      description: true,
      sourceConversationId: true,
      ownerUserId: true,
      userId: true,
      createdByUserId: true,
    },
    where: {
      id: params.pageId,
      teamId: params.teamId,
      ...pageAccessWhere(params.principal, "edit"),
    },
  });
  if (!existing) return throwHttpError(404, notFound("Page"));

  // `userId` is the LEGACY way to say who sees the page: null opens it to its
  // container, a person's id restricts it. Deciding that is sharing, so it
  // takes full access; and it never moves ownership — restricting keeps the
  // owner, the one a legacy client names being the caller or the owner.
  const owner =
    existing.ownerUserId ?? existing.userId ?? existing.createdByUserId;
  const restriction =
    input.userId === undefined
      ? undefined
      : await decideRestriction({
          principal: params.principal,
          pageId: existing.id,
          requestedUserId: input.userId,
          actingUserId: params.actingUserId,
          ownerUserId: owner,
        });

  const sanitized = input.definition
    ? sanitizePageDefinition(input.definition)
    : null;
  // Compile at save (compile failure refuses the write). The stored compile is
  // carried over when the source is byte-identical — the tool strips
  // `compiled` from what the agent reads, so a round-tripped definition
  // arrives without it.
  let definition = sanitized?.definition;
  const autofixes: string[] = [];
  if (definition) {
    // Refuses alongside the compiler — see `createPage`.
    const connections = await validatePageDefinitionConnections({
      definition,
      teamId: params.teamId,
    });
    const refusals = [...(sanitized?.errors ?? []), ...connections.errors];
    if (refusals.length > 0) {
      return throwHttpError(400, badRequest(refusals.join(" ")));
    }
    const compiled = await ensurePageCompiled(definition, {
      previous: existing.definition.code.compiled,
    });
    definition = compiled.definition;
    autofixes.push(...compiled.autofixes.map((fix) => fix.message));
  }

  // A definition write is when the brief lands, so it is also the moment to
  // give a page still listing itself as a bare name its one line. An explicit
  // description always wins, including an empty one that clears it.
  const nextDescription =
    input.description ??
    (definition
      ? derivePageDescription({ current: existing.description, definition })
      : undefined);

  // The write and its history entry commit together — see `createPage`.
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(pages)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(nextDescription !== undefined
          ? { description: nextDescription }
          : {}),
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(restriction === undefined
          ? {}
          : restrictionColumns({
              restricted: restriction.restricted,
              ownerUserId: restriction.ownerUserId,
            })),
        ...(params.sourceConversationId !== undefined &&
        existing.sourceConversationId === null
          ? { sourceConversationId: params.sourceConversationId }
          : {}),
        // A definition write resets the self-heal feed too: the tail the agent
        // reads must describe the CURRENT code, not the one it just replaced.
        ...(definition ? { definition, runtimeErrors: [] } : {}),
      })
      .where(and(eq(pages.id, params.pageId), eq(pages.teamId, params.teamId)))
      .returning();
    if (!updated) return undefined;

    // Visibility moves NOW, in this transaction. The async refresh below
    // rewrites the card text, but it swallows its own errors, so a dropped
    // refresh would leave a privatised page readable by the whole team until
    // someone saved it again. One indexed UPDATE, no embedding.
    if (restriction !== undefined) {
      await resyncVectorUserScope({
        sourceType: "pages",
        sourceId: updated.id,
        userId: updated.userId,
        tx,
      });
      if (restriction.restricted) {
        await keepAccessAfterRestricting({
          tx,
          resourceType: "page",
          resourceId: updated.id,
          organizationId: updated.organizationId,
          ownerUserId: restriction.ownerUserId,
          actingUserId: params.actingUserId,
        });
      }
    }

    // Only a DEFINITION change is a version. Renaming a page or recolouring
    // its icon leaves nothing to restore, and versioning those would push the
    // states that matter out of the retention window.
    if (definition) {
      await writePageVersion(tx, {
        pageId: updated.id,
        teamId: params.teamId,
        name: updated.name,
        operation: params.versionOperation ?? "update",
        definition,
        actor: params.actor ?? {
          actor: "user",
          userId: params.actingUserId,
          conversationId: params.sourceConversationId ?? null,
        },
        ...(params.versionMeta ? { meta: params.versionMeta } : {}),
      });
    }
    return updated;
  });

  if (!row) return throwHttpError(404, notFound("Page"));
  // Not awaited — see `createPage`.
  if (definition) {
    ensurePageDatasetIndexes({ definition });
    await trimPageVersions(row.id);
  }
  // Unconditional, unlike the version write above: a rename, a new description
  // and — the one that matters — a switch between team-shared and private all
  // change the card without touching the definition.
  void refreshPageVectors(row.id);
  // Returned, not logged — see `createPage`.
  return {
    page: serializePage(row),
    warnings: [...(sanitized?.warnings ?? []), ...autofixes],
  };
};

/**
 * Decide a legacy `userId` write: who may change the restriction, and what it
 * becomes. Full access is required — it is sharing — unless the caller is a
 * system principal. The named id must be the caller's (what the app sends) or
 * the owner's; it restricts the page and keeps its owner, and a page with no
 * owner left is taken over by the caller who restricts it.
 */
const decideRestriction = async (input: {
  principal: Principal;
  pageId: string;
  requestedUserId: string | null;
  actingUserId: string;
  ownerUserId: string | null;
}): Promise<{ restricted: boolean; ownerUserId: string | null }> => {
  const resolved =
    input.principal.kind === "system"
      ? { level: "full" as const }
      : await resolveAccess(input.principal, "page", input.pageId);
  if (!resolved || !atLeast(resolved.level, "full")) {
    return throwHttpError(
      403,
      forbidden("Changing who sees this page takes full access"),
    );
  }
  if (input.requestedUserId === null) {
    return { restricted: false, ownerUserId: input.ownerUserId };
  }
  if (
    input.requestedUserId !== input.actingUserId &&
    input.requestedUserId !== input.ownerUserId
  ) {
    return throwHttpError(
      400,
      badRequest(
        "page.userId can only be null (open to the team) or your own id (restricted). A page is never handed to someone else this way.",
      ),
    );
  }
  return {
    restricted: true,
    ownerUserId: input.ownerUserId ?? input.actingUserId,
  };
};
