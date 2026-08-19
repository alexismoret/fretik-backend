import db from "../../db";
import { pages } from "../../db/schema";
import { badRequest, internalError, throwHttpError } from "../../lib/errors";
import {
  CreatePageSchema,
  type CreatePageInput,
  type PageResponse,
} from "../../schemas/pages";
import { ensurePageCompiled } from "./compile";
import { ensurePageDatasetIndexes } from "./ensure-dataset-indexes";
import { sanitizePageDefinition } from "./sanitize";
import { serializePage } from "./serialize";
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
}): Promise<{ page: PageResponse; warnings: string[] }> => {
  const input = CreatePageSchema.parse(params.input);

  const ownerError = pageOwnerWriteError(
    input.userId ?? null,
    params.createdByUserId,
  );
  if (ownerError) return throwHttpError(400, badRequest(ownerError));

  const sanitized = sanitizePageDefinition(input.definition);
  const { warnings } = sanitized;
  // Compile at save. A failing compile REFUSES the create (400 with the
  // compiler's errors) — code is binary, see `services/pages/compile.ts`.
  const definition = await ensurePageCompiled(sanitized.definition);

  const [row] = await db
    .insert(pages)
    .values({
      organizationId: params.organizationId,
      teamId: params.teamId,
      userId: input.userId ?? null,
      name: input.name,
      description: input.description,
      icon: input.icon ?? null,
      color: input.color ?? null,
      definition,
      sourceConversationId: input.sourceConversationId ?? null,
      createdByUserId: params.createdByUserId,
    })
    .returning();

  if (!row) return throwHttpError(500, internalError());
  // Deliberately not awaited: `CREATE INDEX CONCURRENTLY` scales with the
  // table, and the page is already saved and queryable without it.
  ensurePageDatasetIndexes({ definition });
  return { page: serializePage(row), warnings };
};
