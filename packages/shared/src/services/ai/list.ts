import {
  and,
  count,
  eq,
  ilike,
  inArray,
  isNull,
  sql,
  type SQL,
} from "drizzle-orm";
import db from "../../db";
import { aiConversationMembers, aiConversations } from "../../db/schema";
import { idCursor } from "../../lib/cursor";
import type { AiAgentType } from "../../schemas/ai";
import type { ParamsList } from "../../schemas/common/params";
import {
  conversationWith,
  serializeConversation,
  type SerializedConversation,
} from "./conversation-serializer";

/**
 * A pin list is a shortlist, not a page. Past this many the user has stopped
 * using pins as shortcuts, and paginating them would only hide the problem.
 * It is a CEILING over the caller's `limit`, never a replacement for it — a
 * route that documents `limit` and then ignores it is a silent divergence.
 */
const PINNED_MAX = 50;

/**
 * Where a list reads: the team the caller has open — or, with no team open (a
 * guest, a member not in a team yet), the projects they take part in,
 * whichever team holds them. A chat of a project is theirs to take part in
 * while they take part in the project, which is also when a guest may open it
 * (`authz/rules.ts`).
 */
export type ConversationScope =
  | { readonly teamId: string }
  | {
      readonly organizationId: string;
      readonly projectIds: readonly string[];
    };

/** The scope as a relational `where` fragment on `ai_conversations`. */
const whereScope = (scope: ConversationScope) =>
  "teamId" in scope
    ? { teamId: scope.teamId }
    : {
        organizationId: scope.organizationId,
        projectId: { in: [...scope.projectIds] },
      };

/** The scope as a SQL condition on `ai_conversations`. */
const scopeCondition = (scope: ConversationScope): SQL =>
  "teamId" in scope
    ? eq(aiConversations.teamId, scope.teamId)
    : sql`${eq(aiConversations.organizationId, scope.organizationId)} and ${inArray(aiConversations.projectId, [...scope.projectIds])}`;

/**
 * List the conversations the current user participates in for a given agent
 * type. Each row is serialised with its full member roster and the user's own
 * per-conversation state (pinned, unread, email opt-in, …).
 *
 * THREE reading modes, because one list is rendered two very different ways:
 *
 *  - `pinned: true` — the caller's pinned shortlist, newest pin first. Read
 *    FROM `ai_conversation_members` rather than through the conversation: that
 *    is the only shape an index on `(user_id, pinned_at)` can serve, and it is
 *    what lets the two modes below drop the pin term from their ORDER BY
 *    entirely.
 *  - `paginate: "cursor"` (with `pinned: false`) — the unpinned stream, walked
 *    forward by key. No exact total: a lane that only ever scrolls was paying
 *    a full `COUNT(*)` per page to answer what `limit + 1` answers for free.
 *  - default — the historical path: pinned-first, offset, exact count. Kept
 *    byte-for-byte for numbered-page callers (`@fretik/ai`'s suggestion
 *    sources), whose ordering must not change under them.
 *
 * Measured on 100 000 conversations, a member seated on 4 770 of them, reading
 * page 80 of their own list:
 *
 *   default (offset + correlated pin subquery)   57.3 ms   25 562 buffers
 *   + the exact count every page also paid        3.5 ms      147 buffers
 *   walk (`pinned: false`, `paginate: "cursor"`)  1.9 ms      163 buffers
 *
 * The 25 562 are not the sort: the pin subquery in the ORDER BY is evaluated
 * once per candidate row, 4 770 times, and that alone is 23 848 of them. Moving
 * the pins into their own query is what deletes it — which is the answer to
 * "does the list still need to sort by pin?": the block that scrolls does not.
 * The walk's cost is also FLAT in depth (page 2 and page 80 both read ~30 index
 * entries), where the offset path grows with every page the reader passes.
 */
export const listConversations = async (data: {
  scope: ConversationScope;
  userId: string;
  agentType: AiAgentType;
  params: ParamsList;
  /** `true` = only the caller's pins, `false` = only the rest. Omitted = both,
   *  pinned first (the historical ordering). */
  pinned?: boolean;
  /** `"cursor"` walks forward and skips the count. Falls back to `"page"`
   *  whenever the list still has to carry the pin ordering. */
  paginate?: "page" | "cursor";
  /** Opaque cursor from a previous `nextCursor`. Absent on the first page of a
   *  walk; one that no longer resolves restarts from the first page. */
  cursor?: string;
}): Promise<{
  /** NOT computed on the walk, where it comes back as 0 — a caller that asked
   *  for `paginate: "cursor"` asked for exactly that. Read `nextCursor`. */
  count: number;
  data: SerializedConversation[];
  /** Present only on the walk; null once the last row has been served. */
  nextCursor?: string | null;
}> => {
  const { scope, userId, agentType, params, pinned } = data;

  // No team open and no project taken part in: nothing of theirs to list.
  if ("projectIds" in scope && scope.projectIds.length === 0) {
    return {
      count: 0,
      data: [],
      ...(data.paginate === "cursor" ? { nextCursor: null } : {}),
    };
  }

  if (pinned === true) {
    return await listPinnedConversations({ scope, userId, agentType, params });
  }

  // The walk's ORDER BY carries no pin term, so it is only a faithful walk of
  // a list that has none either. Anything else silently keeps the offset path
  // rather than skipping rows — same contract as `listCollectionRecords`.
  if (data.paginate === "cursor" && pinned === false) {
    return await walkConversations({
      scope,
      userId,
      agentType,
      params,
      cursor: data.cursor,
    });
  }

  return await pageConversations({
    scope,
    userId,
    agentType,
    params,
    pinned,
  });
};

