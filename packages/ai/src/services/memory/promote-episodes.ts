import db from "@fretik/shared/db";
import { parseLlmJsonObject } from "@fretik/shared/lib/llm-json";
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { findMemoryByPath } from "@fretik/shared/services/ai-memory/lookup";
import { overwriteMemory } from "@fretik/shared/services/ai-memory/overwrite";
import { getTeamBotUserId } from "@fretik/shared/services/auth/bot-user";
import { generateText } from "ai";
import { z } from "zod";
import { telemetryFor } from "../../lib/langfuse";
import { resolveMemoryModel } from "../../lib/model-registry/team-model";
import { withNamedTrace } from "../../lib/trace-tool";

/**
 * Episode → semantic promotion (P8.5). When a record recurs across several
 * episodes, a durable, GENERALIZABLE team fact may hide in them (a process, a
 * convention, a standing preference) — worth lifting from episodic memory
 * (which demotes on disuse) into the semantic store (`ai_memories`, which
 * persists and is injected by name).
 *
 * Safety rails (autonomous writes to team-shared memory are high-stakes):
 *   - writes land ONLY under the machine namespace `learned/` — a
 *     human/agent-curated memory is never clobbered (guarded below too);
 *   - a Mem0-style gate: the model sees the existing `learned/` memories ABOUT
 *     THE SAME RECORDS (see `loadExistingLearned` — an unrelated one is an
 *     invitation to answer "already covered") and returns ADD / UPDATE / NOOP,
 *     so it dedups AND corrects its OWN prior promotions instead of piling
 *     near-duplicates. Invalidating a CURATED memory is deliberately NOT here
 *     — that stays with the real-time agent/user correction path and the
 *     (deferred) governance layer;
 *   - only truly generalizable, non-subjective facts (the `<memory_protocol>`
 *     bar), never one-off facts or opinions;
 *   - every write carries a `Sources: episode:<ids>` provenance line — the
 *     episodes stay immutable, the semantic fact is auditable (the defense
 *     against LLM-rewrite "memory rot"). Load-bearing, not decorative: the
 *     gate above reads it back to tell what a stored fact is ABOUT.
 *
 * Judgment-heavy + low-volume (nightly, capped) → the `memory-consolidate`
 * role (gpt-oss-120b), like the consolidation judge.
 */

const MAX_SUMMARY_CHARS = 1_500;
/** How many same-subject `learned/` memories reach the dedup gate's prompt. */
const MAX_EXISTING_LEARNED = 20;
/**
 * How many are READ before the subject filter cuts. Deliberately far above the
 * prompt budget: the cut that decides what the model sees is topical, so
 * recency must never be what drops a memory about this very subject.
 */
const MAX_LEARNED_SCAN = 100;
/** Off the hot path — sized for the slowest eligible model, see `extract-mentions.ts`. */
const PROMOTE_TIMEOUT_MS = 120_000;
const PROMOTE_TEMPERATURE = 0;
/** See `consolidate-episodes.ts`: sized so reasoning cannot starve the answer. */
const PROMOTE_MAX_OUTPUT_TOKENS = 12_000;
/** Machine namespace — promotions live here, never overwrite curated memories. */
const LEARNED_PREFIX = "learned/";

const promoteOutputSchema = z.object({
  promotions: z
    .array(
      z.object({
        action: z.enum(["ADD", "UPDATE", "NOOP"]),
        path: z.string(),
        content: z.string(),
      }),
    )
    .default([]),
});

const SYSTEM_PROMPT = `Decide whether a set of episodic memories (past conversations/activity about one entity) reveal a DURABLE, GENERALIZABLE team fact worth storing as a semantic memory the assistant reuses across conversations.

Promote ONLY a fact that RECURS across the episodes — the SAME process, convention, or standing preference restated in more than one. One episode stating it, or several unrelated facts that merely share the entity, is not enough.
NEVER promote: one-off facts (a single invoice/order/date/amount), opinions or subjective qualifiers, anything true of just one conversation, or a generic entity note synthesized from assorted one-offs. Unsure → NOOP.

Output strict JSON, nothing else:
{"promotions":[{"action":"ADD"|"UPDATE"|"NOOP","path":"learned/<topic>.md","content":"..."}]}

- ADD: a durable fact NOT covered by any existing learned memory. path = a new "learned/<kebab-topic>.md".
- UPDATE: refine or correct an existing learned memory — path = its exact path from <existing_learned>. Rewrite the full content.
- NOOP: nothing durable, or already covered — emit no item for it. An empty list is a valid, common answer.
- content: the rule in plain language, then a line "**When to apply:**" and a line "**What to do:**". Keep it generic — no episode-specific one-off details.
- Write in the episodes' language.`;

interface PromoteResult {
  added: number;
  updated: number;
  noop: number;
}

/** The provenance ids a promotion stamps — `Sources: episode:<uuid>, …`. */
const EPISODE_SOURCE_RE =
  /episode:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

