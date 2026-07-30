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
 * Privacy: a single-member conversation distills to a PRIVATE episode
 * (`userId` = that member); ≥2 members → team-visible (`userId` NULL).
 *
 * Output handling mirrors `extract-mentions.ts` (defensive parse degrading
 * to a no-op, never `Output.object`) for the same provider-pool reason.
 */

const MIN_MESSAGES = 4;
/** Workflow-run floor: steering + final summary = 2 text lines is already a
 * complete short run — the chat threshold would skip it entirely. */
const WORKFLOW_MIN_MESSAGES = 2;
/** Transcript tail — mirrors `loadConversationForAgent`'s window ×2. */
const MAX_MESSAGES = 60;
/** Per-message clip: enough to carry intent, not full tool dumps. */
const MAX_MESSAGE_CHARS = 500;
/**
 * Total transcript ceiling (~3k tokens). When the clipped tail still
 * overflows, the OLDEST messages drop first — recency wins for memory.
 */
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_CANDIDATE_RECORDS = 40;
const DISTILL_TIMEOUT_MS = 45_000;
const DISTILL_TEMPERATURE = 0;
/**
 * Title (~30) + summary (~1500 chars ≈ 400 tokens) + 25 uuids (~300
 * tokens) + JSON scaffolding ≈ 800 tokens worst case; a truncated JSON
 * loses the whole pass, so 3 000 gives ~4× margin. Reasoning runaway is
 * bounded by the role envelope's `effort: "low"`.
 */
const DISTILL_MAX_OUTPUT_TOKENS = 3_000;

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
- salientRecordIds: ids picked FROM the candidate_records list only — the records this conversation is genuinely about, most salient first. Never invent an id; unsure → omit it. None → [].
- NEVER copy secrets (passwords, API keys, tokens) or personal data unrelated to the work into the summary — describe that they were handled, not their values.
- Write title and summary in the conversation's language.`;

const parseDistillOutput = (
  raw: string,
): z.infer<typeof distillOutputSchema> | null => {
  const parsed = distillOutputSchema.safeParse(parseLlmJsonObject(raw));
  return parsed.success ? parsed.data : null;
};

interface TranscriptLine {
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

/** Oldest-first lines joined under the total ceiling — oldest drop first. */
const renderTranscript = (lines: TranscriptLine[]): string => {
  const rendered = lines.map(
    (l) =>
      `${l.role === "user" ? "User" : "Assistant"}: ${l.text.slice(0, MAX_MESSAGE_CHARS)}`,
  );
  let total = 0;
  const kept: string[] = [];
  for (let i = rendered.length - 1; i >= 0; i--) {
    const line = rendered[i];
    if (line === undefined) continue;
    if (total + line.length > MAX_TRANSCRIPT_CHARS) break;
    total += line.length;
    kept.unshift(line);
  }
  return kept.join("\n\n");
};

export interface DistillConversationResult {
  distilled: boolean;
  episodeId?: string;
}

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
  // for the episode's occurrence window.
  const rows = await db.query.aiMessages.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    limit: MAX_MESSAGES,
  });
  rows.reverse();
  const lines: TranscriptLine[] = [];
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    // Workflow steering recitations (turn ≥2) are near-identical harness
    // boilerplate ("Continue the run. Current task: …") — they'd bias the
    // episode toward playbook recitation. Turn 1 stays: it names the trigger.
    if (
      workflowRun &&
      row.role === "user" &&
      isLaterSteeringMessage(row.metadata)
    ) {
      continue;
    }
    const text = textOfParts(row.parts);
    if (text.length === 0) continue;
    lines.push({ role: row.role, text });
  }
  // A workflow run is steering + final summary at minimum — 2 lines is a
  // real, distillable run; the chat threshold would skip every short run.
  const minLines = workflowRun ? WORKFLOW_MIN_MESSAGES : MIN_MESSAGES;
  if (lines.length < minLines) return { distilled: false };

  const first = rows[0];
  const last = rows[rows.length - 1];
  const occurredFrom = first ? first.createdAt : null;
  const occurredTo = last ? last.createdAt : null;

  // Privacy scope: exactly one member → private episode; the legacy
  // memberless shape falls back to the creator; otherwise team-visible.
  // Workflow runs override this entirely: their conversations are memberless
  // and owned by the acting identity (team bot for team workflows), which
  // would make every team workflow's memory PRIVATE TO THE BOT — invisible
  // to all humans. The episode inherits the workflow's own visibility
  // instead: owned workflow → private to the owner, team workflow → NULL.
  const members = await db.query.aiConversationMembers.findMany({
    where: { conversationId },
    columns: { userId: true },
  });
  const episodeUserId = workflowRun
    ? (workflowOwner?.userId ?? null)
    : members.length === 1
      ? (members[0]?.userId ?? null)
      : members.length === 0
        ? (conversation.userId ?? null)
        : null;

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
      const { text: raw } = await generateText({
        model,
        instructions: SYSTEM_PROMPT,
        prompt,
        temperature: DISTILL_TEMPERATURE,
        maxOutputTokens: DISTILL_MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(DISTILL_TIMEOUT_MS),
        telemetry: telemetryFor("memory-distill"),
      });
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
