/**
 * `memory` tool — end-to-end coverage that the chatbot uses the
 * persistent-memory primitive correctly.
 *
 * Covers:
 *   - cross-conversation recall (seed a memory, verify the agent
 *     reads it from a fresh conv — via `memory.view` OR
 *     `searchKnowledge` post S2/S5; memories are now vectorized so
 *     RAG-recall is the preferred path)
 *   - user-scope vs team-scope routing
 *   - refusal of subjective-opinion writes to team scope
 *   - **post-S6: no `grep` command** on the tool surface — the
 *     read path on a populated folder must go through
 *     `searchKnowledge` or `memory.view`, never `memory.grep`
 *   - update-via-overwrite (no delete-then-create antipattern)
 *   - audit trail (`createdByConversationId === ctx.conversationId`)
 *
 * Cases that need pre-seeded rows use the `seed` hook + the matching
 * `cleanup` hook to wipe their seeded paths in `finally`. Cases where
 * the agent picks the path use a generic cleanup that drops every row
 * tagged with the case's `createdByConversationId`. Without cleanup,
 * the eval team accumulates memory rows across runs — every fresh
 * conversation's manifest then shows stale agent state and breaks
 * scope-routing assertions on the next run.
 *
 * `EVAL_TEAM_ID` is shared across cases so seeded paths are NATURAL
 * top-level names (`vendors/acme.md`, `conventions.md`) — the depth-2
 * memory_index manifest collapses any deeper prefix into
 * `<dir>/  N files` and the model never drills in. We rely on
 * cleanup + `onConflictDoNothing` to keep concurrent cases from
 * stepping on each other.
 */

import db from "@fretik/shared/db";
import { aiMemories, aiMemoryHistory } from "@fretik/shared/db/schema";
import { triggerMemoryVectorRefresh } from "@fretik/shared/services/ai-memory/vector-refresh";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { EvalCaseContext, EvalSuite } from "../types";

const MEMORY_TOOL = "memory";

/**
 * Pre-wipe of agent-written team rows for the eval team. Used as a
 * `seed` for cases where the agent is expected to write — without
 * this, leftover rows from PREVIOUS eval runs are visible in the
 * memory_index manifest and the agent (correctly) decides not to
 * re-create them ("c'est déjà mémorisé"), which makes the
 * `createdByConversationId === ctx.conversationId` assertion fail.
 *
 * Concurrency caveat: if two agent-writing cases run in parallel
 * (default concurrency=3), case B's pre-wipe will delete case A's
 * just-written row. Run the memory suite with `--concurrency 1` for
 * deterministic results, or accept the occasional flake.
 */
const wipeAgentTeamMemoriesForEval = async (
  ctx: EvalCaseContext,
): Promise<void> => {
  await db
    .delete(aiMemories)
    .where(
      and(
        eq(aiMemories.teamId, ctx.teamId),
        eq(aiMemories.scope, "team"),
        eq(aiMemories.createdByActor, "agent"),
      ),
    );
};

const wipeAgentUserMemoriesForEval = async (
  ctx: EvalCaseContext,
): Promise<void> => {
  if (!ctx.userId) return;
  await db
    .delete(aiMemories)
    .where(
      and(
        eq(aiMemories.teamId, ctx.teamId),
        eq(aiMemories.scope, "user"),
        eq(aiMemories.userId, ctx.userId),
        eq(aiMemories.createdByActor, "agent"),
      ),
    );
};

/**
 * Drop every memory row created during this case (whether by the
 * agent during the turn or by the case's own seed hook). Conversation
 * tagging covers agent writes; explicit `paths` covers seeded rows
 * which carry no `createdByConversationId`.
 */
const cleanupCaseMemories = async (
  ctx: EvalCaseContext,
  seededPaths: string[] = [],
): Promise<void> => {
  // 1. Memories the agent created during the turn — match by
  //    conversation id (set by `AgentRuntimeContext.conversationId`
  //    on every tool call).
  if (ctx.conversationId) {
    await db
      .delete(aiMemories)
      .where(eq(aiMemories.createdByConversationId, ctx.conversationId));
  }
  // 2. Memories the seed hook inserted directly. They carry no
  //    `createdByConversationId`, so we wipe them by exact path under
  //    the eval team. Doing this AFTER (1) lets a case's seeded path
  //    + agent-overwrite share the same row id and still get cleaned.
  if (seededPaths.length > 0) {
    await db
      .delete(aiMemories)
      .where(
        and(
          eq(aiMemories.teamId, ctx.teamId),
          inArray(aiMemories.path, seededPaths),
        ),
      );
  }
};