const citedEpisodeIds = (content: string): string[] => {
  const ids = new Set<string>();
  for (const match of content.matchAll(EPISODE_SOURCE_RE)) {
    const id = match[1];
    if (id) ids.add(id.toLowerCase());
  }
  return [...ids];
};

/**
 * The scope's existing `learned/` memories ABOUT THE SAME SUBJECT — the dedup
 * gate's input, and only that.
 *
 * Not the whole namespace. The gate's prompt says "NOOP: … or already
 * covered", so every unrelated memory in the block is one more chance to
 * answer "covered" about something it does not cover. Measured 2026-09-11:
 * ONE leftover file about another company, written by another eval suite,
 * took `chain-convention-promoted` from 10/10 to 0/10 — `{"promotions":[]}`
 * every time, with no other symptom. Isolating the suites diagnosed that; it
 * does not fix it, because a real team accumulates unrelated `learned/` files
 * by living, and the corpus grows without bound.
 *
 * Subject = the records this cluster anchors on, the same edge
 * `listPromotionCandidates` grouped the candidate by. A past promotion's
 * subject is recoverable from what it wrote: resolve its cited episodes back
 * to their anchored records, keep the memories sharing one with this cluster.
 * A memory citing nothing resolvable is DROPPED — the fallback is empty,
 * never "all", since "all" is the behaviour being fixed.
 *
 * Exported for its test: this is a `WHERE` clause and a join, and the block
 * built from it is a `map().join()`.
 */
export const loadExistingLearned = async (input: {
  teamId: string;
  scope: "team" | "user";
  userId: string | null;
  anchorRecordIds: string[];
}): Promise<{ path: string; content: string }[]> => {
  // No subject, nothing to match against — and an empty `in` is not a query
  // worth finding out the behaviour of.
  if (input.anchorRecordIds.length === 0) return [];

  const rows = await db.query.aiMemories.findMany({
    where: {
      teamId: input.teamId,
      scope: input.scope,
      ...(input.scope === "user" && input.userId
        ? { userId: input.userId }
        : {}),
      path: { like: `${LEARNED_PREFIX}%` },
    },
    columns: { path: true, content: true },
    orderBy: { updatedAt: "desc" },
    limit: MAX_LEARNED_SCAN,
  });
  if (rows.length === 0) return [];

  const cited = new Map(rows.map((r) => [r.path, citedEpisodeIds(r.content)]));
  const allCited = [...new Set([...cited.values()].flat())];
  if (allCited.length === 0) return [];

  const onSubject = await db.query.aiEpisodeRecords.findMany({
    where: {
      episodeId: { in: allCited },
      recordId: { in: input.anchorRecordIds },
    },
    columns: { episodeId: true },
  });
  const onSubjectIds = new Set(onSubject.map((e) => e.episodeId));

  return rows
    .filter((r) => cited.get(r.path)?.some((id) => onSubjectIds.has(id)))
    .slice(0, MAX_EXISTING_LEARNED)
    .map((r) => ({ path: r.path, content: r.content }));
};

