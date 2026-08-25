import db from "../../db";
import { pages } from "../../db/schema";
import { badRequest, internalError, throwHttpError } from "../../lib/errors";
import {
  CreatePageSchema,
  type CreatePageInput,
  type PageResponse,
} from "../../schemas/pages";
import { ensurePageCompiled } from "./compile";
import { derivePageDescription } from "./derive-description";
import { ensurePageDatasetIndexes } from "./ensure-dataset-indexes";
import { sanitizePageDefinition } from "./sanitize";
import { serializePage } from "./serialize";
import { refreshPageVectors } from "./vector-refresh";
import type { PageVersionActor } from "./versions";
import { trimPageVersions, writePageVersion } from "./versions";
import { pageOwnerWriteError } from "./visibility";

/**
 * Create a page. Always unpublished (`publicToken` NULL) — exposing it
 * anonymously is a separate, gated step.
 *
 * The definition is SANITIZED, not rejected: off-catalog props are dropped and
 * every problem comes back as a warning, so a model that best-guesses stays
 * unblocked and reads the warnings to fix its next turn.
 *
 * Warnings are RETURNED, not logged: the caller's dry run skips the static pass
 * on an already-sanitized definition, so this is the only place they can reach
 * the agent on a write.
 */
export const createPage = async (params: {
  organizationId: string;
  teamId: string;
  createdByUserId: string;
  input: CreatePageInput;
  /** Who is writing, for the history. Defaults to the human doing the create. */
  actor?: PageVersionActor;
}): Promise<{ page: PageResponse; warnings: string[] }> => {
  const input = CreatePageSchema.parse(params.input);

  const ownerError = pageOwnerWriteError(
    input.userId ?? null,
    params.createdByUserId,
  );
  if (ownerError) return throwHttpError(400, badRequest(ownerError));

  const sanitized = sanitizePageDefinition(input.definition);
  // Compile at save. A failing compile REFUSES the create (400 with the
  // compiler's errors) — code is binary, see `services/pages/compile.ts`.
  const compiled = await ensurePageCompiled(sanitized.definition);
  const definition = compiled.definition;
  // Repairs are reported, never silent: the agent must know the stored source
  // differs from what it sent, or its next edit anchors miss.
  const warnings = [
    ...sanitized.warnings,
    ...compiled.autofixes.map((fix) => fix.message),
  ];

  // The page and its version 1 are ONE fact: a page whose history does not
  // start where the page starts cannot be restored to its original state. Same
  // reason `ai_memory_history` takes an executor — an audit row that can go
  // missing while the parent write succeeds is not an audit row.
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(pages)
      .values({
        organizationId: params.organizationId,
        teamId: params.teamId,
        userId: input.userId ?? null,
        name: input.name,
        description:
          derivePageDescription({
            current: input.description,
            definition,
          }) ?? input.description,
        icon: input.icon ?? null,
        color: input.color ?? null,
        definition,
        sourceConversationId: input.sourceConversationId ?? null,
        createdByUserId: params.createdByUserId,
      })
      .returning();
    if (!created) return undefined;

    await writePageVersion(tx, {
      pageId: created.id,
      teamId: params.teamId,
      name: created.name,
      operation: "create",
      definition,
      actor: params.actor ?? {
        actor: "user",
        userId: params.createdByUserId,
        conversationId: input.sourceConversationId ?? null,
      },
    });
    return created;
  });

  if (!row) return throwHttpError(500, internalError());
  // Both deliberately outside the transaction: `CREATE INDEX CONCURRENTLY`
  // cannot run in one at all, and a trim failure must never undo a page the
  // user just made.
  ensurePageDatasetIndexes({ definition });
  await trimPageVersions(row.id);
  // Fire-and-forget by contract — see `refreshPageVectors`.
  void refreshPageVectors(row.id);
  return { page: serializePage(row), warnings };
};
