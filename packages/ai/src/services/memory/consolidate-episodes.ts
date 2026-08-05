import db from "@fretik/shared/db";
import type { EpisodeVectorMetadata } from "@fretik/shared/db/schema";
import { parseLlmJsonObject } from "@fretik/shared/lib/llm-json";
import {
  emitDomainEvent,
  SYSTEM_ACTOR,
} from "@fretik/shared/services/domain-events/emit";
import {
  supersedeEpisodes,
  upsertEpisode,
} from "@fretik/shared/services/episodes/upsert";
import { deleteEpisodeVectors } from "@fretik/shared/services/episodes/vectors";
import { generateText } from "ai";
import { z } from "zod";
import { telemetryFor } from "../../lib/langfuse";
import { resolveMemoryModel } from "../../lib/model-registry/team-model";
import { withNamedTrace } from "../../lib/trace-tool";
import { vectorizeSource } from "../vectorize";

/**
 * Consolidation judge (P6 dreaming). One utility-tier LLM call decides what
 * to do with a cluster of active episodes that anchor overlapping records:
 * MERGE (one story told twice), REVISE (an episode contradicted or obsoleted
 * by its siblings or by recent record events — the v1 contradiction pass),
 * or NOOP. Non-destructive Zep-style invalidation: superseded members keep
 * their rows (`supersededById` → survivor), only their vectors drop; the
 * survivor is a fresh `consolidated` episode, vectorized in-process.
 *
 * Every guard degrades to NOOP (bad parse, dissolved cluster, invalid ids)
 * — a skipped night is recoverable, a wrong merge is not.
 */

const MAX_RECENT_EVENTS = 20;
const MAX_PAYLOAD_CHARS = 150;
/** Off the hot path — sized for the slowest eligible model, see `extract-mentions.ts`. */
const CONSOLIDATE_TIMEOUT_MS = 120_000;
const CONSOLIDATE_TEMPERATURE = 0;
/** Merged summary ~1500 chars + low-effort reasoning — distill envelope. */
/**
 * Sized so REASONING cannot starve the answer, not so the answer fits.
 *
 * Reasoning tokens count against this cap, and the upstream does not reliably
 * honour the reasoning budget we ask for: measured 2026-08-04 on
 * deepseek-v4-flash with `reasoning.max_tokens: 256`, one consolidation call
 * produced 3 380 reasoning tokens, hit `completion = 3 000` exactly, and
 * returned `finish_reason: length` — a truncated JSON that parses to nothing,
 * so the judge silently NOOPs and the contradiction it was asked to resolve
 * survives. Same trap `JUDGE_MAX_OUTPUT_TOKENS` documents in
 * `services/recall/recall.ts`, which the memory services never inherited.
 *
 * Output tokens are billed only when generated, so a ceiling this high costs
 * nothing until something goes wrong — and when it does, it fails loudly
 * (`finishReason === "length"` is logged) instead of as an empty result.
 */
const CONSOLIDATE_MAX_OUTPUT_TOKENS = 12_000;

const judgeOutputSchema = z.object({
  action: z.enum(["MERGE", "REVISE", "NOOP"]),
  title: z.string().optional(),
  summary: z.string().optional(),
  supersededIds: z.array(z.string()).default([]),
});

const SYSTEM_PROMPT = `Judge whether a cluster of episodic memories should be consolidated. The episodes anchor overlapping records; recent activity on those records is provided as evidence.

Output strict JSON, nothing else:
{"action":"MERGE"|"REVISE"|"NOOP","title":"...","summary":"...","supersededIds":["..."]}

- MERGE: the episodes tell ONE story (the same matter across conversations, redundant retellings). Write the unified episode — title ≤100 chars; summary markdown ~1500 chars keeping every durable fact, decision, and open point from the members: merging must lose nothing. supersededIds = every episode folded in.
- REVISE: one or more episodes state something the other episodes or the recent activity contradict or made obsolete — including a future-dated plan whose date is now past relative to <today>. Write the corrected episode (same shape as MERGE), and state the current value or outcome the newest evidence establishes — never merely drop the stale claim; dropping without replacement is only for claims nothing newer supersedes. supersededIds = only the outdated episodes. If the corrected episode ends up absorbing every member's durable content, that is a MERGE — supersede them all.
- NOOP: distinct matters that merely share a record — keep them separate. Omit title/summary/supersededIds.
- supersededIds: copy the episode id tags exactly as printed (e.g. "E2") — nothing else inside the strings.
- Never invent facts absent from the inputs. Unsure → NOOP.
- NEVER carry secrets (passwords, API keys, tokens) or unrelated personal data into the written episode.
- Write title and summary in the episodes' language.`;

