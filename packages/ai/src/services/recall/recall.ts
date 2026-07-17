import { stampEpisodeRecall } from "@fretik/shared/services/episodes/stamp-recall";
import {
  anchorTextToRecords,
  type RecordAnchor,
} from "@fretik/shared/services/object-records/anchor";
import { generateText } from "ai";
import { telemetryFor } from "../../lib/langfuse";
import { resolveMemoryModel } from "../../lib/model-registry/team-model";
import { searchRAG } from "../search";
import { gatherGraphNeighborhood, type GraphNeighborhood } from "./graph";
import { RECALL_JUDGE_SYSTEM_PROMPT } from "./prompt";

/**
 * Unified pre-turn recall (P5) — the evolution of Active Memory.
 *
 * Before the main `streamText` call, gather memory candidates from EVERY
 * provenance in parallel, then have one utility-tier judge distill what is
 * relevant to the current message into a hidden `<active_memory>` block:
 *
 *   - `anchorTextToRecords` — deterministic record anchors (the free
 *     n-gram funnel), which seed the SQL graph neighborhood (1-hop links,
 *     recent events, episodes about those records).
 *   - `searchRAG(memories + episodes + records)` — working methods and
 *     preferences, distilled past conversations, semantic record cards.
 *   - `searchRAG(documents)` — uploaded content. Context and skills are
 *     excluded: their catalogues are already injected every turn.
 *
 * Agent-agnostic on purpose: the signature carries scope + message only,
 * so `/internal/agents/*\/invoke` (and future Trigger.dev workflow tasks)
 * inherit recall unchanged. `agentType` is telemetry metadata, not logic.
 *
 * The judge model never invents — it distills candidates, or returns
 * `NONE` (inject nothing; the agent can still `searchKnowledge` mid-turn).
 * Episodes the judge actually cites get `stampEpisodeRecall`'d
 * fire-and-forget — recall usage drives the L5 demotion GC.
 *
 * Failure semantics unchanged from Active Memory: every arm soft-fails to
 * empty, any error returns `null`. Recall must NEVER block the main turn.
 */

const TRIVIAL_REGEX =
  /^(ok|okay|merci|thanks|thx|👍|yes|no|oui|non|continue|please continue)\.?$/i;

/**
 * Cap the conversation tail we send to the judge (OpenClaw envelope:
 * 220 chars per user turn, 180 per assistant turn).
 */
const RECENT_TAIL_MAX_CHARS = 600;
const RECENT_USER_TURN_MAX_CHARS = 220;
const RECENT_ASSISTANT_TURN_MAX_CHARS = 180;

/** Per-recall hard timeout for the judge generation. */
const RECALL_TIMEOUT_MS = 15_000;

/**
 * Budget for the deterministic arms (anchor funnel, then graph SQL).
 * These are indexed set-based queries that normally run in tens of ms; the
 * race only fires on a genuinely degraded DB, where dropping the graph arm
 * beats delaying first-token latency.
 */
const ARM_TIMEOUT_MS = 2_500;

/**
 * In-memory result cache — same rationale as Active Memory: absorb
 * resumable-stream reconnects / rapid retries within the same turn.
 */
const CACHE_TTL_MS = 15_000;
const CACHE_MAX_ENTRIES = 500;

/** Deterministic anchors seeding the graph arm. */
const MAX_ANCHORS = 3;
/**
 * Graph-arm precision gate. The funnel's FTS stage matches spans against
 * the records' FIELD text, so a common phrase from the message ("de
 * prospection") hits every record whose fields contain it — fine for the
 * resolver (its LLM pass caps confidence), too loose to inject pre-turn.
 * Word-only FTS hits are dropped; digit-bearing ones stay (identifiers —
 * the "order #4512" path FTS exists for), and exact/alias/trigram stay
 * (all three match the record's NAME, trigram covering typos). Fuzzy
 * topical references still reach the judge via the semantic `records` arm.
 */
const anchorIsPrecise = (a: RecordAnchor): boolean =>
  a.matchType !== "fts" || /\d/.test(a.matchedText);
