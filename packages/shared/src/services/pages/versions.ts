import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import db from "../../db";
import { pageVersions, type PageVersion } from "../../db/schema/pages";
import type { PageDefinition } from "../../schemas/pages";

/**
 * The history of a page: every state it has been in, and the way back.
 *
 * Written at the SERVICE layer, never by a caller — `createPage`, `updatePage`
 * and `restorePageVersion` are the only three ways a page's definition
 * changes, so instrumenting them covers every path (the tool's `edits` are
 * resolved to a full source before they reach `updatePage`).
 *
 * Two consumers, one mechanism. The user gets "undo the thing the agent just
 * did". The review loop gets a checkpoint per round, which is what lets it
 * restore the BEST round instead of keeping the last one — cycles that
 * regress are documented behaviour, and without somewhere to put each round
 * the loop can only ever hand back whatever it happened to end on.
 */

/** Latest N states kept per page; the N+1th write evicts the oldest. */
export const PAGE_VERSION_RETENTION = 20;

/**
 * Consecutive agent writes to the same page inside this window collapse into
 * one version. A single build issues ~10 `edits` in a few minutes, and without
 * coalescing those alone would evict the entire history — including the state
 * the user actually wants back, which is the one from BEFORE the build.
 */
export const PAGE_VERSION_COALESCE_MS = 10 * 60 * 1000;

export type PageVersionOperation =
  "create" | "update" | "restore" | "review-round";

/** Why a state exists: the review round that made it, or the restore behind it. */
export interface PageVersionMeta {
  round?: number;
  score?: number;
  restoredFrom?: number;
  /**
   * What the writes that produced this version cost — mode, path, lines moved,
   * characters emitted, and the ratio between them.
   *
   * Here rather than only in telemetry because telemetry lost it: a Langfuse v4
   * `events_only` deployment strips `metadata` from the observations API, so
   * the `page-write` events of the 2026-09-04 build came back as names and
   * nothing else, and the script written to read them measured `undefined`.
   * A number kept in our own row cannot be dropped by someone else's ingestion
   * mode.
   */
  writes?: {
    mode: "write" | "edit";
    path: string;
    linesChanged: number;
    linesTotal: number;
    charsEmitted: number;
    ratio: number;
  }[];
  /**
   * The TURN this version was written in, so its cost can be looked up.
   *
   * Characters emitted say what a page cost to WRITE; they say nothing about
   * what it cost to think — and on a builder whose input is a cached prefix
   * replayed once per step, the thinking is most of the bill. Langfuse prices
   * a trace and this is the key to ask it with (`pages:measure-writes`).
   *
   * The whole turn, not the build alone: the builder's generations nest under
   * the trace that dispatched it, and a turn that built a page is a turn that
   * was about building a page.
   */
  traceId?: string;
  /**
   * What the BUILDER had spent when this version was saved, counted by the
   * process that spent it.
   *
   * `traceId` above only says who to ask. Asking turned out to be the problem:
   * on 2026-09-05 the observability pipeline was multiplying every observation
   * by 22, and a cost summed from it was 22 times the truth with nothing
   * downstream able to notice. So the number lives here too, first-hand.
   *
   * `steps` is the term that matters — a page's price is very nearly its step
   * count times a constant — and `costedSteps` below `steps` means `costUsd`
   * is a floor, because some step reported no price.
   *
   * Scoped to the page-building agent, and current as of the moment of the
   * build: the step that ran this build is not in it yet (one of roughly
   * thirty), and a later version of the same page carries the fuller figure.
   */
  usage?: {
    steps: number;
    costedSteps: number;
    costUsd: number;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
}

type TxCallback = Parameters<typeof db.transaction>[0];
export type DbExecutor = typeof db | Parameters<TxCallback>[0];

export interface PageVersionActor {
  actor: "user" | "agent";
  userId?: string | null;
  conversationId?: string | null;
}

/**
 * `compiled` is derived, ~2.5x the size of the source, and rebuilt by
 * `ensurePageCompiled` on the way back in. Keeping it would triple the table
 * to store something we would recompute anyway.
 */
const withoutCompiled = (definition: PageDefinition): PageDefinition => ({
  ...definition,
  code: {
    source: definition.code.source,
    // Every other file of the project, kept: they are SOURCE, not artifacts,
    // and a version that dropped them would restore a page reduced to its
    // entry file — compiling cleanly, and missing every component it used.
    ...(definition.code.files !== undefined
      ? { files: definition.code.files }
      : {}),
  },
});

/**
 * Does this write belong to the state already on top, or is it a new one?
 *
 * Same writer, same conversation, same kind of write, close enough in time —
 * that is one editing session, and a session is what a person means by "the
 * change the agent just made". Pure so the rule can be read and tested without
 * a database; mirrors `shouldCoalesce` in the document versions service.
 */
export const shouldCoalescePageVersion = (
  previous: Pick<
    PageVersion,
    "operation" | "byActor" | "byConversationId" | "createdAt"
  > | null,
  next: { operation: PageVersionOperation; actor: PageVersionActor },
  now: number,
): boolean => {
  if (previous === null) return false;
  // A checkpoint exists to be compared against its siblings; folding rounds
  // together destroys the comparison the review loop is for.
  if (next.operation !== "update" || previous.operation !== "update") {
    return false;
  }
  if (previous.byActor !== next.actor.actor) return false;
  if (previous.byConversationId !== (next.actor.conversationId ?? null)) {
    return false;
  }
  return now - previous.createdAt.getTime() < PAGE_VERSION_COALESCE_MS;
};

/** The most recent version of a page, whatever wrote it. */
const latestVersion = async (
  executor: DbExecutor,
  pageId: string,
): Promise<PageVersion | undefined> => {
  const [row] = await executor
    .select()
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId))
    .orderBy(desc(pageVersions.versionNumber))
    .limit(1);
  return row;
};