const parseJudgeOutput = (
  raw: string,
): z.infer<typeof judgeOutputSchema> | null => {
  const parsed = judgeOutputSchema.safeParse(parseLlmJsonObject(raw));
  return parsed.success ? parsed.data : null;
};

export interface ConsolidateEpisodesResult {
  action: "MERGE" | "REVISE" | "NOOP";
  episodeId?: string;
  supersededIds?: string[];
}

const NOOP: ConsolidateEpisodesResult = { action: "NOOP" };

export const consolidateEpisodes = async (input: {
  episodeIds: string[];
  teamId: string;
  organizationId: string;
  /** Force a registry profile — EVAL/BENCH ONLY (model bake-off). */
  modelProfileKey?: string;
}): Promise<ConsolidateEpisodesResult> => {
  const { teamId, organizationId } = input;

  const episodes = await db.query.aiEpisodes.findMany({
    where: { id: { in: input.episodeIds }, teamId, state: "active" },
    with: { episodeRecords: { columns: { recordId: true } } },
  });
  if (episodes.length < 2) return NOOP;

  // Defensive scope guard — the cron clusters per visibility scope already,
  // but a mixed cluster must never produce a leaking merge.
  const scopes = new Set(episodes.map((e) => e.userId ?? "team"));
  if (scopes.size > 1) {
    console.warn(
      `[memory-consolidate] mixed-scope cluster for team ${teamId} — NOOP`,
    );
    return NOOP;
  }

  const recordIds = [
    ...new Set(
      episodes.flatMap((e) => e.episodeRecords.map((r) => r.recordId)),
    ),
  ];
  const records =
    recordIds.length > 0
      ? await db.query.objectRecords.findMany({
          where: { id: { in: recordIds }, teamId },
          columns: { id: true, label: true },
        })
      : [];
  const labelOf = new Map(records.map((r) => [r.id, r.label]));

  // Contradiction evidence: what happened on the cluster's records since the
  // oldest member was last written.
  const oldestUpdate = episodes.reduce(
    (min, e) => (e.updatedAt < min ? e.updatedAt : min),
    episodes[0]?.updatedAt ?? new Date(),
  );
  const recentEvents =
    recordIds.length > 0
      ? await db.query.domainEvents.findMany({
          where: {
            teamId,
            subjectRecordId: { in: recordIds },
            recordedAt: { gt: oldestUpdate },
          },
          orderBy: { recordedAt: "desc" },
          limit: MAX_RECENT_EVENTS,
        })
      : [];
  recentEvents.reverse();

  // Short id tags (E1, E2, …) instead of raw uuids — the judge must COPY ids
  // into supersededIds, and uuid transcription is a measured failure class:
  // 4 of the 5 consolidate failures across r19 + the N=30 baselines
  // (2026-08-05) were `degraded` coercions of a correct action. Same cure as
  // the recall judge's provenance handles: the model only ever sees tags, and
  // expansion back to uuids happens in code below.
  const idByTag = new Map(
    episodes.map((e, i) => [`E${(i + 1).toString()}`, e.id]),
  );
  const episodeBlocks = episodes.map((e, i) => {
    const window = [
      e.occurredFrom?.toISOString().slice(0, 10),
      e.occurredTo?.toISOString().slice(0, 10),
    ]
      .filter(Boolean)
      .join(" → ");
    const anchors = e.episodeRecords
      .map((r) => labelOf.get(r.recordId))
      .filter(Boolean)
      .join(", ");
    return `<episode id="E${(i + 1).toString()}" kind="${e.kind}"${window ? ` occurred="${window}"` : ""}${anchors ? ` records="${anchors}"` : ""}>\n${e.title}\n${e.summary}\n</episode>`;
  });
  const eventLines = recentEvents.map((e) => {
    const payload =
      Object.keys(e.payload).length > 0
        ? ` — ${JSON.stringify(e.payload).slice(0, MAX_PAYLOAD_CHARS)}`
        : "";
    return `- ${e.recordedAt.toISOString().slice(0, 10)} ${e.type} (${e.actorType})${payload}`;
  });
  // All dreaming LLM calls of a team's night share one Langfuse session, so
  // the Sessions view aggregates the per-night cost per team.
  const dreamDate = new Date().toISOString().slice(0, 10);

  const prompt = [
    `<today>${dreamDate}</today>`,
    `<episodes>\n${episodeBlocks.join("\n")}\n</episodes>`,
    ...(eventLines.length > 0
      ? [`<recent_activity>\n${eventLines.join("\n")}\n</recent_activity>`]
      : []),
  ].join("\n\n");
  const output = await withNamedTrace(
    "memory-consolidate",
    {
      sessionId: `memory-dreaming:${teamId}:${dreamDate}`,
      metadata: { teamId, episodeIds: input.episodeIds.join(",") },
      tags: ["process:memory-consolidate", `team:${teamId}`],
    },
    async () => {
      const { model } = await resolveMemoryModel(
        "memory-consolidate",
        teamId,
        input.modelProfileKey,
      );
      const { text: raw, finishReason } = await generateText({
        model,
        instructions: SYSTEM_PROMPT,
        prompt,
        temperature: CONSOLIDATE_TEMPERATURE,
        maxOutputTokens: CONSOLIDATE_MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(CONSOLIDATE_TIMEOUT_MS),
        telemetry: telemetryFor("memory-consolidate"),
      });
      if (finishReason === "length") {
        // Reasoning ate the output budget before the answer started, so the
        // JSON below parses to nothing and this pass silently does nothing.
        // Loud on purpose — it is how a truncated consolidation looked like a
        // NOOP for a whole eval run (2026-08-04).
        console.warn(
          `[memory-consolidate] output truncated at ${CONSOLIDATE_MAX_OUTPUT_TOKENS.toString()} tokens (finishReason=length)`,
        );
      }
      const parsed = parseJudgeOutput(raw);
      if (!parsed) {
        console.warn(
          `[memory-consolidate] unparsable judge output for team ${teamId} (${raw.length.toString()} chars) — NOOP`,
        );
      }
      return parsed;
    },
  );
  if (!output || output.action === "NOOP") return NOOP;

  // Expand tags back to uuids — an unknown tag is dropped loudly, and the
  // structural guard below then decides whether what remains still carries a
  // real replacement.
  const supersededIds = [
    ...new Set(
      output.supersededIds.flatMap((tag) => {
        const id = idByTag.get(tag.trim());
        if (id === undefined) {
          console.warn(
            `[memory-consolidate] judge cited an unknown episode tag "${tag.slice(0, 24)}" — dropped`,
          );
          return [];
        }
        return [id];
      }),
    ),
  ];
  const minSuperseded = output.action === "MERGE" ? 2 : 1;
  if (
    supersededIds.length < minSuperseded ||
    !output.title?.trim() ||
    !output.summary?.trim()
  ) {
    // Name the failing branch — `degraded` alone cost a forensics pass
    // (2026-08-05) to tell a mangled id list from an empty summary.
    console.warn(
      `[memory-consolidate] degraded ${output.action} output for team ${teamId} (superseded ${supersededIds.length.toString()}/${minSuperseded.toString()}, title ${output.title?.trim() ? "ok" : "EMPTY"}, summary ${output.summary?.trim() ? "ok" : "EMPTY"}) — NOOP`,
    );
    return NOOP;
  }

  const superseded = episodes.filter((e) => supersededIds.includes(e.id));
  const survivorRecordIds = [
    ...new Set(
      superseded.flatMap((e) => e.episodeRecords.map((r) => r.recordId)),
    ),
  ];
  const occurredFroms = superseded
    .map((e) => e.occurredFrom)
    .filter((d): d is Date => d !== null);
  const occurredTos = superseded
    .map((e) => e.occurredTo)
    .filter((d): d is Date => d !== null);

  const { episode } = await upsertEpisode({
    organizationId,
    teamId,
    userId: episodes[0]?.userId ?? null,
    kind: "consolidated",
    title: output.title,
    summary: output.summary,
    occurredFrom:
      occurredFroms.length > 0
        ? new Date(Math.min(...occurredFroms.map((d) => d.getTime())))
        : null,
    occurredTo:
      occurredTos.length > 0
        ? new Date(Math.max(...occurredTos.map((d) => d.getTime())))
        : null,
    recordIds: survivorRecordIds,
    metadata: { action: output.action, supersededIds },
  });

  await db.transaction(async (tx) => {
    await supersedeEpisodes({
      episodeIds: supersededIds,
      supersededById: episode.id,
      tx,
    });
    await emitDomainEvent({
      tx,
      organizationId,
      teamId,
      type: "episode.consolidated",
      actor: SYSTEM_ACTOR,
      subjectType: "episode",
      payload: {
        episodeId: episode.id,
        action: output.action,
        supersededIds,
        title: episode.title,
      },
      dedupKey: `episode.consolidated:${episode.id}`,
    });
  });
  await deleteEpisodeVectors(supersededIds);

  const metadata: EpisodeVectorMetadata = {
    kind: episode.kind,
    title: episode.title,
    conversation_id: episode.conversationId,
    anchor_record_id: episode.anchorRecordId,
    occurred_from: episode.occurredFrom?.toISOString() ?? null,
    occurred_to: episode.occurredTo?.toISOString() ?? null,
  };
  await vectorizeSource({
    sourceType: "episodes",
    sourceId: episode.id,
    content: `${episode.title}\n\n${episode.summary}`,
    metadata,
    teamId,
    organizationId,
    userId: episode.userId,
  });

  return { action: output.action, episodeId: episode.id, supersededIds };
};
