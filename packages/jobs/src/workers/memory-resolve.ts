import db from "@fretik/shared/db";
import { callAiService } from "@fretik/shared/lib/ai-service";
import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import {
  RESOLUTION_AUTO_THRESHOLD,
  RESOLUTION_SUGGEST_THRESHOLD,
} from "@fretik/shared/lib/resolution";
import {
  anchorTextToRecords,
  matchSpansToRecords,
  type RecordAnchor,
} from "@fretik/shared/services/collection-records/anchor";
import { linkEventToRecords } from "@fretik/shared/services/domain-events/link-records";
import { type Job, Worker } from "bullmq";
import { z } from "zod";
import {
  MEMORY_RESOLVE_QUEUE,
  type MemoryResolveJobData,
} from "../queues/names";

/**
 * The event→graph resolver (P3). For one journal event: build a text view of
 * its payload, extract candidate spans through two complementary passes, match
 * them onto the team's confirmed records via the shared precision funnel, and
 * materialize `domain_event_links` in their trust band.
 *
 * - Pass 1 (free): `anchorTextToRecords` — exhaustive n-gram dictionary
 *   matching, zero cost, exact/alias/FTS/trigram gates.
 * - Pass 2 (primary): LLM mention extraction via the AI service — robust to
 *   lowercase names, free formats, typos, any language. Its spans go through
 *   the SAME `matchSpansToRecords` funnel; a match's confidence is capped by
 *   the mention's own confidence (`min(match, mention)`), so a vague mention
 *   can never auto-link. Soft-fail: an AI-service outage degrades to pass 1 —
 *   BullMQ retries are for DB failures, not LLM availability.
 *
 * Both passes only LINK to existing records — never create. Precision-first:
 * `confirmed` at ≥ RESOLUTION_AUTO_THRESHOLD, `suggested` in the review band,
 * dropped below RESOLUTION_SUGGEST_THRESHOLD.
 */

const CONCURRENCY = 5;
const MAX_ANCHORS = 8;
/** Below this there is nothing to resolve ("ok", an emoji, an empty payload). */
const MIN_TEXT_CHARS = 10;
/** Below this the n-gram pass already saturates — skip the LLM call. */
const LLM_MIN_TEXT_CHARS = 40;
/** Ceiling for the JSON.stringify fallback text of unknown event shapes. */
const FALLBACK_TEXT_MAX_CHARS = 4_000;

const mentionsResponseSchema = z.object({
  mentions: z.array(
    z.object({
      label: z.string(),
      collectionKeyHint: z.string().optional(),
      confidence: z.number().optional(),
    }),
  ),
});

const relationsResponseSchema = z.object({
  created: z.number(),
  suggested: z.number(),
  invalidated: z.number(),
});

const stringField = (payload: Record<string, unknown>, key: string): string => {
  const value = payload[key];
  return typeof value === "string" ? value : "";
};

