import type { Page } from "../../db/schema";
import {
  pageCodeChars,
  type PageResponse,
  type PageSummary,
} from "../../schemas/pages";
import { derivePageDescription } from "./derive-description";

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

/**
 * List projection — sizes instead of the whole document.
 *
 * A listing is the only place a page is read WITHOUT its definition, so it is
 * also the only place the brief cannot be consulted. Pages built before the
 * description was derived from it would list themselves as a bare name, so the
 * fallback happens here: it covers the assistant's listing and the hub's search
 * at once, and it disappears on that page's next save.
 */
export const serializePageSummary = (row: Page): PageSummary => {
  const { definition, ...rest } = serializePage(row);
  return {
    ...rest,
    description:
      derivePageDescription({ current: rest.description, definition }) ??
      rest.description,
    sourceBytes: pageCodeChars(definition.code),
    datasetCount: definition.datasets.length,
  };
};