/** Top-K for the memories+episodes+records sweep. */
const KNOWLEDGE_TOP_K = 10;
/** Top-K for the documents sweep. */
const DOCUMENTS_TOP_K = 5;
/** Per-candidate clip — keeps the judge prompt ≤ ~12k chars worst case. */
const CANDIDATE_MAX_CHARS = 700;
/**
 * The block itself is ≤ ~500 tokens, but gpt-oss REASONING tokens count
 * toward this budget and a truncated completion loses the whole recall
 * (the eval suite showed medium/high effort silently collapsing to NONE
 * at 3 000 — the reasoning ate the budget before the answer started).
 * 10 000 makes truncation unreachable; cost is per-generated-token and
 * latency stays bounded by RECALL_TIMEOUT_MS.
 */
const JUDGE_MAX_OUTPUT_TOKENS = 10_000;
const JUDGE_TEMPERATURE = 0;
/**
 * Safety cap on the assembled block — above the prompt's ≤2000-char target so
 * a well-behaved block passes untouched; only a runaway judge output is
 * trimmed (`gateJudgeOutput`), never the primary quality bar.
 */
const HARD_BLOCK_CHAR_CAP = 2_400;

interface AttachedFile {
  filename: string;
  mimeType: string;
}

export interface UnifiedRecallParams {
  organizationId: string;
  teamId: string;
  /** Gates user-scope rows (private memories/episodes). Undefined = system. */
  userId?: string;
  conversationId?: string;
  /** Telemetry only — recall logic is agent-agnostic. */
  agentType: string;
  /** Current user message verbatim. */
  userMessage: string;
  /** Files attached to the current message (names only — no content). */
  attachedFiles: AttachedFile[];
  /** Pre-rendered recent conversation tail (≤ ~600 chars). Empty = first turn. */
  recentTail: string;
  abortSignal?: AbortSignal;
  /**
   * Skip the in-memory result cache — EVAL/BENCH ONLY. The cache absorbs
   * same-turn retries in prod; eval repeats of one message need fresh
   * gather+judge passes to measure stability.
   */
  bypassCache?: boolean;
  /**
   * Force the judge onto a specific registry profile under the SAME recall
   * envelope — EVAL/BENCH ONLY (the model bake-off). Undefined in prod, where
   * the `active-memory` code default (a `fixed` tier) always wins.
   */
  judgeProfileKey?: string;
}

export interface UnifiedRecallResult {
  /**
   * Sectioned FACTS/EPISODES/GRAPH block (≤2000 chars) ready for the
   * `{{activeMemoryBlock}}` placeholder.
   */
  block: string;
  /** Episodes the judge cited — already stamped, exposed for telemetry. */
  recalledEpisodeIds: string[];
}