/** Text view of an event's payload, by type family. */
const buildEventText = (
  type: string,
  payload: Record<string, unknown>,
): string => {
  if (type === "chat.turn") {
    return [
      stringField(payload, "userMessagePreview"),
      stringField(payload, "assistantPreview"),
    ]
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (type.startsWith("memory.")) {
    return [stringField(payload, "path"), stringField(payload, "scope")]
      .filter((part) => part.length > 0)
      .join("\n");
  }
  // connector.* / workflow.* / anything else — the raw payload, bounded.
  return JSON.stringify(payload).slice(0, FALLBACK_TEXT_MAX_CHARS);
};

const resolveEvent = async (data: MemoryResolveJobData): Promise<void> => {
  // Re-read the fresh row — payloads never go stale in Redis by design.
  const event = await db.query.domainEvents.findFirst({
    where: { id: data.eventId },
  });
  if (!event) return; // deleted / cascaded since the sweep — nothing to do

  const text = buildEventText(event.type, event.payload).trim();
  if (text.length < MIN_TEXT_CHARS) return;

  // Merge anchors from both passes by record — highest confidence wins.
  const anchors = new Map<string, RecordAnchor>();
  const add = (anchor: RecordAnchor): void => {
    const prior = anchors.get(anchor.recordId);
    if (!prior || anchor.confidence > prior.confidence) {
      anchors.set(anchor.recordId, anchor);
    }
  };

  // Pass 1 — free n-gram dictionary matching.
  const dictionaryAnchors = await anchorTextToRecords({
    teamId: event.teamId,
    text,
    maxAnchors: MAX_ANCHORS,
  });
  for (const anchor of dictionaryAnchors) add(anchor);

  // Pass 2 — LLM mention extraction (primary), soft-fail to pass 1 alone.
  if (text.length >= LLM_MIN_TEXT_CHARS) {
    try {
      const { mentions } = await callAiService(
        "/internal/memory/extract-mentions",
        { text, teamId: event.teamId, organizationId: event.organizationId },
        mentionsResponseSchema,
        { teamId: event.teamId, organizationId: event.organizationId },
      );
      if (mentions.length > 0) {
        // Cap each match by its mention's confidence — keyed by the span,
        // which the funnel echoes back as `matchedText`.
        const confidenceBySpan = new Map<string, number>();
        for (const mention of mentions) {
          const cap = mention.confidence ?? 1;
          const prior = confidenceBySpan.get(mention.label);
          if (prior === undefined || cap > prior) {
            confidenceBySpan.set(mention.label, cap);
          }
        }
        const matches = await matchSpansToRecords({
          teamId: event.teamId,
          spans: [...confidenceBySpan.keys()],
          maxAnchors: MAX_ANCHORS,
        });
        for (const match of matches) {
          const cap = confidenceBySpan.get(match.matchedText) ?? 1;
          add({ ...match, confidence: Math.min(match.confidence, cap) });
        }
      }
    } catch (err) {
      console.warn(
        `[memory-resolve] mention extraction unavailable for event ${event.id} — dictionary pass only:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Never re-link the event's own subject or records already linked at source.
  if (event.subjectRecordId) anchors.delete(event.subjectRecordId);
  const existingLinks = await db.query.domainEventLinks.findMany({
    where: { eventId: event.id },
    columns: { recordId: true },
  });
  for (const link of existingLinks) anchors.delete(link.recordId);

  // Band + write. The funnel already floors at the suggest threshold; the
  // filter is a guard against a future maxAnchors/threshold drift.
  const links = [...anchors.values()].filter(
    (anchor) => anchor.confidence >= RESOLUTION_SUGGEST_THRESHOLD,
  );
  const confirmed = links.filter(
    (anchor) => anchor.confidence >= RESOLUTION_AUTO_THRESHOLD,
  ).length;
  if (links.length > 0) {
    await linkEventToRecords({
      eventId: event.id,
      links: links.map((anchor) => ({
        recordId: anchor.recordId,
        role: "mentioned",
        confidence: anchor.confidence,
        status:
          anchor.confidence >= RESOLUTION_AUTO_THRESHOLD
            ? "confirmed"
            : "suggested",
        source: "ai_inference",
      })),
    });
  }

  console.info(
    `[memory-resolve] event ${event.id} (${event.type}) → ${confirmed.toString()} confirmed, ${(links.length - confirmed).toString()} suggested`,
  );

  // Relation extraction (P8.4) — a second, richer pass when the event connects
  // ≥2 records: the typed relations the text ASSERTS between them become
  // `links`. Only confirmed-band records seed it (a suggested mention is too
  // weak an endpoint for a fact). Soft-fail like pass 2 — a graph write is a
  // bonus, never a reason to fail the resolve job.
  const relationRecordIds = new Set<string>();
  if (event.subjectRecordId) relationRecordIds.add(event.subjectRecordId);
  for (const anchor of links) {
    if (anchor.confidence >= RESOLUTION_AUTO_THRESHOLD) {
      relationRecordIds.add(anchor.recordId);
    }
  }
  for (const link of existingLinks) relationRecordIds.add(link.recordId);
  if (relationRecordIds.size >= 2 && text.length >= LLM_MIN_TEXT_CHARS) {
    try {
      const result = await callAiService(
        "/internal/memory/extract-relations",
        {
          text,
          recordIds: [...relationRecordIds],
          teamId: event.teamId,
          organizationId: event.organizationId,
        },
        relationsResponseSchema,
        { teamId: event.teamId, organizationId: event.organizationId },
      );
      if (result.created > 0 || result.invalidated > 0) {
        console.info(
          `[memory-resolve] event ${event.id} relations → ${result.created.toString()} created (${result.suggested.toString()} suggested), ${result.invalidated.toString()} invalidated`,
        );
      }
    } catch (err) {
      console.warn(
        `[memory-resolve] relation extraction unavailable for event ${event.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
};

export const startMemoryResolveWorker = (): Worker<MemoryResolveJobData> => {
  const worker = new Worker<MemoryResolveJobData>(
    MEMORY_RESOLVE_QUEUE,
    (job: Job<MemoryResolveJobData>) => resolveEvent(job.data),
    { connection: createWorkerConnection(), concurrency: CONCURRENCY },
  );
  worker.on("failed", (job, err) => {
    console.error(
      `[memory-resolve] job ${job?.id ?? "<unknown>"} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
  return worker;
};
