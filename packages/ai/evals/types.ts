/**
 * Shared types for the Fretik chatbot eval harness.
 *
 * NOT a test — this is the Phase 10 live-LLM eval rig. See `run.ts`
 * for the entry-point docblock with env setup + invocation.
 */

/**
 * One tool invocation observed on the UIMessage stream. `latencyMs`
 * is the wall-clock delta between the `tool-input-available` frame
 * (tool call dispatched) and the `tool-output-available` frame
 * (tool finished). This is the tool's own execution time — it does
 * NOT include the surrounding model-reasoning tokens that decided
 * when to call it or what to do with the output.
 */
export interface ToolCallTrace {
  name: string;
  input: unknown;
  output: unknown;
  /**
   * Wall-clock timestamp (ms since epoch) when the
   * `tool-input-available` SSE frame arrived — i.e. the moment the
   * model dispatched the call. Exposed so assertions can detect
   * parallel tool calls by checking whether two tools' execution
   * windows overlap.
   */
  startedAtMs?: number;
  latencyMs?: number;
}

/**
 * Raw outcome of a single `/internal/agents/chatbot/invoke` call.
 * `http-client.ts` produces this; every assertion operates on it.
 *
 * Latency breakdown:
 *   - `latencyMs` = total wall-clock of the turn (HTTP round-trip +
 *     the entire SSE stream drain).
 *   - `toolLatencyMs` = sum of each tool's own execution time (from
 *     `toolCalls[i].latencyMs`). Approximate — tools that overlap in
 *     time (parallel tool calls) are double-counted.
 *   - `modelLatencyMs` = `latencyMs - toolLatencyMs`, i.e. everything
 *     NOT spent inside a tool execution: reasoning tokens, token
 *     streaming, provider routing overhead. Clamped to ≥0.
 */
export interface InvokeResult {
  text: string;
  toolCalls: ToolCallTrace[];
  finishReason?: string;
  latencyMs: number;
  toolLatencyMs: number;
  modelLatencyMs: number;
  /**
   * Number of agent-loop steps in the turn, counted from `start-step`
   * SSE frames. One step = one model generation (possibly with tool
   * calls). Feeds the `steps-used` mechanical score.
   */
  stepsUsed?: number;
  /**
   * Which agent actually answered (`"primary"` | `"fallback"`), from
   * the finish-frame telemetry. During a candidate-profile run a
   * silent failover serves the FALLBACK model — such cases must be
   * flagged, not scored as the candidate.
   */
  servedBy?: string;
  /** Registry profile key that served the turn (finish-frame telemetry). */
  modelProfileKey?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  httpStatus?: number;
  error?: string;
  /**
   * Langfuse trace id of the server-side `chatbot-turn` (from the SSE
   * `langfuseTraceId` message metadata). Lets the experiment fetch the
   * turn's exact agent cost (`api.trace.get(...).totalCost`).
   */
  traceId?: string;
}

/**
 * Runtime context surfaced to `seed` hooks and `custom` assertions.
 * Lets a case pre-seed memory rows or read DB state after the turn
 * without leaking globals — `conversationId` is the disposable row
 * the harness created for the case.
 */
export interface EvalCaseContext {
  conversationId: string;
  teamId: string;
  organizationId: string;
  /** Resolved from `EVAL_USER_ID` env var (string) or undefined. */
  userId: string | undefined;
}

/**
 * One assertion applied to an `InvokeResult`. Each variant stays
 * deliberately simple — the harness evaluates them sequentially and
 * aggregates into a single pass/fail per case.
 *
 *   - `contains`    substring/regex match on the assistant text
 *   - `toolUsed`    one of the listed tool names must have been called
 *   - `toolNotUsed` none of the listed tool names may have been called
 *   - `latencyUnder` wall-clock cap in ms
 *   - `noError`     `error` must be unset and `finishReason !== "error"`
 *   - `judge`       LLM-as-judge with a rubric string (graded verdict,
 *                   partial credit; see `evals/judge.ts`)
 *   - `custom`      escape hatch: user-supplied
 *                   `(result, ctx) => boolean | string | Promise<...>`
 *                   returning `true` passes; `false` / a reason string fails.
 *                   `ctx` carries the conversationId + IDs so the assertion
 *                   can inspect DB state via `@fretik/shared/db` if needed.
 */
export type Assertion =
  | { type: "contains"; value: string; caseInsensitive?: boolean }
  | { type: "regex"; value: string; flags?: string }
  | { type: "toolUsed"; tools: string[]; mode?: "any" | "all" }
  | { type: "toolNotUsed"; tools: string[] }
  | { type: "latencyUnder"; ms: number }
  | { type: "noError" }
  | { type: "judge"; rubric: string; expectPass?: boolean }
  | {
      type: "custom";
      name: string;
      fn: (
        result: InvokeResult,
        ctx: EvalCaseContext,
      ) => boolean | string | Promise<boolean | string>;
    };

