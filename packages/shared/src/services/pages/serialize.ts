import type { Page } from "../../db/schema";
import type { PageResponse, PageSummary } from "../../schemas/pages";

/** Public URL of a published page; null while unpublished. */
export const buildPageUrl = (token: string | null): string | null => {
  if (!token) return null;
  const appUrl = process.env.APP_URL;
  if (!appUrl) return null;
  return `${appUrl.replace(/\/+$/, "")}/p/${token}`;
};

/**
 * Map a `pages` row to its API DTO. The jsonb column is already the right
 * shape (typed via `$type` from the shared schema), so this is a field
 * projection — no re-validation.
 */
export const serializePage = (row: Page): PageResponse => ({
  id: row.id,
  name: row.name,
  description: row.description,
  icon: row.icon,
  color: row.color,
  userId: row.userId,
  definition: row.definition,
  runtimeErrors: row.runtimeErrors,
  publicToken: row.publicToken,
  publishedAt: row.publishedAt,
  publicUrl: buildPageUrl(row.publicToken),
  sourceConversationId: row.sourceConversationId,
  createdByUserId: row.createdByUserId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** List projection — sizes instead of the whole document. */
export const serializePageSummary = (row: Page): PageSummary => {
  const { definition, ...rest } = serializePage(row);
  return {
    ...rest,
    sourceBytes: definition.code.source.length,
    datasetCount: definition.datasets.length,
  };
};
