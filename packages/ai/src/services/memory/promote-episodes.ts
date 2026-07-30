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
 *   - a Mem0-style gate: the model sees the team's existing `learned/`
 *     memories and returns ADD / UPDATE / NOOP, so it dedups AND corrects its
 *     OWN prior promotions instead of piling near-duplicates. Invalidating a
 *     CURATED memory is deliberately NOT here — that stays with the real-time
 *     agent/user correction path and the (deferred) governance layer;
 *   - only truly generalizable, non-subjective facts (the `<memory_protocol>`
 *     bar), never one-off facts or opinions;
 *   - every write carries a `Sources: episode:<ids>` provenance line — the
 *     episodes stay immutable, the semantic fact is auditable (the defense
 *     against LLM-rewrite "memory rot").
 *
 * Judgment-heavy + low-volume (nightly, capped) → the `memory-consolidate`
 * role (gpt-oss-120b), like the consolidation judge.
 */

const MAX_SUMMARY_CHARS = 1_500;
const MAX_EXISTING_LEARNED = 20;
const PROMOTE_TIMEOUT_MS = 45_000;
const PROMOTE_TEMPERATURE = 0;
const PROMOTE_MAX_OUTPUT_TOKENS = 4_000;
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

/** Load the scope's existing `learned/` memories for the dedup gate. */
const loadExistingLearned = async (input: {
  teamId: string;
  scope: "team" | "user";
  userId: string | null;
}): Promise<{ path: string; content: string; agentOwned: boolean }[]> => {
  const rows = await db.query.aiMemories.findMany({
    where: {
      teamId: input.teamId,
      scope: input.scope,
      ...(input.scope === "user" && input.userId
        ? { userId: input.userId }
        : {}),
      path: { like: `${LEARNED_PREFIX}%` },
    },
    columns: { path: true, content: true, lastModifiedByActor: true },
    limit: MAX_EXISTING_LEARNED,
  });
  return rows.map((r) => ({
    path: r.path,
    content: r.content,
    agentOwned: r.lastModifiedByActor === "agent",
  }));
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

  const existing = await loadExistingLearned({
    teamId,
    scope,
    userId: episodeUserId,
  });
  const existingByPath = new Map(existing.map((m) => [m.path, m]));

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
        "memory-consolidate",
        teamId,
        input.modelProfileKey,
      );
      const { text: raw } = await generateText({
        model,
        instructions: SYSTEM_PROMPT,
        prompt,
        temperature: PROMOTE_TEMPERATURE,
        maxOutputTokens: PROMOTE_MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(PROMOTE_TIMEOUT_MS),
        telemetry: telemetryFor("memory-consolidate"),
      });
      const parsed = promoteOutputSchema.safeParse(parseLlmJsonObject(raw));
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
    if (!p.path.startsWith(LEARNED_PREFIX) || !p.content.trim()) continue;
    const prior = existingByPath.get(p.path);
    // Never clobber a human-edited memory (edge: a user wrote under learned/).
    if (prior && !prior.agentOwned) continue;

    const content = `${p.content.trim()}\n\nSources: ${sources}`;
    const rawPath = `/memories/${scope}/${p.path}`;
    try {
      // Re-check existence — the model may mislabel ADD vs UPDATE. overwrite
      // is an upsert; create fails on an existing path.
      const exists =
        prior ??
        (await findMemoryByPath({
          scope,
          relativePath: p.path,
          scopeKey,
        }));
      if (exists) {
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