interface CacheEntry {
  result: UnifiedRecallResult | null;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

const cacheKey = (params: UnifiedRecallParams): string => {
  const filesPart = params.attachedFiles
    .map((f) => `${f.filename}|${f.mimeType}`)
    .join(",");
  return `${params.teamId}:${params.userId ?? "system"}:${params.userMessage.slice(0, 200)}:${filesPart}`;
};

const purgeExpired = (now: number): void => {
  for (const [k, entry] of cache.entries()) {
    if (entry.expires <= now) cache.delete(k);
  }
};

const isTrivialMessage = (
  msg: string,
  attachments: AttachedFile[],
): boolean => {
  const trimmed = msg.trim();
  // Never skip when files are attached — pattern recall keys on
  // filename/mimetype even for a one-word command ("génère le CSV").
  if (attachments.length > 0) return false;
  if (trimmed.length >= 10) return false;
  return TRIVIAL_REGEX.test(trimmed);
};

/** Race an arm against its budget — soft-fail to the fallback either way. */
const withArmBudget = async <T>(
  work: Promise<T>,
  fallback: T,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[recall] ${label} arm timed out (${ARM_TIMEOUT_MS}ms)`);
      resolve(fallback);
    }, ARM_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      work.catch((err: unknown) => {
        console.warn(
          `[recall] ${label} arm failed:`,
          err instanceof Error ? err.message : err,
        );
        return fallback;
      }),
      budget,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const buildRecallQuery = (params: UnifiedRecallParams): string => {
  const parts: string[] = [params.userMessage.trim()];
  if (params.attachedFiles.length > 0) {
    const fileDesc = params.attachedFiles
      .map((f) => `${f.filename} (${f.mimeType})`)
      .join(", ");
    parts.push(`Attached: ${fileDesc}`);
  }
  return parts.join(" — ");
};

interface Candidate {
  /** Provenance marker the judge copies verbatim, e.g. `(episode:<id>)`. */
  marker: string;
  content: string;
}

/** `metadata` is `unknown` on candidates — read one string field safely. */
const metadataString = (metadata: unknown, key: string): string | null => {
  if (typeof metadata !== "object" || metadata === null) return null;
  const value: unknown = Reflect.get(metadata, key);
  return typeof value === "string" ? value : null;
};

/**
 * `As of YYYY-MM-DD` prefix for a dated candidate — the judge carries it into
 * the bullet so the agent can date the fact and pick the freshest of two
 * conflicting candidates. Empty when the candidate has no date.
 */
const asOfLine = (isoDate: string | null): string =>
  isoDate ? `As of ${isoDate.slice(0, 10)}\n` : "";

const renderCandidates = (title: string, candidates: Candidate[]): string => {
  if (candidates.length === 0) return "";
  const body = candidates
    .map((c) => `${c.marker}\n${c.content.slice(0, CANDIDATE_MAX_CHARS)}`)
    .join("\n\n");
  return `## ${title}\n\n${body}\n\n`;
};

/** Minimal structural view of a search hit — what the assembly reads. */
export interface RecallSearchHit {
  sourceType: string;
  sourceId: string;
  content: string;
  metadata: unknown;
}

export interface RecallGathered {
  anchors: RecordAnchor[];
  knowledgeResults: RecallSearchHit[];
  documentResults: RecallSearchHit[];
  graph: GraphNeighborhood | null;
}

/**
 * The parallel gather — every provenance arm, each soft-failing to empty.
 * Exported (with `buildJudgeInput`) so the recall bench/evals exercise the
 * exact production pipeline around a controlled judge call.
 */
export const gatherRecallCandidates = async (
  params: UnifiedRecallParams,
): Promise<RecallGathered> => {
  const query = buildRecallQuery(params);
  const [anchors, knowledge, documents] = await Promise.all([
    withArmBudget<RecordAnchor[]>(
      anchorTextToRecords({
        teamId: params.teamId,
        text: params.userMessage,
        maxAnchors: MAX_ANCHORS,
      }),
      [],
      "anchor",
    ),
    searchRAG({
      query,
      teamId: params.teamId,
      organizationId: params.organizationId,
      userId: params.userId,
      filters: { sourceTypes: ["memories", "episodes", "records"] },
      topK: KNOWLEDGE_TOP_K,
      // The judge is the precision filter; skip the multi-query
      // reformulation latency (~1-3s) on this pre-turn hot path.
      skipMultiQuery: true,
    }).catch(() => ({ results: [] })),
    searchRAG({
      query,
      teamId: params.teamId,
      organizationId: params.organizationId,
      userId: params.userId,
      filters: { sourceTypes: ["documents"] },
      topK: DOCUMENTS_TOP_K,
      skipMultiQuery: true,
    }).catch(() => ({ results: [] })),
  ]);

  // Graph neighborhood needs the anchors — second (still bounded) hop.
  const graph = await withArmBudget(
    gatherGraphNeighborhood({
      anchors: anchors.filter(anchorIsPrecise),
      userId: params.userId,
    }),
    null,
    "graph",
  );

  return {
    anchors,
    knowledgeResults: knowledge.results,
    documentResults: documents.results,
    graph,
  };
};

export interface JudgeInput {
  prompt: string;
  /** Episode ids actually offered — the stamping/citation allowlist. */
  episodeIdCandidates: Set<string>;
  /** True = nothing gathered anywhere; skip the judge call entirely. */
  empty: boolean;
}

/** Pure prompt assembly over the gathered candidates. */
export const buildJudgeInput = (
  params: UnifiedRecallParams,
  gathered: RecallGathered,
): JudgeInput => {
  const memories: Candidate[] = [];
  const episodes: Candidate[] = [];
  const records: Candidate[] = [];
  const docs: Candidate[] = [];
  const episodeIdCandidates = new Set<string>();
  // Graph-anchored episodes come first, WITH their summaries — an episode
  // about a record named in the message must never depend on the semantic
  // arm's top-K to reach the judge with substance.
  for (const ep of gathered.graph?.episodes ?? []) {
    episodeIdCandidates.add(ep.id);
    const linkedLine =
      ep.anchorLabels.length > 0
        ? `Linked records: ${ep.anchorLabels.join(", ")}\n`
        : "";
    episodes.push({
      marker: `(episode:${ep.id})`,
      content: `${linkedLine}${asOfLine(ep.occurredTo?.toISOString() ?? null)}${ep.title}\n${ep.summary}`,
    });
  }
  for (const r of gathered.knowledgeResults) {
    if (r.sourceType === "memories") {
      const path = metadataString(r.metadata, "path") ?? r.sourceId;
      memories.push({ marker: `(memory:${path})`, content: r.content });
    } else if (r.sourceType === "episodes") {
      if (episodeIdCandidates.has(r.sourceId)) continue; // already first-class
      episodeIdCandidates.add(r.sourceId);
      const dated = asOfLine(metadataString(r.metadata, "occurred_to"));
      episodes.push({
        marker: `(episode:${r.sourceId})`,
        content: `${dated}${r.content}`,
      });
    } else if (r.sourceType === "records") {
      records.push({ marker: `(record:${r.sourceId})`, content: r.content });
    }
  }
  for (const r of gathered.documentResults) {
    const name = metadataString(r.metadata, "file_name");
    docs.push({
      marker: `(document:${r.sourceId}${name ? ` "${name}"` : ""})`,
      content: r.content,
    });
  }

  const graph = gathered.graph;
  const hasGraph = graph !== null && graph.rendered.length > 0;
  const empty =
    memories.length === 0 &&
    episodes.length === 0 &&
    records.length === 0 &&
    docs.length === 0 &&
    !hasGraph;

  const filesLine =
    params.attachedFiles.length > 0
      ? `Attached files: ${params.attachedFiles.map((f) => `${f.filename} (${f.mimeType})`).join(", ")}\n\n`
      : "";
  const recentBlock =
    params.recentTail.length > 0
      ? `# Recent conversation\n\n${params.recentTail}\n\n`
      : "";
  const prompt =
    `# Current user message\n\n${params.userMessage.trim()}\n\n` +
    filesLine +
    recentBlock +
    `# Candidates\n\n` +
    renderCandidates("Working memories", memories) +
    renderCandidates("Past episodes", episodes) +
    renderCandidates("Records", records) +
    renderCandidates("Documents", docs) +
    (hasGraph
      ? `## Graph neighborhood (records whose NAME string-matched the message — the match can be coincidental, judge it against the message)\n\n${graph.rendered}\n\n`
      : "") +
    // Trailing reminders — the position small utility models obey best:
    // format discipline, the per-source inclusion contract, false-match
    // discrimination (mid-prompt versions of these were consistently skipped).
    // DELIBERATE REPETITION of RECALL_JUDGE_SYSTEM_PROMPT rules (prompt.ts) —
    // keep the two in sync when editing either.
    `Reply with exactly NONE when nothing overlaps the message. Otherwise reply with the sectioned block — the first line must be FACTS:, EPISODES:, or GRAPH:. Every source that overlaps gets its own bullet: a matching Working memory AND the entity's Records card in FACTS, an overlapping "Past episodes" in EPISODES (decisions and outcomes), a genuine anchor's graph line in GRAPH. Drop any match the message does not actually refer to (a name used as an ordinary word matches coincidentally; near-identical spellings are the same entity). Never answer the user message itself.`;

  return { prompt, episodeIdCandidates, empty };
};

/**
 * Structural gate over a raw judge completion: NONE / empty / anything that
 * doesn't OPEN with a section header is rejected (`null`) — a judge that
 * drifted into answering the user message must never be injected as system
 * context. Exported for the bench/evals.
 */
export const gateJudgeOutput = (raw: string): string | null => {
  const text = raw.trim();
  if (text === "NONE" || text.length === 0) return null;
  const isSectioned = /^(FACTS|EPISODES|GRAPH):/m.test(
    text.split("\n", 1)[0] ?? "",
  );
  if (!isSectioned) {
    console.warn(
      `[recall] judge output rejected (not sectioned): ${text.slice(0, 120)}`,
    );
    return null;
  }
  // The ≤2000-char budget is a prompt rule, not model-enforced. Cap a runaway
  // block on a line boundary so it can never bloat the system prompt — set
  // above the target so a normal ~2000-char block passes untouched and the
  // eval's own 2000 check still flags real drift.
  if (text.length > HARD_BLOCK_CHAR_CAP) {
    const clipped = text.slice(0, HARD_BLOCK_CHAR_CAP);
    const lastNewline = clipped.lastIndexOf("\n");
    console.warn(
      `[recall] judge output ${text.length.toString()} chars > ${HARD_BLOCK_CHAR_CAP.toString()}, trimmed`,
    );
    return lastNewline > 0 ? clipped.slice(0, lastNewline) : clipped;
  }
  return text;
};

export const runUnifiedRecall = async (
  params: UnifiedRecallParams,
): Promise<UnifiedRecallResult | null> => {
  if (isTrivialMessage(params.userMessage, params.attachedFiles)) return null;

  const key = cacheKey(params);
  const now = Date.now();
  const cached = params.bypassCache ? undefined : cache.get(key);
  if (cached && cached.expires > now) return cached.result;

  let result: UnifiedRecallResult | null = null;
  try {
    const gathered = await gatherRecallCandidates(params);
    const judgeInput = buildJudgeInput(params, gathered);

    if (judgeInput.empty) {
      result = null;
    } else {
      const signals: AbortSignal[] = [AbortSignal.timeout(RECALL_TIMEOUT_MS)];
      if (params.abortSignal) signals.push(params.abortSignal);
      const judgeAbort = AbortSignal.any(signals);

      // Utility-tier model, honouring the team's pick (C8b); role + trace
      // names keep their historical `active-memory` identity. The eval-only
      // `judgeProfileKey` forces a specific profile under the same envelope
      // for the model bake-off; prod leaves it undefined.
      const judgeModel = (
        await resolveMemoryModel(
          "active-memory",
          params.teamId,
          params.judgeProfileKey,
        )
      ).model;
      const judged = await generateText({
        model: judgeModel,
        instructions: RECALL_JUDGE_SYSTEM_PROMPT,
        prompt: judgeInput.prompt,
        temperature: JUDGE_TEMPERATURE,
        maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
        abortSignal: judgeAbort,
        telemetry: telemetryFor("active-memory"),
      });

      if (judged.finishReason === "length") {
        // Reasoning ate the whole output budget — the gate below turns
        // the truncated text into a safe NONE, but surface it: repeated
        // warnings mean the budget or the effort level needs revisiting.
        console.warn(
          `[recall] judge output truncated at ${JUDGE_MAX_OUTPUT_TOKENS.toString()} tokens (finishReason=length)`,
        );
      }
      const text = gateJudgeOutput(judged.text);
      if (text === null) {
        result = null;
      } else {
        // Only ids that were actually offered count as recalled — the
        // judge can't stamp an invented episode.
        const cited = new Set<string>();
        for (const match of text.matchAll(/\(episode:([^)\s]+)\)/g)) {
          const id = match[1];
          if (id !== undefined && judgeInput.episodeIdCandidates.has(id)) {
            cited.add(id);
          }
        }
        const recalledEpisodeIds = [...cited];
        if (recalledEpisodeIds.length > 0) {
          // Fire-and-forget — recall stats drive the L5 demotion GC, and
          // a failed stamp must never delay the turn.
          void stampEpisodeRecall(recalledEpisodeIds).catch((err: unknown) => {
            console.warn(
              "[recall] episode stamp failed:",
              err instanceof Error ? err.message : err,
            );
          });
        }
        result = { block: text, recalledEpisodeIds };
      }
    }
  } catch (err) {
    // Swallow — recall must never break the main turn.
    console.warn(
      "[recall] failed, continuing without:",
      err instanceof Error ? err.message : String(err),
    );
    result = null;
  }

  if (cache.size >= CACHE_MAX_ENTRIES) purgeExpired(now);
  cache.set(key, { result, expires: now + CACHE_TTL_MS });

  return result;
};

/**
 * Render a `recentTail` slice from the conversation messages, caller-owned
 * (last 2 user turns + last assistant turn, per-turn caps, chronological).
 * Exposed so handlers share one truncation convention.
 */
export const buildRecallRecentTail = (
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
