import db from "@fretik/shared/db";
import type { EpisodeVectorMetadata } from "@fretik/shared/db/schema";
import { parseLlmJsonObject } from "@fretik/shared/lib/llm-json";
import { upsertEpisode } from "@fretik/shared/services/episodes/upsert";
import { generateText, type UIMessage } from "ai";
import { z } from "zod";
import { telemetryFor } from "../../lib/langfuse";
import { resolveMemoryModel } from "../../lib/model-registry/team-model";
import { withNamedTrace } from "../../lib/trace-tool";
import { vectorizeSource } from "../vectorize";

/**
 * Conversation → episode distillation (P4). One utility-tier LLM call turns a
 * quiet conversation's transcript into a compact episodic memory
 * (`ai_episodes`, kind `conversation`), anchored on the records its journal
 * events resolved to — the distiller PICKS salient ids from that candidate
 * list, never invents them. Re-runs are full replaces through
 * `upsertEpisode`; an unchanged `contentHash` skips the re-embed.
 *
 * Privacy: a conversation is its participants', so its episode is never the
 * whole team's. A single-member conversation distills to a PRIVATE episode
 * (`userId` = that member); with several members it is kept to its owner,
 * who took part in all of it, until episodes can carry an audience of their
 * own (the participants). A workflow run's follows its workflow.
 *
 * Output handling mirrors `extract-mentions.ts` (defensive parse degrading
 * to a no-op, never `Output.object`) for the same provider-pool reason.
 */

const MIN_MESSAGES = 4;
/** Workflow-run floor: steering + final summary = 2 text lines is already a
 * complete short run — the chat threshold would skip it entirely. */
const WORKFLOW_MIN_MESSAGES = 2;
/** Transcript tail in rows — a loose bound: the token ceiling below decides. */
const MAX_MESSAGES = 60;
/**
 * Total transcript ceiling (~15k tokens), and the ONLY size rule that decides
 * anything. The OLDEST messages drop first — recency wins for memory.
 *
 * It replaced a flat 500-character clip per message, which is the defect this
 * number exists to close. Measured over 30 days of production: the clip bit on
 * **95 % of workflow messages** and **51 % of chat messages**, the distiller
 * received **17.6 %** of a run's narration and **12.1 %** of a chat's — while
 * using **9 %** of the 12 000-character budget it was already allowed. The two
 * constants were not cooperating; one of them was doing all the cutting and it
 * was the wrong one.
 *
 * What that cost is not abstract. A run of `Export EDI Fatton` finished
 * **succeeded**, 5 files generated and acknowledged by the FTP server, and its
 * episode reads *"la transcription s'arrête avant la fin de l'extraction ; les
 * tâches `generer-fichiers` et `upload-ftp` restent à exécuter"* — because the
 * conversation was two rows, the assistant's 4 561-character report was cut at
 * 500, and the cut landed mid-sentence during the extraction. The model was
 * right about its input and wrong about the world, and that wrong conclusion is
 * now a durable memory. The recap it never saw also carried the one fact worth
 * remembering: a generation step had been marked closed with no file on disk,
 * and the agent regenerated all five before sending.
 *
 * 60 000 is derived, not guessed: it carries **100 %** of production workflow
 * runs and **95.9 %** of chats WHOLE (12 000 carried 92.6 % / 78.6 % — the
 * budget was nearly right all along). Sending everything whole costs ~1.9 M
 * input tokens a month against the 1.25 BILLION the chat turns already spend —
 * 0.15 % — on a model whose window is 997 952.
 */
const MAX_TRANSCRIPT_CHARS = 60_000;
/**
 * Below this, a clipped line carries no usable content and is dropped instead.
 * Above it, a message too long for the budget is CLIPPED rather than skipped —
 * which is the part that must not be got wrong: the previous walk simply
 * stopped at the first line that did not fit, and with the per-message clip
 * gone that would return an EMPTY transcript for exactly the heaviest
 * conversations (the largest single message measured in production is 567 864
 * characters, and it is the newest one).
 */
const MIN_CLIPPED_LINE_CHARS = 1_000;
const MAX_CANDIDATE_RECORDS = 40;
/** Off the hot path — sized for the slowest eligible model, see `extract-mentions.ts`. */
const DISTILL_TIMEOUT_MS = 120_000;
const DISTILL_TEMPERATURE = 0;
/**
 * Title (~30) + summary (~1500 chars ≈ 400 tokens) + 25 uuids (~300
 * tokens) + JSON scaffolding ≈ 800 tokens worst case; a truncated JSON
 * loses the whole pass, so 3 000 gives ~4× margin. Reasoning runaway is
 * bounded by the role envelope's `effort: "low"`.
 */
