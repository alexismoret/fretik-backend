import db from "@fretik/shared/db";
import type { PageVectorMetadata } from "@fretik/shared/db/schema";
import { aiVectors, collections, pages } from "@fretik/shared/db/schema";
import { buildPageCard } from "@fretik/shared/services/pages/vector-refresh";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { vectorizeSource, type VectorizeSourceResult } from "./index";

/**
 * Page-card vectoriser — what a page shows, who opens it and what it can do,
 * as one embedded card.
 *
 * The point is discovery from natural language: someone asks "where do I see
 * this month's margins" without knowing a dashboard for it exists.
 * `searchKnowledge` surfaces the card, and the assistant opens the page the
 * team already has instead of building a second one.
 *
 * Identity is the page id (`source_id`). Idempotence rides on
 * `metadata.content_hash`: the builder's review rounds re-save the same page
 * several times, and an edit that only touches code leaves the card identical,
 * so the embed round-trip is skipped. Single chunk, enrichment skipped — same
 * shape as record and workflow cards.
 */

/** Hex SHA-256 — see `skills.ts` for why the algorithm is named, not `Bun.hash`. */
const sha256Hex = (input: string): string =>
  new Bun.CryptoHasher("sha256").update(input).digest("hex");

export interface VectorizePageInput {
  pageId: string;
  teamId: string;
  organizationId: string;
  /** Owner of a private page; null for a team-shared one. */
  userId: string | null;
  name: string;
  /** `brief.product.job` — empty for a page written before briefs existed. */
  job: string;
  published: boolean;
  /** The card body: job, audience, features, data sources, visibility. */
  content: string;
}

export interface VectorizePageResult extends VectorizeSourceResult {
  /** True when the card was unchanged and the embed round-trip was skipped. */
  skipped: boolean;
}

const SKIPPED: VectorizePageResult = {
  skipped: true,
  chunksProduced: 0,
  chunksEnriched: 0,
  rowsInserted: 0,
  rowsDropped: 0,
  metadataOnly: false,
};

export const vectorizePage = async (
  input: VectorizePageInput,
): Promise<VectorizePageResult> => {
  const contentHash = sha256Hex(input.content);

  const existing = await db
    .select({ metadata: aiVectors.metadata })
    .from(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "pages"),
        eq(aiVectors.sourceId, input.pageId),
      ),
    )
    .limit(1);

  const previous = existing[0]?.metadata;
  if (
    previous &&
    "content_hash" in previous &&
    previous.content_hash === contentHash
  ) {
    // Stamp the row even though nothing is re-embedded: `updated_at` is what
    // the reconciliation sweep compares against the page's own, so it has to
    // mean "last VERIFIED fresh", not "last rewritten". Without this, a page
    // whose edit only touched code reads as permanently stale and gets
    // re-attempted every night, forever.
    await db
      .update(aiVectors)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(aiVectors.sourceType, "pages"),
          eq(aiVectors.sourceId, input.pageId),
        ),
      );
    return SKIPPED;
  }

  const metadata: PageVectorMetadata = {
    name: input.name,
    job: input.job,
    published: input.published,
    content_hash: contentHash,
    version_indexed_at: new Date().toISOString(),
  };

  const result = await vectorizeSource({
    sourceType: "pages",
    sourceId: input.pageId,
    content: input.content,
    metadata,
    teamId: input.teamId,
    organizationId: input.organizationId,
    userId: input.userId,
  });

  return { ...result, skipped: false };
};

/**
 * Index every page that has no card yet.
 *
 * Without this, discovery would only cover pages saved AFTER the feature
 * shipped: an existing dashboard stays invisible until somebody happens to
 * edit it. Self-limiting — it selects only pages with no row in `ai_vectors`,
 * so the second boot finds nothing and does no work.
 *
 * Fire-and-forget at boot, like the workflow and bundled-skills indexers.
 */
export const backfillPageVectors = async (): Promise<{ indexed: number }> => {
  // `source_id` is uuid and so is `pages.id` — compared directly. Casting the
  // right side to text makes Postgres refuse the whole query with "no operator
  // matches uuid = text", which is what silently broke the workflow backfill.
  const alreadyIndexed = db
    .select({ one: sql`1` })
    .from(aiVectors)
    .where(
      and(eq(aiVectors.sourceType, "pages"), eq(aiVectors.sourceId, pages.id)),
    );

  const rows = await db.select().from(pages).where(notExists(alreadyIndexed));

  // One lookup for the whole backfill: the cards name the collections they
  // read, and a per-page query would be N round-trips for a shared answer.
  const collectionIds = [
    ...new Set(
      rows.flatMap((page) => [
        ...(page.definition.datasets ?? []).flatMap((dataset) =>
          dataset.kind === "collections" && dataset.collectionId
            ? [dataset.collectionId]
            : [],
        ),
        ...(page.definition.operations ?? []).flatMap((operation) =>
          operation.kind === "app" ? [] : [operation.collectionId],
        ),
      ]),
    ),
  ];
  const collectionLabels = new Map<string, string>();
  if (collectionIds.length > 0) {
    const labelRows = await db
      .select({
        id: collections.id,
        label: collections.label,
        labelPlural: collections.labelPlural,
      })
      .from(collections)
      .where(inArray(collections.id, collectionIds));
    for (const row of labelRows) {
      collectionLabels.set(row.id, row.labelPlural ?? row.label);
    }
  }

  let indexed = 0;
  for (const page of rows) {
    try {
      await vectorizePage({
        pageId: page.id,
        teamId: page.teamId,
        organizationId: page.organizationId,
        userId: page.userId,
        name: page.name,
        job: page.definition.brief?.product.job ?? "",
        published: page.publicToken !== null,
        content: buildPageCard(page, collectionLabels),
      });
      indexed += 1;
    } catch (error) {
      // One bad page must not stop the backfill — it retries next boot.
      console.warn(
        `[vectorize.pages] backfill failed for ${page.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { indexed };
};

/**
 * Drop a page's card. Direct SQL — the embed pipeline has nothing to do when a
 * page is deleted; it must simply stop being discoverable.
 */
export const deletePageVectors = async (pageId: string): Promise<number> => {
  const deleted = await db
    .delete(aiVectors)
    .where(
      and(eq(aiVectors.sourceType, "pages"), eq(aiVectors.sourceId, pageId)),
    )
    .returning({ id: aiVectors.id });
  return deleted.length;
};