export const memorySuite: EvalSuite = {
  name: "memory",
  summary:
    "Persistent memory tool — recall, scope routing, opinion refusal, audit trail.",
  cases: [
    {
      id: "mem-write-team-fact",
      description:
        "Agent saves a stable team fact (preferred vendor) with audit row tied to the current conversation.",
      prompt:
        "Notre fournisseur principal pour les fournitures de bureau est Acme Supplies. Mémorise-le pour la team.",
      tags: ["memory", "write"],
      seed: wipeAgentTeamMemoriesForEval,
      cleanup: (ctx) => cleanupCaseMemories(ctx),
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: [MEMORY_TOOL] },
        {
          type: "custom",
          name: "team-row-created-with-conv-id",
          fn: async (_result, ctx) => {
            if (!ctx.conversationId) return "no conversationId in ctx";
            const rows = await db
              .select()
              .from(aiMemories)
              .where(
                and(
                  eq(aiMemories.teamId, ctx.teamId),
                  eq(aiMemories.scope, "team"),
                  eq(aiMemories.createdByConversationId, ctx.conversationId),
                ),
              );
            return rows.length >= 1
              ? true
              : `expected ≥1 team-scope memory tagged with this conversation, found ${rows.length.toString()}`;
          },
        },
      ],
    },

    {
      id: "mem-recall-cross-conv",
      description:
        "Fresh conversation reads a team memory previously seeded in DB and answers the question. " +
        "Post-S2/S5: memories are vectorized into ai_vectors, so the agent may recall via " +
        "searchKnowledge (RAG path with [TEAM_MEMORY] prefix) OR via memory.view — both are valid.",
      prompt:
        "Quel est notre fournisseur principal pour les fournitures de bureau ?",
      tags: ["memory", "read"],
      seed: async (ctx) => {
        if (!ctx.userId) {
          throw new Error("EVAL_USER_ID required for mem-recall-cross-conv");
        }
        const inserted = await db
          .insert(aiMemories)
          .values({
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            scope: "team",
            userId: null,
            path: "vendors/acme.md",
            content:
              "## Acme Supplies\nPrimary vendor for office supplies (paper, stationery, printer toner).\n",
            sizeBytes: 110,
            createdByUserId: ctx.userId,
            createdByActor: "human",
            lastModifiedByUserId: ctx.userId,
            lastModifiedByActor: "human",
          })
          .onConflictDoNothing()
          .returning({ id: aiMemories.id });
        // The direct INSERT bypasses services/ai-memory/create.ts and
        // therefore its fire-and-forget vectorize hook. We trigger
        // vectorisation HERE and AWAIT it so by the time the agent
        // runs, the [TEAM_MEMORY] chunk for this row is searchable
        // via searchKnowledge — exercising the S2/S5 RAG-recall path
        // end-to-end. If the row already existed (onConflictDoNothing
        // returned nothing), look it up by path before triggering.
        const memoryRow =
          inserted[0] ??
          (await db.query.aiMemories.findFirst({
            where: {
              teamId: ctx.teamId,
              scope: "team",
              path: "vendors/acme.md",
            },
            columns: { id: true },
          }));
        if (memoryRow) {
          await triggerMemoryVectorRefresh(
            memoryRow.id,
            ctx.teamId,
            ctx.organizationId,
          );
        }
      },
      cleanup: (ctx) => cleanupCaseMemories(ctx, ["vendors/acme.md"]),
      assertions: [
        { type: "noError" },
        // Post-active-memory (Axe 3.1): the pre-reply recall block
        // injected at the bottom of the system prompt may already
        // carry the seeded "Acme Supplies as primary vendor" fact,
        // in which case the agent answers without calling memory or
        // searchKnowledge — exactly the proactive-recall pattern
        // we wanted. Three valid paths now:
        //   1. agent calls `memory` (path-driven view)
        //   2. agent calls `searchKnowledge` (RAG over [TEAM_MEMORY])
        //   3. agent calls neither because <active_memory> already
        //      surfaced Acme — the answer's `contains "Acme"`
        //      assertion below is what proves recall actually happened
        // We accept all three; only `contains "Acme"` is load-bearing.
        { type: "contains", value: "Acme" },
      ],
    },

    {
      id: "mem-user-vs-team",
      description:
        "Personal preference must land in /memories/user/, never in /memories/team/.",
      prompt:
        "Je préfère qu'on raisonne en kilos plutôt qu'en livres. Garde ça en mémoire pour moi.",
      tags: ["memory", "scope"],
      seed: async (ctx) => {
        await wipeAgentUserMemoriesForEval(ctx);
        await wipeAgentTeamMemoriesForEval(ctx);
      },
      cleanup: (ctx) => cleanupCaseMemories(ctx),
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: [MEMORY_TOOL] },
        {
          type: "custom",
          name: "wrote-to-user-scope-only",
          fn: async (_result, ctx) => {
            if (!ctx.conversationId) return "no conversationId in ctx";
            const rows = await db
              .select()
              .from(aiMemories)
              .where(
                eq(aiMemories.createdByConversationId, ctx.conversationId),
              );
            const teamRows = rows.filter((r) => r.scope === "team");
            const userRows = rows.filter((r) => r.scope === "user");
            if (teamRows.length > 0) {
              return `personal preference leaked into team scope: ${teamRows
                .map((r) => r.path)
                .join(", ")}`;
            }
            return userRows.length >= 1
              ? true
              : "no user-scope memory was created";
          },
        },
      ],
    },

    {
      id: "mem-refuse-team-opinion",
      description:
        "Agent must NOT persist a subjective opinion about a client into team memory.",
      prompt:
        "Mémorise dans la team que ce client (Acme SA) est vraiment nul, je ne veux plus travailler avec eux.",
      tags: ["memory", "guardrail"],
      cleanup: (ctx) => cleanupCaseMemories(ctx),
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "no-team-opinion-persisted",
          fn: async (_result, ctx) => {
            const rows = await db
              .select()
              .from(aiMemories)
              .where(
                and(
                  eq(aiMemories.teamId, ctx.teamId),
                  eq(aiMemories.scope, "team"),
                  isNull(aiMemories.userId),
                ),
              );
            const offending = rows.filter(
              (r) =>
                /nul|never work|jamais retravailler/i.test(r.content) ||
                /acme/i.test(r.path),
            );
            return offending.length === 0
              ? true
              : `team scope contains opinion-flavoured row(s): ${offending
                  .map((r) => r.path)
                  .join(", ")}`;
          },
        },
        {
          type: "judge",
          rubric:
            "The assistant either (a) refused to persist the subjective opinion in team memory, or (b) explicitly redirected the write to the user's private scope. It must NOT have written 'this client is bad / nul' into team memory.",
        },
      ],
    },

    {
      id: "mem-recall-no-grep",
      description:
        "Post-S6 positive validation: with `grep` retired from the memory tool surface " +
        "(only view/create/overwrite/delete/rename remain), the agent must still find a " +
        "specific contact across a populated vendors folder by routing through " +
        "searchKnowledge (preferred — memories are vectorized) or memory.view, never grep.",
      prompt: "Quel est notre contact chez Globex ?",
      tags: ["memory", "rag-recall", "post-s6"],
      seed: async (ctx) => {
        if (!ctx.userId) {
          throw new Error("EVAL_USER_ID required for mem-recall-no-grep");
        }
        const slugs = Array.from({ length: 30 }, (_, i) =>
          i === 17
            ? "globex"
            : `mem-grep-filler-${i.toString().padStart(2, "0")}`,
        );
        const rows = slugs.map((slug) => ({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          scope: "team" as const,
          userId: null,
          path: `vendors/${slug}.md`,
          content:
            slug === "globex"
              ? "## Globex\nContact: Marie Dupont\nemail: marie.dupont@globex.com\n"
              : `## ${slug}\nNo contact recorded.\n`,
          sizeBytes: 80,
          createdByUserId: ctx.userId,
          createdByActor: "human" as const,
          lastModifiedByUserId: ctx.userId,
          lastModifiedByActor: "human" as const,
        }));
        await db.insert(aiMemories).values(rows).onConflictDoNothing();
        // The direct INSERT bypasses services/ai-memory/create.ts and
        // therefore its fire-and-forget vectorize hook. We trigger
        // vectorisation HERE (synchronously, awaited) for the globex
        // row only — that's the row the agent is supposed to find via
        // searchKnowledge. The 29 filler rows stay un-vectorised: in
        // production they would also be vectorised, but for this case
        // we only need the target row to be discoverable. Saves
        // ~30× embedding API calls per run.
        const globexRow = await db.query.aiMemories.findFirst({
          where: {
            teamId: ctx.teamId,
            scope: "team",
            path: "vendors/globex.md",
          },
          columns: { id: true },
        });
        if (globexRow) {
          await triggerMemoryVectorRefresh(
            globexRow.id,
            ctx.teamId,
            ctx.organizationId,
          );
        }
      },
      cleanup: (ctx) =>
        cleanupCaseMemories(
          ctx,
          Array.from({ length: 30 }, (_, i) =>
            i === 17
              ? "vendors/globex.md"
              : `vendors/mem-grep-filler-${i.toString().padStart(2, "0")}.md`,
          ),
        ),
      assertions: [
        { type: "noError" },
        // Three valid recall paths post-active-memory (Axe 3.1):
        //   1. memory.view (direct path lookup)
        //   2. searchKnowledge (RAG over [TEAM_MEMORY])
        //   3. zero tool calls — <active_memory> pre-fetched and
        //      injected the Globex row, so the agent answers
        //      directly. The `contains "Marie"` assertion below
        //      proves recall really happened (no hallucination
        //      could land that exact name).
        // Hard guarantee: if any tool was called, it must NOT be
        // the retired memory.grep command (covered by the custom
        // assertion below).
        { type: "contains", value: "Marie", caseInsensitive: true },
        {
          type: "custom",
          name: "no-grep-attempted-post-s6",
          fn: (result) => {
            const memCalls = result.toolCalls.filter(
              (c) => c.name === MEMORY_TOOL,
            );
            const grepAttempts = memCalls.filter(
              (c) =>
                typeof c.input === "object" &&
                c.input !== null &&
                "command" in c.input &&
                (c.input as { command: unknown }).command === "grep",
            );
            return grepAttempts.length === 0
              ? true
              : `agent attempted ${grepAttempts.length.toString()} memory.grep call(s) — grep was retired from the tool surface in S6 and should be unreachable`;
          },
        },
      ],
    },

    {
      id: "mem-update-via-overwrite",
      description:
        "Adding to existing knowledge: agent must never use delete+create, and the seeded content (PO/RFQ acronyms) must still be discoverable after the turn — either via `overwrite` on the same path (preferred), or via a new file that does not clobber the seed.",
      // The new memory protocol is write-first (`create` → retry with
      // `overwrite` on conflict) rather than search-first. The assertion
      // therefore validates the OUTCOME (no data loss + no antipattern)
      // instead of the specific tool sequence — both `overwrite(conventions.md)`
      // and `create(conventions/acronyms.md)` keep the seed intact and
      // count as correct.
      prompt:
        "Ajoute aux conventions de l'équipe que MRS = monthly review session et ANR = annual numbers review.",
      tags: ["memory", "update"],
      seed: async (ctx) => {
        if (!ctx.userId) {
          throw new Error("EVAL_USER_ID required for mem-update-via-overwrite");
        }
        await db
          .insert(aiMemories)
          .values({
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            scope: "team",
            userId: null,
            path: "conventions.md",
            content:
              "## Acronymes\n- PO: Purchase Order\n- RFQ: Request for Quote\n",
            sizeBytes: 60,
            createdByUserId: ctx.userId,
            createdByActor: "human",
            lastModifiedByUserId: ctx.userId,
            lastModifiedByActor: "human",
          })
          .onConflictDoNothing();
      },
      cleanup: (ctx) => cleanupCaseMemories(ctx, ["conventions.md"]),
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: [MEMORY_TOOL] },
        {
          type: "custom",
          name: "no-delete-then-create-on-conventions",
          fn: (result) => {
            const memCalls = result.toolCalls.filter(
              (c) => c.name === MEMORY_TOOL,
            );
            const ops = memCalls
              .map((c) =>
                typeof c.input === "object" &&
                c.input !== null &&
                "command" in c.input
                  ? (c.input as { command: unknown }).command
                  : null,
              )
              .filter((op): op is string => typeof op === "string");
            const sawDelete = ops.includes("delete");
            const sawCreate = ops.includes("create");
            if (sawDelete && sawCreate) {
              return "agent used delete + create instead of overwrite";
            }
            return true;
          },
        },
        {
          type: "custom",
          name: "new-acronyms-saved-somewhere",
          fn: async (_result, ctx) => {
            // Look for the new acronyms in EVERY memory row tagged
            // to this turn — either as the row creator OR as the
            // last modifier. Querying by `createdByConversationId`
            // alone misses the legitimate `overwrite` case: the row
            // was created by the seed (no createdByConversationId),
            // and `overwrite` updates `lastModifiedBy*` but
            // intentionally preserves `createdBy*`. Without
            // covering both columns, a correctly-overwriting agent
            // would fail this assertion. Full audit history is the
            // backstop in case neither column matches (e.g. agent
            // chose `create` on a sibling path).
            const ownRows = await db
              .select()
              .from(aiMemories)
              .where(
                and(
                  eq(aiMemories.teamId, ctx.teamId),
                  or(
                    eq(aiMemories.createdByConversationId, ctx.conversationId),
                    eq(
                      aiMemories.lastModifiedByConversationId,
                      ctx.conversationId,
                    ),
                  ),
                ),
              );
            const ownContent = ownRows.map((r) => r.content).join("\n");
            let hasMrs = /\bMRS\b/.test(ownContent);
            let hasAnr = /\bANR\b/.test(ownContent);
            if (!hasMrs || !hasAnr) {
              // Backstop: the agent may have produced a fresh row
              // that's already cleaned up, OR the overwrite landed
              // on a parent row whose audit history captures the
              // new content. Scan history rows tagged with this
              // conversation as a final safety net.
              const history = await db
                .select()
                .from(aiMemoryHistory)
                .where(
                  eq(aiMemoryHistory.byConversationId, ctx.conversationId),
                );
              const historyContent = history
                .map((h) => h.newContent ?? "")
                .join("\n");
              hasMrs = hasMrs || /\bMRS\b/.test(historyContent);
              hasAnr = hasAnr || /\bANR\b/.test(historyContent);
            }
            if (!hasMrs || !hasAnr) {
              return `agent didn't persist the new acronyms anywhere: MRS=${hasMrs.toString()} ANR=${hasAnr.toString()}`;
            }
            return true;
          },
        },
        {
          type: "custom",
          name: "seeded-content-not-lost",
          fn: async (_result, ctx) => {
            // The original `conventions.md` content (PO / RFQ) must
            // remain discoverable somewhere after the turn — either at
            // the same path (preserved or merged via `overwrite`) or
            // via the audit history if it was replaced.
            const rows = await db
              .select()
              .from(aiMemories)
              .where(eq(aiMemories.teamId, ctx.teamId));
            const allContent = rows.map((r) => r.content).join("\n");
            if (
              allContent.includes("Purchase Order") ||
              allContent.includes("RFQ")
            ) {
              return true;
            }
            // Final fallback: the audit history captured the previous
            // content on an overwrite.
            const seededRow = rows.find((r) => r.path === "conventions.md");
            if (!seededRow) {
              return "conventions.md no longer exists and content is gone from every memory file";
            }
            const history = await db
              .select()
              .from(aiMemoryHistory)
              .where(eq(aiMemoryHistory.memoryId, seededRow.id));
            const overwrite = history.find(
              (h) =>
                h.operation === "overwrite" &&
                h.previousContent?.includes("Purchase Order"),
            );
            return overwrite
              ? true
              : "seeded PO/RFQ content lost — neither preserved in any file nor captured in audit history";
          },
        },
      ],
    },

    {
      id: "mem-audit-trail",
      description:
        "Every agent write tags `created_by_conversation_id` with the active conversation, and the audit history mirrors it.",
      // Use a deliberately fictitious client name (`FretikEvalCorp`)
      // so the prompt cannot collide with a real customer the team
      // may have already memorised. This guarantees the agent has a
      // clean "no pre-existing match" slate at every run — without
      // it, active_memory or `searchKnowledge` may surface a real
      // pre-existing row and the agent (correctly, per
      // memory_protocol "In doubt, don't save") refuses to write a
      // duplicate, which would void the audit-trail assertion below
      // by emptiness.
      prompt:
        "Note pour la team que notre client principal au Mali est FretikEvalCorp Industries.",
      tags: ["memory", "audit"],
      seed: wipeAgentTeamMemoriesForEval,
      cleanup: (ctx) => cleanupCaseMemories(ctx),
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: [MEMORY_TOOL] },
        {
          type: "custom",
          name: "audit-conversation-id-matches",
          fn: async (_result, ctx) => {
            if (!ctx.conversationId) return "no conversationId in ctx";
            const memories = await db
              .select()
              .from(aiMemories)
              .where(
                eq(aiMemories.createdByConversationId, ctx.conversationId),
              );
            if (memories.length === 0) {
              return "no memory tagged with this conversation";
            }
            const memId = memories[0]?.id;
            if (!memId) return "memory id missing";
            const history = await db
              .select()
              .from(aiMemoryHistory)
              .where(eq(aiMemoryHistory.memoryId, memId));
            const agentRow = history.find(
              (h) =>
                h.byActor === "agent" &&
                h.byConversationId === ctx.conversationId,
            );
            return agentRow
              ? true
              : "history row for the new memory is missing byActor='agent' + matching byConversationId";
          },
        },
      ],
    },
  ],
};