/** See `consolidate-episodes.ts`: sized so reasoning cannot starve the answer. */
const DISTILL_MAX_OUTPUT_TOKENS = 12_000;

const distillOutputSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  salientRecordIds: z.array(z.string()).default([]),
});

const SYSTEM_PROMPT = `Distill one workplace-assistant conversation into a compact episodic memory. Future turns retrieve it to recall what was discussed, decided, and produced.

Output strict JSON, nothing else:
{"title":"...","summary":"...","salientRecordIds":["..."]}

- title: ≤100 chars, specific enough to identify this conversation among hundreds.
- summary: markdown, target ~1500 characters. Capture what the user wanted, what was concluded or produced, decisions and their reasons, unresolved points, and durable facts or preferences revealed. Skip pleasantries, tool mechanics, step-by-step narration.
- The transcript is an excerpt: assistant and user messages only (no tool calls), newest kept first, […] where text was omitted. Report what the messages show — never a gap, or the excerpt's edge, as work left undone.
- salientRecordIds: ids picked FROM the candidate_records list only — the records this conversation is genuinely about, most salient first. Never invent an id; unsure → omit it. None → [].
- NEVER copy secrets (passwords, API keys, tokens) or personal data unrelated to the work into the summary — describe that they were handled, not their values.
- Write title and summary in the conversation's language.`;

const parseDistillOutput = (
  raw: string,
): z.infer<typeof distillOutputSchema> | null => {
  const parsed = distillOutputSchema.safeParse(parseLlmJsonObject(raw));
  return parsed.success ? parsed.data : null;
};

export interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
}

/** Workflow steering messages stamp their turn in metadata
 * (`workflowTurnIndex`, see the workflow turn handler) — turn ≥2 ones are
 * pure harness recitation, dropped from the distill transcript. */
const isLaterSteeringMessage = (metadata: unknown): boolean => {
  if (metadata === null || typeof metadata !== "object") return false;
  if (!("workflowTurnIndex" in metadata)) return false;
  const turn: unknown = metadata.workflowTurnIndex;
  return typeof turn === "number" && turn > 1;
};

const textOfParts = (parts: UIMessage["parts"]): string => {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
};

/**
 * Message rows → the lines a transcript is built from: TEXT only, in order.
 *
 * Tool calls, tool results and reasoning never reach the distiller — the
 * summary is asked for outcomes, and a tool dump is both the wrong material
 * and where the pathological sizes live (the largest single text message in
 * production is 567 864 characters; the parts around it are larger still).
 *
 * It was briefly exported, for a repair script that had to reproduce exactly
 * this input to decide which episodes the old per-message clip had damaged.
 * That script ran and was deleted; the extraction stays because the loop reads
 * better with a name than inlined in `distillConversation`.
 */
const toTranscriptLines = (
  rows: {
    role: string;
    parts: UIMessage["parts"];
    metadata: Record<string, unknown> | null;
  }[],
  isWorkflowRun: boolean,
): TranscriptLine[] => {
  const lines: TranscriptLine[] = [];
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    // Workflow steering recitations (turn ≥2) are near-identical harness
    // boilerplate ("Continue the run. Current task: …") — they'd bias the
    // episode toward playbook recitation. Turn 1 stays: it names the trigger.
    if (
      isWorkflowRun &&
      row.role === "user" &&
      isLaterSteeringMessage(row.metadata)
    ) {
      continue;
    }
    const text = textOfParts(row.parts);
    if (text.length === 0) continue;
    lines.push({ role: row.role, text });
  }
  return lines;
};

/**
 * Keep the head and the tail of a message that does not fit, around an explicit
 * marker.
 *
 * Head-only was the old rule and it is the wrong one for this content: an
 * assistant's report opens with narration and CLOSES with what it produced —
 * the deliverables, the anomalies, the numbers. Cutting from the front throws
 * away the conclusion and keeps the preamble. Marking the gap matters as much
 * as the halves: an unmarked cut reads as the end of the work rather than the
 * end of the excerpt, which is precisely how an episode came to report a
 * finished run as unfinished.
 */
