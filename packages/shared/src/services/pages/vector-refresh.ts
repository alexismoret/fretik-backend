import { and, eq } from "drizzle-orm";
import { z } from "zod";
import db from "../../db";
import type { Page } from "../../db/schema";
import { aiVectors } from "../../db/schema";
import { callAiService } from "../../lib/ai-service";

const aiVectorizeResponseSchema = z.object({
  success: z.boolean(),
  stats: z
    .object({
      chunksProduced: z.number(),
      chunksEnriched: z.number(),
      rowsInserted: z.number(),
      rowsDropped: z.number(),
    })
    .optional(),
});

/**
 * The searchable card for a page: what it shows, who opens it, what it can do,
 * and where its numbers come from.
 *
 * Written for the query it must match. Someone asks "where do I see this
 * month's totals" without knowing a dashboard exists, so the card leads with
 * the brief's job and audience — the words a request is phrased in — rather
 * than with layout or code.
 *
 * The `Visibility:` line is load-bearing, not decoration: the AI service skips
 * the re-embed when the card text is unchanged, and turning a page private or
 * publishing it changes NOTHING else in this text. Without that line a
 * privatised page would keep its stale team-wide vector row and stay
 * discoverable by the whole team.
 *
 * The card describes the WORKING definition, not `publishedDefinition`: its
 * reader is the team's own assistant, which edits the draft.
 */
export const buildPageCard = (
  page: Page,
  collectionLabels: Map<string, string>,
): string => {
  const { definition } = page;
  const brief = definition.brief;
  const job = brief?.product.job ?? "";
  const description = page.description.trim();

  const sources = (definition.datasets ?? []).flatMap((dataset) => {
    if (dataset.kind === "collections" && dataset.collectionId) {
      return [collectionLabels.get(dataset.collectionId) ?? "records"];
    }
    if (dataset.kind === "external" && dataset.providerKey) {
      return [dataset.providerKey];
    }
    return [];
  });

  const actions = (definition.operations ?? []).map((operation) => {
    if (operation.kind === "app") {
      return `${operation.action}${operation.providerKey ? ` in ${operation.providerKey}` : ""}`;
    }
    const label = collectionLabels.get(operation.collectionId) ?? "records";
    if (operation.kind === "link") {
      return `${operation.mode} ${label} through ${operation.fieldKey}`;
    }
    if (operation.kind === "bulk") {
      return `${operation.mode} many ${label}`;
    }
    return `${operation.mode} ${label}`;
  });

  return [
    `Page: ${page.name}`,
    // Skip a description the derivation already copied from the brief — the
    // same sentence twice adds no signal to the embedding.
    ...(description && description !== job ? [description] : []),
    ...(job ? [`Job: ${job}`] : []),
    ...(brief?.product.audience ? [`For: ${brief.product.audience}`] : []),
    ...(brief?.product.features.length
      ? [
          "Can do:",
          ...brief.product.features.map(
            (feature, index) => `${(index + 1).toString()}. ${feature}`,
          ),
        ]
      : []),
    ...(sources.length
      ? [`Shows live data from: ${[...new Set(sources)].join(", ")}`]
      : []),
    ...(actions.length ? [`Actions: ${[...new Set(actions)].join(", ")}`] : []),
    `Visibility: ${page.userId ? "private to its owner" : "team-shared"} · ${
      page.publicToken ? "published at a public link" : "internal only"
    }`,
  ].join("\n");
};

/**
 * Index (or re-index) a page so the assistant can point at it from a plain
 * request. Idempotent: the AI service skips the embed round-trip when the card
 * is unchanged, and DELETEs the previous rows otherwise.
 *
 * THROWS — this is the variant the reconciliation worker calls, because a job
 * that cannot fail cannot be retried. Mutation paths want `refreshPageVectors`
 * below instead.
 */
export const refreshPageVectorsOrThrow = async (
  pageId: string,
): Promise<void> => {
  const page = await db.query.pages.findFirst({ where: { id: pageId } });
  // Not a failure: a deleted page has nothing to index, and the sweep's own
  // orphan pass owns cleaning up whatever it left behind.
  if (!page) return;

  const collectionIds = [
    ...new Set([
      ...(page.definition.datasets ?? []).flatMap((dataset) =>
        dataset.kind === "collections" && dataset.collectionId
          ? [dataset.collectionId]
          : [],
      ),
      ...(page.definition.operations ?? []).flatMap((operation) =>
        operation.kind === "app" ? [] : [operation.collectionId],
      ),
    ]),
  ];

  const collectionLabels = new Map<string, string>();
  if (collectionIds.length > 0) {
    const rows = await db.query.collections.findMany({
      where: { id: { in: collectionIds } },
      columns: { id: true, label: true, labelPlural: true },
    });
    for (const row of rows) {
      collectionLabels.set(row.id, row.labelPlural ?? row.label);
    }
  }

  const result = await callAiService(
    "/internal/vectorize",
    {
      sourceType: "pages",
      sourceId: page.id,
      content: buildPageCard(page, collectionLabels),
      metadata: {
        name: page.name,
        job: page.definition.brief?.product.job ?? "",
        published: page.publicToken !== null,
      },
      teamId: page.teamId,
      organizationId: page.organizationId,
      // A private page is only its owner's to find.
      userId: page.userId,
    },
    aiVectorizeResponseSchema,
    {
      teamId: page.teamId,
      organizationId: page.organizationId,
    },
  );

  if (!result.success) {
    throw new Error(`Vectorize returned success=false for page ${pageId}`);
  }
};

/**
 * The mutation-path variant: same work, errors logged and swallowed.
 *
 * A failed index must not roll back a save — the page row is the source of
 * truth. A miss self-heals on the next save, and the nightly reconciliation
 * sweep catches the ones nobody saves again.
 */
export const refreshPageVectors = async (pageId: string): Promise<void> => {
  try {
    await refreshPageVectorsOrThrow(pageId);
  } catch (error) {
    console.error(`[PageVectorRefresh] Failed for ${pageId}:`, error);
  }
};

/**
 * Drop a page's card on delete. Direct SQL: there is nothing to embed and the
 * round-trip would only slow the delete.
 */
export const deletePageVectorRows = async (pageId: string): Promise<void> => {
  try {
    await db
      .delete(aiVectors)
      .where(
        and(eq(aiVectors.sourceType, "pages"), eq(aiVectors.sourceId, pageId)),
      );
  } catch (error) {
    console.error(
      `[PageVectorRefresh] Failed to delete vectors for ${pageId}:`,
      error,
    );
  }
};