/**
 * The caller's pinned shortlist, newest pin first.
 *
 * Two statements on purpose. Driving from `ai_conversation_members` is what
 * makes `(user_id, pinned_at) WHERE pinned_at IS NOT NULL` usable — a
 * membership filter placed on `ai_conversations` compiles to an `EXISTS`
 * subquery keyed on `(conversation_id, user_id)` instead, which cannot be read
 * in pin order. Hydrating the conversations in a second pass then keeps
 * `conversationWith` + `serializeConversation` the single source of a
 * conversation's wire shape, which one hand-written join would fork.
 *
 * `count` is the size of what came back, not a total: this block is capped at
 * `PINNED_MAX` and has no second page for a total to be about.
 */
const listPinnedConversations = async (data: {
  scope: ConversationScope;
  userId: string;
  agentType: AiAgentType;
  params: ParamsList;
}): Promise<{ count: number; data: SerializedConversation[] }> => {
  const { scope, userId, agentType, params } = data;
  const { limit, search } = params;

  const pins = await db.query.aiConversationMembers.findMany({
    columns: { conversationId: true },
    where: {
      userId,
      // NOT `pinnedAt: { isNull: false }` — the relational builder drops a
      // falsy `isNull`, which would silently return every membership row.
      pinnedAt: { isNotNull: true },
      conversation: {
        ...whereScope(scope),
        agentType,
        ...(search ? { title: { ilike: `%${search}%` } } : {}),
      },
    },
    orderBy: { pinnedAt: "desc" },
    limit: Math.min(limit, PINNED_MAX),
  });

  if (pins.length === 0) return { count: 0, data: [] };

  const ids = pins.map((pin) => pin.conversationId);
  const rows = await db.query.aiConversations.findMany({
    where: { id: { in: ids } },
    with: conversationWith,
  });

  // `IN` returns no order at all, so re-impose the pin order the first query
  // established rather than trusting the physical one.
  const byId = new Map(rows.map((row) => [row.id, row]));
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((row): row is NonNullable<typeof row> => row !== undefined);

  return {
    count: ordered.length,
    data: ordered.map((row) => serializeConversation(row, userId)),
  };
};

/**
 * The unpinned stream, walked forward by `(updated_at, id)`.
 *
 * Why this is CORRECT and not just cheaper: `updated_at` only ever increases,
 * so under `ORDER BY updated_at DESC` a conversation bumped mid-walk moves
 * ABOVE the cursor — out of the region still to be read. The walk therefore
 * cannot serve it twice, and the only row it can miss is one that has just
 * become the top of the list, which the next refetch of the first page puts
 * back in front of the reader. Offset paging has neither property: every bump
 * shifts a row across a page boundary, duplicating one and hiding another.
 *
 * The cursor is the last row's id and nothing else — but the seek needs that
 * row's TIMESTAMP too, and how it gets there is the delicate part. It is read
 * back as TEXT (`anchorUpdatedAt` below) and handed straight to
 * `::timestamp`: Postgres renders this type to the microsecond and parses its
 * own rendering exactly, so the value round-trips whole. What it must never
 * become on the way is a JavaScript `Date`, which holds milliseconds — the
 * column is written from both sides (`defaultNow()` on insert, `$onUpdateFn`
 * on update), so a truncated bound would exclude rows the walk had never
 * served. That is the incident recorded in `lib/cursor`.
 *
 * Measured (100k conversations, page ~80): as a literal the bound becomes an
 * Index Cond and the walk reads 30 index entries — 0.09 ms, 163 buffers,
 * flat at any depth. Resolved instead by a sub-select inside the statement it
 * is only a Filter, because the planner cannot push an InitPlan into an index
 * condition: same rows, but 2 097 discarded first, 920 buffers, and a cost
 * that grows with how far the reader has scrolled. One extra round-trip buys
 * the seek back.
 */