/**
 * Coarse capability bucket a case exercises. Used to STRATIFY the
 * Langfuse dataset + the baseline (accuracy per capability), so a
 * regression in one capability is visible even when the overall score
 * holds. Assigned per curated case in `evals/curation.ts` (the triage
 * gate output), NOT on the case object.
 *
 * Single source of truth: per-capability run scores
 * (`correctness:<capability>`) and the CLI `--capability` filter both
 * derive from this const — adding a value here is the whole change.
 * The C3 additions stratify the model-gate suites: `tool-use`
 * (tool-portability + parallel probes), `instruction-following`
 * (mechanical-validator cases + structured-output probes),
 * `long-context` (near-compaction fixtures).
 */
export const CAPABILITIES = [
  "extraction",
  "generation",
  "external-actions",
  "reasoning",
  "tool-use",
  "instruction-following",
  "long-context",
  "security",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Optional efficiency envelope a case can declare. Scored as INFORMATIONAL
 * tool-efficiency signals (`tool-budget-overage`), NEVER folded into
 * `correctness` — a turn that exceeds the budget but answers correctly
 * still passes (Anthropic: grade the outcome, report efficiency apart).
 * Calibrate loosely: the budget flags over-calling, it does not punish
 * legitimate exploration. See `evals/tool-efficiency.ts`.
 */
export interface CaseBudget {
  /** Soft ceiling on total tool calls for the turn. */
  maxToolCalls?: number;
  /** Tool names a good trajectory stays within (off-list calls are flagged). */
  expectedTools?: readonly string[];
}

export interface EvalCase {
  id: string;
  description: string;
  prompt: string;
  /** Optional per-case tags, surfaced as metadata on the Langfuse dataset item. */
  tags?: string[];
  /**
   * Optional tool-calling efficiency envelope (informational scores only).
   * See `CaseBudget` + `evals/tool-efficiency.ts`.
   */
  budget?: CaseBudget;
  /**
   * Filenames (relative to `evals/fixtures/`) to copy into the
   * conversation's sandbox + register in `ai_chat_files` + attach as
   * `file` parts on the seeded user message BEFORE the /invoke call.
   * Enables tests that need a real PDF / XLSX / image on disk. OCR
   * sidecars (`<stem>.md`) and the `hasMarkdown` flag are inferred
   * automatically when a sibling `.md` sits next to the fixture.
   * See `evals/conversation-lifecycle.ts::seedFixtureFiles` and
   * `evals/fixtures/README.md` for the on-disk layout.
   */
  fixtures?: string[];
  /**
   * Optional pre-turn DB seed. Runs AFTER `createEphemeralConversation`
   * has provisioned the disposable conversation but BEFORE the
   * `/invoke` HTTP call. Receives the same `EvalCaseContext` that
   * `custom` assertions get, so a case can insert memory rows the
   * agent will then read during its turn.
   *
   * Failures here abort the case (it cannot meaningfully run without
   * its seed) and surface as a single error result in the report.
   */
  seed?: (ctx: EvalCaseContext) => Promise<void>;
  /**
   * Optional post-turn DB cleanup. Runs in the `finally` block AFTER
   * the assertions have been evaluated, BEFORE
   * `destroyEphemeralConversation`. The eval team is shared across
   * runs — without an explicit cleanup, seeded memories pile up and
   * pollute future runs (and a fresh conversation's manifest).
   *
   * Errors are caught + logged so a bad cleanup never aborts the
   * report. Use it to delete only rows the case is responsible for
   * (seeded paths + memories tagged with the current
   * `conversationId`).
   */
  cleanup?: (ctx: EvalCaseContext) => Promise<void>;
  assertions: Assertion[];
}

export interface EvalSuite {
  name: string;
  /** Short description shown in the report header. */
  summary: string;
  cases: EvalCase[];
}

export interface AssertionResult {
  type: Assertion["type"];
  label: string;
  passed: boolean;
  message?: string;
  /**
   * Graded score in [0, 1]. Deterministic assertions emit 1 (pass) / 0
   * (fail); a `judge` assertion emits the judge's partial-credit score
   * (1 / 0.5 / 0). Consumed by `evals/langfuse/evaluators.ts` to compute
   * the `correctness` experiment score with partial credit.
   */
  score?: number;
}

export interface CaseResult {
  caseId: string;
  suiteName: string;
  description: string;
  prompt: string;
  passed: boolean;
  invoke: InvokeResult;
  assertions: AssertionResult[];
}

// Eval results are recorded as Langfuse dataset runs (see
// `evals/langfuse/`). `CaseResult` above is the per-case shape the runner
// returns; aggregation + reporting live in the Langfuse UI, not in a local
// report type.
