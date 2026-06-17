import { generateText } from "ai";
import { telemetryFor } from "../../lib/langfuse";
import { resolveModelForTeam } from "../../lib/model-registry/team-model";
import { searchRAG } from "../search";
import { ACTIVE_MEMORY_SYSTEM_PROMPT } from "./prompt";

/**
 * Active Memory pre-reply recall.
 *
 * Pattern aligned with OpenClaw's `active-memory` plugin:
 * before the main `streamText` call, build a short query from the
 * current user message + attached files + a recent conversation
 * tail, search the team's persistent `[USER_MEMORY]` /
 * `[TEAM_MEMORY]` index via `searchRAG`, then have a small cheap
 * model judge whether any candidate is relevant enough to surface
 * as a hidden system context block for the main turn.
 *
 * Why this pattern (rather than letting the main agent call
 * `searchKnowledge` itself):
 *   - Memories already exist for the team but the main agent only
 *     finds them when it explicitly calls `searchKnowledge`. Silent
 *     misses leave durable preferences / processes unapplied.
 *   - A cheap pre-reply call (~$0.0001, ~1-2s) injects relevant
 *     memories deterministically every turn.
 *   - The judge model never invents — it only distills what's in
 *     the candidate memories. If nothing is clearly relevant it
 *     returns `NONE` and we inject nothing (no noise).
 *
 * Skip conditions are conservative on purpose: we DO want recall
 * on the very first message (a user uploading a PDF and saying
 * "generate the CSV" relies on memory of past patterns indexed by
 * file type / name). We only skip on truly trivial messages
 * (`ok`, `merci`, `thanks`, …) with no attachments.
 *
 * Failure semantics: any error is swallowed and returns `null`.
 * Active Memory must NEVER block the main turn.
 */

const TRIVIAL_REGEX = /^(ok|okay|merci|thanks|thx|👍|yes|no|oui|non)\.?$/i;

/**
 * Cap the conversation tail we send to the judge. OpenClaw uses
 * `recentUserChars: 220` / `recentAssistantChars: 180` per turn —
 * we mirror that envelope so the judge stays cheap and on-task.
 */
const RECENT_TAIL_MAX_CHARS = 600;
const RECENT_USER_TURN_MAX_CHARS = 220;
const RECENT_ASSISTANT_TURN_MAX_CHARS = 180;

/**
 * Per-recall hard timeout. OpenClaw default is 15 s. Generous
 * enough for a cold-start `gpt-oss-20b` route on OpenRouter; if
 * recall consistently times out, lower this and switch model.
 */
const RECALL_TIMEOUT_MS = 15_000;

/**
 * In-memory result cache. Same `(userMessage + attachments)` hash
 * within 15 s reuses the prior recall — avoids double work on
 * resumable-stream reconnection or rapid retries within the same
 * turn. Bounded to 500 entries; older entries are purged on next
 * write when the size threshold is hit.
 *
 * Process-local on purpose: this is a per-turn optimisation, not
 * cross-instance sync. Resumable stream reconnects come back to
 * the same handler instance via the Redis tee.
 */
const CACHE_TTL_MS = 15_000;
const CACHE_MAX_ENTRIES = 500;

/**
 * Top-K candidate memories pulled from RAG before the judge step.
 * 8 keeps the judge prompt under ~2 KB even on dense memory bodies
 * and matches OpenClaw's default conservative ceiling.
 */
const TOP_K = 8;

interface AttachedFile {
  filename: string;
  mimeType: string;
}

export interface ActiveMemoryRecallParams {
  /** Current user message verbatim. */
  userMessage: string;
  /** Files attached to the current message (filename + mimeType only — no content). */
  attachedFiles: AttachedFile[];
  /**
   * Pre-rendered recent conversation tail (max ~600 chars total).
   * Caller is responsible for truncation. Empty string when there
   * is no prior turn.
   */
  recentTail: string;
  teamId: string;
  organizationId: string;
  userId: string;
  abortSignal?: AbortSignal;
}

export interface ActiveMemoryRecallResult {
  /**
   * Markdown bullet list (1–3 bullets, ~500 chars max) ready to
   * inject inside an `<active_memory>` block in the system
   * prompt's dynamic suffix.
   */
  block: string;
}