const walkConversations = async (data: {
  scope: ConversationScope;
  userId: string;
  agentType: AiAgentType;
  params: ParamsList;
  cursor?: string;
}): Promise<{
  count: number;
  data: SerializedConversation[];
  nextCursor: string | null;
}> => {
  const { scope, userId, agentType, params } = data;
  const { limit, search } = params;
  const from = idCursor(data.cursor);
  const anchor = from ? await anchorUpdatedAt(from) : null;

  const rows = await db.query.aiConversations.findMany({
    where: {
      ...whereScope(scope),
      agentType,
      members: { userId, pinnedAt: { isNull: true } },
      ...(search ? { title: { ilike: `%${search}%` } } : {}),
      // No anchor means no seek, which restarts the walk — the contract for a
      // cursor whose conversation was deleted between two pages. Ending the
      // walk silently would be the other, worse, reading of the same input.
      ...(from && anchor
        ? {
            RAW: (table, { sql }) =>
              sql`(${table.updatedAt}, ${table.id}) < (${anchor}::timestamp, ${from})`,
          }
        : {}),
    },
    with: conversationWith,
    orderBy: (conversation, { desc }) => [
      desc(conversation.updatedAt),
      // Written out even though `ai_conversations_team_agent_updated_idx`
      // currently supplies it for free (deleting this line reddens nothing).
      // It is the ORDER BY half of the seek above, and a seek whose ORDER BY
      // does not match it skips rows — so the guarantee has to live in the
      // query rather than in whichever plan the planner happens to pick.
      desc(conversation.id),
    ],
    // One more than asked, purely to learn whether there is a next page.
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return {
    count: 0,
    data: items.map((row) => serializeConversation(row, userId)),
    nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
  };
};

/**
 * The cursor row's `updated_at`, rendered by Postgres as text.
 *
 * `::text` rather than the column, and a raw statement rather than the
 * relational builder, for one reason: the driver would hand back a JavaScript
 * `Date` and silently drop the microseconds. Postgres' own rendering of a
 * `timestamp` carries all six fractional digits and `::timestamp` parses it
 * back exactly, so the value survives the trip out and in.
 *
 * `null` when the row is gone — the caller reads that as "restart the walk".
 */
const anchorUpdatedAt = async (
  conversationId: string,
): Promise<string | null> => {
  const result = await db.execute<{ updatedAt: string }>(
    sql`SELECT ${aiConversations.updatedAt}::text AS "updatedAt"
        FROM ${aiConversations}
        WHERE ${aiConversations.id} = ${conversationId}`,
  );
  return result.rows[0]?.updatedAt ?? null;
};

/**
 * The historical path: the caller's pinned conversations first, then
 * most-recently-active, by offset, with an exact total.
 *
 * The pin ordering is done HERE rather than in the client: the list is
 * paginated, so a client-side sort would only float the pins that happen to be
 * on the page it already holds.
 */
const pageConversations = async (data: {
  scope: ConversationScope;
  userId: string;
  agentType: AiAgentType;
  params: ParamsList;
  /** `false` narrows to the unpinned block; omitted keeps both. NOT `boolean`:
   *  `true` is intercepted above, and this path has no filter for it — typed
   *  wider, it would silently return the whole list instead. */
  pinned?: false;
}): Promise<{ count: number; data: SerializedConversation[] }> => {
  const { scope, userId, agentType, params, pinned } = data;
  const { limit, page, search } = params;

  const [rows, totalRows] = await Promise.all([
    db.query.aiConversations.findMany({
      where: {
        ...whereScope(scope),
        agentType,
        members: {
          userId,
          ...(pinned === false ? { pinnedAt: { isNull: true } } : {}),
        },
        ...(search ? { title: { ilike: `%${search}%` } } : {}),
      },
      with: conversationWith,
      // A correlated subquery rather than an ordering on the joined member
      // row: `members` is a to-many relation here (a conversation has several
      // participants), so ordering on it would need the CALLER's row picked
      // out of the collection, which the relational builder cannot express.
      // NULLS LAST is load-bearing — Postgres sorts NULLs FIRST under DESC,
      // which would put every unpinned conversation above the pinned ones.
      orderBy: (conversation, { sql, desc }) => [
        sql`(SELECT m.pinned_at
             FROM ai_conversation_members m
             WHERE m.conversation_id = ${conversation.id}
               AND m.user_id = ${userId}) DESC NULLS LAST`,
        desc(conversation.updatedAt),
      ],
      limit,
      offset: page * limit,
    }),
    countUserConversations({ scope, userId, agentType, search, pinned }),
  ]);

  return {
    count: totalRows,
    data: rows.map((row) => serializeConversation(row, userId)),
  };
};

/**
 * Exact count of the user's conversations via the membership join — the
 * relational query above can't return a total alongside a paginated page.
 */
const countUserConversations = async (data: {
  scope: ConversationScope;
  userId: string;
  agentType: AiAgentType;
  search?: string;
  /** Mirrors `pageConversations`' own narrowing — see the note there. */
  pinned?: false;
}): Promise<number> => {
  const { scope, userId, agentType, search, pinned } = data;

  const conditions: SQL[] = [
    scopeCondition(scope),
    eq(aiConversations.agentType, agentType),
    eq(aiConversationMembers.userId, userId),
  ];
  if (search) conditions.push(ilike(aiConversations.title, `%${search}%`));
  // Must mirror the page's own filter, or "showing X of Y" counts rows the
  // list will never show.
  if (pinned === false) conditions.push(isNull(aiConversationMembers.pinnedAt));

  const [row] = await db
    .select({ count: count() })
    .from(aiConversations)
    .innerJoin(
      aiConversationMembers,
      eq(aiConversationMembers.conversationId, aiConversations.id),
    )
    .where(and(...conditions));

  return row?.count ?? 0;
};
