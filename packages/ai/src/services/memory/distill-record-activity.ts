import db from "@fretik/shared/db";
import type { EpisodeVectorMetadata } from "@fretik/shared/db/schema";
import { parseLlmJsonObject } from "@fretik/shared/lib/llm-json";
import { upsertEpisode } from "@fretik/shared/services/episodes/upsert";
import { generateText } from "ai";
import { z } from "zod";
import { telemetryFor } from "../../lib/langfuse";
import { resolveMemoryModel } from "../../lib/model-registry/team-model";
import { withTraceSession } from "../../lib/trace-tool";
import { vectorizeSource } from "../vectorize";

/**
 * Record activity → digest episode (P6 dreaming). One utility-tier LLM call
 * turns a busy record's recent subject events into a rolling episodic digest
 * (`ai_episodes`, kind `record_activity`, keyed on `anchorRecordId` by the
 * active partial unique index — re-runs replace). Always team-visible
 * (`userId` NULL): the journal rows it reads are team-scoped activity.
 *
 * The threshold (≥5 events / 7 days) lives in the dreaming cron's candidate
 * query (`listRecordActivityCandidates`); MIN_DIGEST_EVENTS mirrors it as a
 * self-defence for direct calls.
 */

const MIN_DIGEST_EVENTS = 5;
const DIGEST_WINDOW_DAYS = 7;
const MAX_EVENTS = 80;
const MAX_PAYLOAD_CHARS = 200;
const DIGEST_TIMEOUT_MS = 45_000;
const DIGEST_TEMPERATURE = 0;
/** Same envelope as distill-conversation: ~800-token JSON + low-effort reasoning. */
const DIGEST_MAX_OUTPUT_TOKENS = 3_000;

const digestOutputSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
});

const SYSTEM_PROMPT = `Distill one business record's recent activity log into a compact episodic digest. Future turns retrieve it to recall what has been happening around that record.

Output strict JSON, nothing else:
{"title":"...","summary":"..."}

- title: ≤100 chars, names the record and the gist of the activity.
- summary: markdown, target ~1000 characters. Capture what changed, who acted, notable values from the event payloads, and where the activity is heading. Aggregate repetitive events into one line ("12 field edits over 3 days"). Only what the events state — no speculation.
- NEVER copy secrets (passwords, API keys, tokens) or personal data unrelated to the work from the payloads — note that a value changed, not the secret itself.
- Write title and summary in the language of the record's own labels and values.`;

const parseDigestOutput = (
  raw: string,
): z.infer<typeof digestOutputSchema> | null => {
  const parsed = digestOutputSchema.safeParse(parseLlmJsonObject(raw));
  return parsed.success ? parsed.data : null;
};

export interface DistillRecordActivityResult {
  distilled: boolean;
  episodeId?: string;
}

export const distillRecordActivity = async (input: {
  recordId: string;
  teamId: string;
  organizationId: string;
  /** Force a registry profile — EVAL/BENCH ONLY (model bake-off). */
  modelProfileKey?: string;
}): Promise<DistillRecordActivityResult> => {
  const { recordId, teamId, organizationId } = input;

  const record = await db.query.objectRecords.findFirst({
    where: { id: recordId, teamId },
    columns: { id: true, label: true },
    with: { objectType: { columns: { label: true } } },
  });
  if (!record) return { distilled: false };

  const since = new Date(Date.now() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const events = await db.query.domainEvents.findMany({
    where: { teamId, subjectRecordId: recordId, recordedAt: { gt: since } },
    orderBy: { recordedAt: "asc" },
    limit: MAX_EVENTS,
  });
  if (events.length < MIN_DIGEST_EVENTS) return { distilled: false };

  const eventLines = events.map((e) => {
    const payload =
      Object.keys(e.payload).length > 0
        ? ` — ${JSON.stringify(e.payload).slice(0, MAX_PAYLOAD_CHARS)}`
        : "";
    return `- ${e.recordedAt.toISOString()} ${e.type} (${e.actorType})${payload}`;
  });
  const prompt = [
    `<record>\n${record.objectType?.label ?? "Record"}: ${record.label}\n</record>`,
    `<events>\n${eventLines.join("\n")}\n</events>`,
  ].join("\n\n");

  const occurredFrom = events[0]?.recordedAt ?? null;
  const occurredTo = events[events.length - 1]?.recordedAt ?? null;

  // All dreaming LLM calls of a team's night share one Langfuse session, so
  // the Sessions view aggregates the per-night cost per team.
  const dreamDate = new Date().toISOString().slice(0, 10);
  const output = await withTraceSession(
    `memory-dreaming:${teamId}:${dreamDate}`,
    {
      metadata: { recordId, teamId },
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
        system: SYSTEM_PROMPT,
        prompt,
        temperature: DIGEST_TEMPERATURE,
        maxOutputTokens: DIGEST_MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(DIGEST_TIMEOUT_MS),
        experimental_telemetry: telemetryFor("memory-distill"),
      });
      const parsed = parseDigestOutput(raw);
      if (!parsed) {
        console.warn(
          `[memory] record-activity digest unparsable for ${recordId} (${raw.length.toString()} chars) — skipped`,
        );
      }
      return parsed;
    },
  );
  if (!output) return { distilled: false };

  const { episode, contentChanged } = await upsertEpisode({
    organizationId,
    teamId,
    userId: null,
    kind: "record_activity",
    title: output.title,
    summary: output.summary,
    anchorRecordId: recordId,
    occurredFrom,
    occurredTo,
    recordIds: [recordId],
    metadata: { eventCount: events.length },
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