export const promoteEpisodes = async (input: {
  episodeIds: string[];
  teamId: string;
  organizationId: string;
  /** Force a registry profile — EVAL/BENCH ONLY. */
  modelProfileKey?: string;
}): Promise<PromoteResult> => {
  const noop: PromoteResult = { added: 0, updated: 0, noop: 0 };
  const { teamId, organizationId } = input;

  const episodes = await db.query.aiEpisodes.findMany({
    where: { id: { in: input.episodeIds }, teamId, state: "active" },
    columns: { id: true, userId: true, title: true, summary: true },
  });
  if (episodes.length < 2) return noop;

  // Scope guard: promote within ONE visibility scope. Mixed → skip.
  const scopes = new Set(episodes.map((e) => e.userId ?? "team"));
  if (scopes.size > 1) return noop;
  const episodeUserId = episodes[0]?.userId ?? null;
  const scope: "team" | "user" = episodeUserId ? "user" : "team";

  // Attribution: the team's bot user (an agent-driven write). A private-scope
  // promotion belongs to the episode's own user.
  const attributionUserId =
    scope === "user" ? episodeUserId : await getTeamBotUserId(teamId);
  if (!attributionUserId) return noop;

  // The cluster's subject, by the same edge `listPromotionCandidates` grouped
  // it on: what these episodes are ABOUT.
  const anchors = await db.query.aiEpisodeRecords.findMany({
    where: { episodeId: { in: episodes.map((e) => e.id) } },
    columns: { recordId: true },
  });
  const existing = await loadExistingLearned({
    teamId,
    scope,
    userId: episodeUserId,
    anchorRecordIds: [...new Set(anchors.map((a) => a.recordId))],
  });

  const episodeBlock = episodes
    .map(
      (e) =>
        `<episode id="${e.id}">\n${e.title}\n${e.summary.slice(0, MAX_SUMMARY_CHARS)}\n</episode>`,
    )
    .join("\n");
  const existingBlock =
    existing.length > 0
      ? `\n\n<existing_learned>\n${existing
          .map((m) => `- ${m.path}: ${m.content.slice(0, 300)}`)
          .join("\n")}\n</existing_learned>`
      : "";
  const prompt = `<episodes>\n${episodeBlock}\n</episodes>${existingBlock}`;

  const dreamDate = new Date().toISOString().slice(0, 10);
  const output = await withNamedTrace(
    "memory-consolidate",
    {
      sessionId: `memory-dreaming:${teamId}:${dreamDate}`,
      metadata: { teamId, episodeIds: input.episodeIds.join(",") },
      tags: ["process:memory-promote", `team:${teamId}`],
    },
    async () => {
      const { model } = await resolveMemoryModel(
        "memory-promote",
        teamId,
        input.modelProfileKey,
      );
      const { text: raw, finishReason } = await generateText({
        model,
        instructions: SYSTEM_PROMPT,
        prompt,
        temperature: PROMOTE_TEMPERATURE,
        maxOutputTokens: PROMOTE_MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(PROMOTE_TIMEOUT_MS),
        telemetry: telemetryFor("memory-consolidate"),
      });
      if (finishReason === "length") {
        // Reasoning ate the output budget before the answer started, so the
        // JSON below parses to nothing and this pass silently does nothing.
        // Loud on purpose — it is how a truncated consolidation looked like a
        // NOOP for a whole eval run (2026-08-04).
        console.warn(
          `[memory-promote] output truncated at ${PROMOTE_MAX_OUTPUT_TOKENS.toString()} tokens (finishReason=length)`,
        );
      }
      const parsed = promoteOutputSchema.safeParse(parseLlmJsonObject(raw));
      if (!parsed.success) {
        // The OTHER way this pass silently does nothing, and the one the
        // truncation warning above does not cover: the model answered, in
        // time, with something this schema rejects. Indistinguishable from
        // "nothing worth promoting" at the call site — it returns the same
        // all-zero result — so it has to say so here. Found 2026-09-10 by a
        // chain case that went 10/10 → 0/10 with `added=0 updated=0 noop=0`
        // and not one line of log to explain it.
        console.warn(
          `[memory-promote] team ${teamId}: output rejected by the schema — ${parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .slice(0, 3)
            .join("; ")} | raw: ${raw.slice(0, 300)}`,
        );
      }
      if (parsed.success && parsed.data.promotions.length === 0) {
        // `promotions` carries `.default([])`, so ANY JSON object parses to
        // "decided nothing" — including one that answered under a different
        // key. Deciding nothing is a legitimate outcome for this role and must
        // stay one, but it cannot be indistinguishable from a shape mismatch.
        console.warn(
          `[memory-promote] team ${teamId}: no promotion returned | raw: ${raw.slice(0, 300)}`,
        );
      }
      return parsed.success ? parsed.data : null;
    },
  );
  if (!output) return noop;

  const sources = episodes.map((e) => `episode:${e.id}`).join(", ");
  const result: PromoteResult = { added: 0, updated: 0, noop: 0 };
  const actor = { userId: attributionUserId, actor: "agent" as const };
  const scopeKey = { organizationId, teamId, userId: attributionUserId };

  for (const p of output.promotions) {
    if (p.action === "NOOP") {
      result.noop++;
      continue;
    }
    // Force the machine namespace — a promotion NEVER writes outside learned/.
    if (!p.path.startsWith(LEARNED_PREFIX) || !p.content.trim()) {
      // Third silent-noop path, and the one that hides best: the model DID
      // decide to promote, the JSON parsed, and every promotion is dropped
      // here for a path the prompt asked for and the model did not give. The
      // caller sees the same all-zero result as "nothing worth promoting".
      console.warn(
        `[memory-promote] team ${teamId}: dropped a ${p.action} outside ${LEARNED_PREFIX} — path "${p.path}"`,
      );
      continue;
    }
    const content = `${p.content.trim()}\n\nSources: ${sources}`;
    const rawPath = `/memories/${scope}/${p.path}`;
    try {
      // Always read the row — the model may mislabel ADD vs UPDATE, and the
      // block it answered from carries only same-subject memories, so a path
      // absent from it is not a path that is free. overwrite is an upsert;
      // create fails on an existing path.
      const exists = await findMemoryByPath({
        scope,
        relativePath: p.path,
        scopeKey,
      });
      if (exists) {
        // Never clobber a human-edited memory (edge: a user wrote under
        // learned/). On the row, not on the block.
        if (exists.lastModifiedByActor !== "agent") continue;
        await overwriteMemory({ rawPath, content, scopeKey, actor });
        result.updated++;
      } else {
        await createMemory({ rawPath, content, scopeKey, actor });
        result.added++;
      }
    } catch (err) {
      console.warn(
        `[memory-promote] write failed for ${rawPath}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
};
