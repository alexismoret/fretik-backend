import { and, eq } from "drizzle-orm";
import db from "../../db";
import { pages } from "../../db/schema";
import { badRequest, notFound, throwHttpError } from "../../lib/errors";
import {
  UpdatePageSchema,
  type PageResponse,
  type UpdatePageInput,
} from "../../schemas/pages";
import { ensurePageCompiled } from "./compile";
import { ensurePageDatasetIndexes } from "./ensure-dataset-indexes";
import { sanitizePageDefinition } from "./sanitize";
import { serializePage } from "./serialize";
import type { PageRequester } from "./visibility";
import { pageOwnerWriteError, pageVisibilityWhere } from "./visibility";

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
  requester?: PageRequester;
  input: UpdatePageInput;
}): Promise<{ page: PageResponse; warnings: string[]; polish: string[] }> => {
  const input = UpdatePageSchema.parse(params.input);

  const existing = await db.query.pages.findFirst({
    columns: { id: true, definition: true },
    where: {
      id: params.pageId,
      teamId: params.teamId,
      ...pageVisibilityWhere(params.requester),
    },
  });
  if (!existing) return throwHttpError(404, notFound("Page"));

  if (input.userId !== undefined) {
    const ownerError = pageOwnerWriteError(input.userId, params.actingUserId);
    if (ownerError) return throwHttpError(400, badRequest(ownerError));
  }

  const sanitized = input.definition
    ? sanitizePageDefinition(input.definition)
    : null;
  // Compile at save (compile failure refuses the write). The stored compile is
  // carried over when the source is byte-identical — the tool strips
  // `compiled` from what the agent reads, so a round-tripped definition
  // arrives without it.
  let definition = sanitized?.definition;
  if (definition) {
    definition = await ensurePageCompiled(definition, {
      previous: existing.definition.code.compiled,
    });
  }

  const [row] = await db
    .update(pages)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      // A definition write resets the self-heal feed too: the tail the agent
      // reads must describe the CURRENT code, not the one it just replaced.
      ...(definition ? { definition, runtimeErrors: [] } : {}),
    })
    .where(and(eq(pages.id, params.pageId), eq(pages.teamId, params.teamId)))
    .returning();

  if (!row) return throwHttpError(404, notFound("Page"));
  // Not awaited — see `createPage`.
  if (definition) {
    ensurePageDatasetIndexes({ definition });
  }
  // Both channels — see `createPage` for why `polish` must not stop here.
  return {
    page: serializePage(row),
    warnings: sanitized?.warnings ?? [],
    polish: sanitized?.polish ?? [],
  };
};