interface CacheEntry {
  result: ActiveMemoryRecallResult | null;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

const cacheKey = (params: ActiveMemoryRecallParams): string => {
  const filesPart = params.attachedFiles
    .map((f) => `${f.filename}|${f.mimeType}`)
    .join(",");
  return `${params.teamId}:${params.userId}:${params.userMessage.slice(0, 200)}:${filesPart}`;
};

const isTrivialMessage = (
  msg: string,
  attachments: AttachedFile[],
): boolean => {
  const trimmed = msg.trim();
  // Never skip when files are attached — the user expects pattern
  // recall keyed on filename / mimetype even from a one-word command
  // ("génère le CSV", "summarise this").
  if (attachments.length > 0) return false;
  if (trimmed.length >= 10) return false;
  return TRIVIAL_REGEX.test(trimmed);
};

const buildRecallQuery = (params: ActiveMemoryRecallParams): string => {
  const parts: string[] = [params.userMessage.trim()];
  if (params.attachedFiles.length > 0) {
    const fileDesc = params.attachedFiles
      .map((f) => `${f.filename} (${f.mimeType})`)
      .join(", ");
    parts.push(`Attached: ${fileDesc}`);
  }
  return parts.join(" — ");
};

const buildJudgePrompt = (
  params: ActiveMemoryRecallParams,
  candidates: { content: string }[],
): string => {
  const filesLine =
    params.attachedFiles.length > 0
      ? `Attached files: ${params.attachedFiles.map((f) => `${f.filename} (${f.mimeType})`).join(", ")}\n\n`
      : "";
  const candidatesBlock = candidates
    .map((c, i) => `## Candidate ${(i + 1).toString()}\n\n${c.content.trim()}`)
    .join("\n\n---\n\n");
  const recentBlock =
    params.recentTail.length > 0
      ? `# Recent conversation\n\n${params.recentTail}\n\n`
      : "";
  return `# Current user message\n\n${params.userMessage.trim()}\n\n${filesLine}${recentBlock}# Candidate memories\n\n${candidatesBlock}`;
};

const purgeExpired = (now: number): void => {
  for (const [k, entry] of cache.entries()) {
    if (entry.expires <= now) cache.delete(k);
  }
};

export const runActiveMemoryRecall = async (
  params: ActiveMemoryRecallParams,
): Promise<ActiveMemoryRecallResult | null> => {
  if (isTrivialMessage(params.userMessage, params.attachedFiles)) return null;

  const key = cacheKey(params);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expires > now) return cached.result;

  let result: ActiveMemoryRecallResult | null = null;
  try {
    const query = buildRecallQuery(params);
    const search = await searchRAG({
      query,
      teamId: params.teamId,
      organizationId: params.organizationId,
      userId: params.userId,
      filters: { sourceTypes: ["memories"] },
      topK: TOP_K,
      // Multi-query reformulation adds ~1–3 s to first-token latency
      // before the agent even starts. Memories are terse and the judge
      // LLM below filters candidates for relevance anyway — that's the
      // precision safety net. Skip the extra recall sweep here.
      skipMultiQuery: true,
    });

    if (search.results.length === 0) {
      result = null;
    } else {
      const judgePrompt = buildJudgePrompt(
        params,
        search.results.map((r) => ({ content: r.content })),
      );
      const signals: AbortSignal[] = [AbortSignal.timeout(RECALL_TIMEOUT_MS)];
      if (params.abortSignal) signals.push(params.abortSignal);
      const judgeAbort = AbortSignal.any(signals);

      // Utility-tier model, honouring the team's pick (C8b) with a defensive
      // fall back to the code default.
      const activeMemoryModel = (
        await resolveModelForTeam("active-memory", params.teamId)
      ).model;
      const judged = await generateText({
        model: activeMemoryModel,
        system: ACTIVE_MEMORY_SYSTEM_PROMPT,
        prompt: judgePrompt,
        abortSignal: judgeAbort,
        // Recall judge generation. The caller wraps this in a
        // `propagateAttributes` session context (it runs pre-`execute`,
        // so it's a sibling trace rather than nested under `chatbot-turn`).
        experimental_telemetry: telemetryFor("active-memory"),
      });

      const text = judged.text.trim();
      if (text === "NONE" || text.length === 0) {
        result = null;
      } else {
        result = { block: text };
      }
    }
  } catch (err) {
    // Swallow — Active Memory must never break the main turn.
    console.warn(
      "[active-memory] recall failed, continuing without:",
      err instanceof Error ? err.message : String(err),
    );
    result = null;
  }

  if (cache.size >= CACHE_MAX_ENTRIES) purgeExpired(now);
  cache.set(key, { result, expires: now + CACHE_TTL_MS });

  return result;
};

/**
 * Render a `recentTail` slice from the conversation messages,
 * caller-owned. We expose this helper so handlers can build a
 * standardised tail (mirroring OpenClaw's `recentUserChars` /
 * `recentAssistantChars` envelope) without leaking the truncation
 * convention across the codebase.
 *
 * Takes the last 2 user turns + last 1 assistant turn from the
 * provided messages, truncates each per OpenClaw's per-turn caps,
 * and returns a chronological `User: … / Assistant: …` listing.
 */
export const buildActiveMemoryRecentTail = (
  messages: { role: "user" | "assistant" | "system"; text: string }[],
): string => {
  const userTurns: string[] = [];
  const assistantTurns: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "user" && userTurns.length < 2) {
      userTurns.unshift(m.text.slice(0, RECENT_USER_TURN_MAX_CHARS));
    } else if (m.role === "assistant" && assistantTurns.length < 1) {
      assistantTurns.unshift(m.text.slice(0, RECENT_ASSISTANT_TURN_MAX_CHARS));
    }
    if (userTurns.length === 2 && assistantTurns.length === 1) break;
  }

  const lines: string[] = [];
  for (const u of userTurns) lines.push(`User: ${u}`);
  for (const a of assistantTurns) lines.push(`Assistant: ${a}`);
  return lines.join("\n").slice(0, RECENT_TAIL_MAX_CHARS);
};