const clipAround = (text: string, budget: number): string => {
  const marker = "\n\n[…]\n\n";
  const room = budget - marker.length;
  if (room <= 0) return text.slice(0, budget);
  const head = Math.ceil(room / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (room - head))}`;
};

/**
 * Oldest-first lines under the total ceiling — oldest drop first, and the one
 * that straddles the edge is clipped rather than dropped.
 *
 * Walking backwards is what makes recency win. Clipping the straddling line
 * instead of stopping at it is what stops the walk from returning nothing when
 * the NEWEST message is on its own larger than the whole budget.
 */
export const renderTranscript = (lines: TranscriptLine[]): string => {
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l === undefined) continue;
    const prefix = l.role === "user" ? "User: " : "Assistant: ";
    // The blank line this entry will be joined with counts against the budget
    // too, or `total` measures something the caller never sends. Small — two
    // characters per entry, 118 on a full window — and the reason to fix it is
    // not the size but that a ceiling which does not bound the string is not a
    // ceiling.
    const separator = kept.length > 0 ? 2 : 0;
    const remaining = MAX_TRANSCRIPT_CHARS - total - separator - prefix.length;
    if (l.text.length <= remaining) {
      total += separator + prefix.length + l.text.length;
      kept.unshift(prefix + l.text);
      continue;
    }
    if (remaining >= MIN_CLIPPED_LINE_CHARS) {
      kept.unshift(prefix + clipAround(l.text, remaining));
    }
    break;
  }
  return kept.join("\n\n");
};

export interface DistillConversationResult {
  distilled: boolean;
  episodeId?: string;
}

/**
 * Whose episode a chat distills to: its only member's, else its owner's (the
 * owner seat, else whoever created it). Never NULL, which would make it the
 * whole team's: a chat is its participants', and the rest of the team could
 * not read it.
 */
export const chatEpisodeOwner = (input: {
  members: readonly { userId: string; role: "owner" | "member" }[];
  creatorUserId: string | null;
}): string | null => {
  const [only, ...others] = input.members;
  if (only !== undefined && others.length === 0) return only.userId;
  return (
    input.members.find((member) => member.role === "owner")?.userId ??
    input.creatorUserId
  );
};

export const distillConversation = async (input: {
  conversationId: string;
  teamId: string;
  organizationId: string;
  /** Force a registry profile — EVAL/BENCH ONLY (model bake-off). */
  modelProfileKey?: string;
}): Promise<DistillConversationResult> => {
  const { conversationId, teamId, organizationId } = input;

  const conversation = await db.query.aiConversations.findFirst({
    where: { id: conversationId },
  });
  if (!conversation) return { distilled: false };

  // Workflow-run conversations distill with workflow-aware rules: the
  // episode inherits the WORKFLOW's visibility (not the run's bot-user
  // identity, which would silo team memory away from every human), carries
  // workflow attribution in metadata, drops the per-turn steering
  // recitation, and accepts a shorter transcript (a short successful run
  // still ends with a substantive final summary).
  const workflowRun =
    conversation.agentType === "workflow"
      ? await db.query.workflowRuns.findFirst({
          where: { conversationId },
          columns: { id: true, workflowId: true, triggerType: true },
        })
      : undefined;
  const workflowOwner = workflowRun
    ? await db.query.workflows.findFirst({
        where: { id: workflowRun.workflowId },
        columns: { userId: true },
      })
    : undefined;

  // Transcript tail, oldest first. Rows are read directly (not through
  // `loadConversationForAgent`) because the distiller needs `createdAt`
  // for the episode's occurrence window. Ordered by `seq`, never
  // `created_at`: a turn's rows share one `transaction_timestamp()`, so
  // `created_at` ties and the tail comes back shuffled — the assistant's
  // answer ahead of the user's question, and a non-deterministic slice
  // once the conversation is longer than `MAX_MESSAGES`.
  const rows = await db.query.aiMessages.findMany({
    where: { conversationId },
    orderBy: { seq: "desc" },
    limit: MAX_MESSAGES,
  });
  rows.reverse();
  const lines = toTranscriptLines(rows, workflowRun !== undefined);
  // A workflow run is steering + final summary at minimum — 2 lines is a
  // real, distillable run; the chat threshold would skip every short run.
  const minLines = workflowRun ? WORKFLOW_MIN_MESSAGES : MIN_MESSAGES;
  if (lines.length < minLines) return { distilled: false };

  const first = rows[0];
  const last = rows[rows.length - 1];
  const occurredFrom = first ? first.createdAt : null;
  const occurredTo = last ? last.createdAt : null;

  // Privacy scope: exactly one member → private episode; several → private
  // to the conversation's owner (its owner seat, else its creator), never
  // the team's: the chat was its participants', and the rest of the team
  // could not read it. The legacy memberless shape falls back to the creator.
  // Workflow runs override this entirely: their conversations are memberless
  // and owned by the acting identity (team bot for team workflows), which
  // would make every team workflow's memory PRIVATE TO THE BOT — invisible
  // to all humans. The episode inherits the workflow's own visibility
  // instead: owned workflow → private to the owner, team workflow → NULL.
  const members = await db.query.aiConversationMembers.findMany({
    where: { conversationId },
    columns: { userId: true, role: true },
  });
  const episodeUserId = workflowRun
    ? (workflowOwner?.userId ?? null)
    : chatEpisodeOwner({ members, creatorUserId: conversation.userId });

  // Candidate records = what the resolver linked to this conversation's
  // journal events. Confirmed links outrank suggested ones at the cap.
  const events = await db.query.domainEvents.findMany({
    where: { conversationId },
    with: { eventLinks: { with: { record: { columns: { label: true } } } } },
  });
  const candidates = new Map<string, { label: string; confirmed: boolean }>();
  for (const event of events) {
    for (const link of event.eventLinks) {
      if (!link.record) continue;
      const confirmed = link.status === "confirmed";
      const prior = candidates.get(link.recordId);
      if (!prior || (confirmed && !prior.confirmed)) {
        candidates.set(link.recordId, { label: link.record.label, confirmed });
      }
    }
  }
  const candidateList = [...candidates.entries()]
    .sort((a, b) => Number(b[1].confirmed) - Number(a[1].confirmed))
    .slice(0, MAX_CANDIDATE_RECORDS);

  const prompt = [
    `<transcript>\n${renderTranscript(lines)}\n</transcript>`,
    ...(candidateList.length > 0
      ? [
          `<candidate_records>\n${candidateList
            .map(([id, c]) => `- ${id} — ${c.label}`)
            .join("\n")}\n</candidate_records>`,
        ]
      : []),
  ].join("\n\n");

  // Single-call background pipeline → its own named trace, joined to the
  // conversation's Langfuse session so the distillation cost aggregates with
  // the turns it summarises.
  const output = await withNamedTrace(
    "memory-distill",
    {
      sessionId: conversationId,
      metadata: { conversationId, teamId },
      tags: ["process:memory-distill", `team:${teamId}`],
    },
    async () => {
      const { model } = await resolveMemoryModel(
        "memory-distill",
        teamId,
        input.modelProfileKey,
      );
      const { text: raw, finishReason } = await generateText({
        model,
        instructions: SYSTEM_PROMPT,
        prompt,
        temperature: DISTILL_TEMPERATURE,
        maxOutputTokens: DISTILL_MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(DISTILL_TIMEOUT_MS),
        telemetry: telemetryFor("memory-distill"),
      });
      if (finishReason === "length") {
        // Reasoning ate the output budget before the answer started, so the
        // JSON below parses to nothing and this pass silently does nothing.
        // Loud on purpose — it is how a truncated consolidation looked like a
        // NOOP for a whole eval run (2026-08-04).
        console.warn(
          `[memory-distill] output truncated at ${DISTILL_MAX_OUTPUT_TOKENS.toString()} tokens (finishReason=length)`,
        );
      }
      return parseDistillOutput(raw);
    },
  );
  if (!output) return { distilled: false };

  // Structural guard on top of the prompt rule: only candidate ids pass.
  const candidateIds = new Set(candidateList.map(([id]) => id));
  const recordIds = output.salientRecordIds.filter((id) =>
    candidateIds.has(id),
  );

  const { episode, contentChanged } = await upsertEpisode({
    organizationId,
    teamId,
    userId: episodeUserId,
    kind: "conversation",
    title: output.title,
    summary: output.summary,
    conversationId,
    occurredFrom,
    occurredTo,
    recordIds,
    // Workflow attribution — lets future consolidation/dedup group a
    // workflow's episodes and the UI trace an episode back to its run.
    ...(workflowRun
      ? {
          metadata: {
            workflowId: workflowRun.workflowId,
            workflowRunId: workflowRun.id,
            triggerType: workflowRun.triggerType,
          },
        }
      : {}),
  });

  if (contentChanged) {
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
  }

  return { distilled: true, episodeId: episode.id };
};