/**
 * Record the state a page is in AFTER an operation.
 *
 * Version N is "what the page looked like once operation N had run", so
 * restoring version N reproduces that state exactly. Numbering is computed
 * from the stored max rather than counted in JS: two writes racing on the same
 * page must not mint the same number.
 *
 * `force` skips coalescing. `review-round` always forces — the whole point of
 * a checkpoint is that it survives as its own row, and folding round 2 into
 * round 1 would destroy the comparison the loop exists to make.
 */
export const writePageVersion = async (
  executor: DbExecutor,
  args: {
    pageId: string;
    teamId: string;
    name: string;
    operation: PageVersionOperation;
    definition: PageDefinition;
    actor: PageVersionActor;
    meta?: PageVersionMeta;
    force?: boolean;
  },
): Promise<PageVersion> => {
  const definition = withoutCompiled(args.definition);
  const force = args.force ?? args.operation === "review-round";

  if (!force) {
    const previous = await latestVersion(executor, args.pageId);
    if (
      shouldCoalescePageVersion(
        previous ?? null,
        { operation: args.operation, actor: args.actor },
        Date.now(),
      ) &&
      previous
    ) {
      const [updated] = await executor
        .update(pageVersions)
        .set({ definition, name: args.name, createdAt: new Date() })
        .where(eq(pageVersions.id, previous.id))
        .returning();
      if (updated) return updated;
    }
  }

  const [inserted] = await executor
    .insert(pageVersions)
    .values({
      pageId: args.pageId,
      teamId: args.teamId,
      name: args.name,
      operation: args.operation,
      definition,
      byUserId: args.actor.userId ?? null,
      byActor: args.actor.actor,
      byConversationId: args.actor.conversationId ?? null,
      ...(args.meta ? { meta: args.meta } : {}),
      versionNumber: sql`(
        select coalesce(max(v.version_number), 0) + 1
        from ${pageVersions} v
        where v.page_id = ${args.pageId}
      )`,
    })
    .returning();

  if (!inserted) throw new Error("page version insert returned no row");
  return inserted;
};

/**
 * Drop everything past the retention window. Runs after the parent write has
 * returned — a trim failure must never fail the thing the user asked for. A
 * transient 21st row is fine; the next trim absorbs it.
 */
export const trimPageVersions = async (pageId: string): Promise<void> => {
  const keepers = await db
    .select({ id: pageVersions.id })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId))
    .orderBy(desc(pageVersions.versionNumber))
    .limit(PAGE_VERSION_RETENTION);

  if (keepers.length < PAGE_VERSION_RETENTION) return;

  await db.delete(pageVersions).where(
    and(
      eq(pageVersions.pageId, pageId),
      notInArray(
        pageVersions.id,
        keepers.map((row) => row.id),
      ),
    ),
  );
};

export interface PageVersionSummary {
  versionNumber: number;
  operation: string;
  byActor: string;
  byUserId: string | null;
  meta: PageVersionMeta | null;
  createdAt: Date;
}

/**
 * The list a history panel shows. Deliberately WITHOUT the definition: twenty
 * versions of a large page is megabytes, and a list needs none of it.
 */
export const listPageVersions = async (params: {
  pageId: string;
  teamId: string;
}): Promise<PageVersionSummary[]> => {
  const rows = await db
    .select({
      versionNumber: pageVersions.versionNumber,
      operation: pageVersions.operation,
      byActor: pageVersions.byActor,
      byUserId: pageVersions.byUserId,
      meta: pageVersions.meta,
      createdAt: pageVersions.createdAt,
    })
    .from(pageVersions)
    .where(
      and(
        eq(pageVersions.pageId, params.pageId),
        eq(pageVersions.teamId, params.teamId),
      ),
    )
    .orderBy(desc(pageVersions.versionNumber));
  return rows;
};

/** One stored state, definition included — for preview and for restore. */
export const getPageVersion = async (params: {
  pageId: string;
  teamId: string;
  versionNumber: number;
}): Promise<PageVersion | undefined> => {
  const [row] = await db
    .select()
    .from(pageVersions)
    .where(
      and(
        eq(pageVersions.pageId, params.pageId),
        eq(pageVersions.teamId, params.teamId),
        eq(pageVersions.versionNumber, params.versionNumber),
      ),
    )
    .limit(1);
  return row;
};
