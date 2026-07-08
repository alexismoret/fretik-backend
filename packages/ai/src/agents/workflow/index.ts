import { approvalPendingId } from "@fretik/shared/services/ai/approval-pending";
import { stepCountIs, type PrepareStepFunction, type StopCondition } from "ai";
import { z } from "zod";
import {
  resolveChatModelForProfile,
  resolveModel,
  type ResolvedModel,
} from "../../lib/model-registry/resolve";
import {
  buildChatbotRuntimeContextBase,
  ChatbotCallOptionsSchema,
  dispatchAgentTool,
} from "../chatbot";
import {
  buildAgentSet,
  type AgentRuntimeContextBase,
  type AgentSet,
} from "../shared/agent-builder";
import type { SearchableToolRegistry } from "../shared/chatbot-tool";
import { buildWorkflowSystemPrompt } from "../shared/prompt-renderer";
import {
  getRuntimeContext,
  type AgentRuntimeContext,
} from "../shared/runtime-context";
import { workflowMainHiddenToolNames } from "../shared/workflow-tool-gate";
import { workflowRepairToolCall } from "./repair-tool-call";
import { buildWorkflowTools, type WorkflowTools } from "./tools";

/**
 * Workflow executor agent — the chatbot's headless sibling. Same
 * `buildAgentSet` machinery, chatbot-parity tools (see `./tools.ts`), the
 * unified prompt's `workflow` variant, and one structural difference: the
 * turn is a CHECKPOINT unit (the Trigger.dev orchestrator loops turns until
 * the playbook is exhausted), so the step budget below is persistence
 * granularity, not an autonomy limit.
 */

/**
 * Steps per turn — a runaway SAFETY VALVE, not a checkpoint granularity. The
 * real turn boundary is a natural pause (an approval/question, or the playbook
 * exhausted); a turn runs uninterrupted until then. Chopping a turn at a low
 * step count forced a full prompt-cache miss at every boundary, so the cap is
 * high. Tunable via `WORKFLOW_TURN_MAX_STEPS` (default 50, range [1, 100]).
 */
const parseWorkflowTurnMaxSteps = (): number => {
  const raw = process.env.WORKFLOW_TURN_MAX_STEPS;
  if (raw === undefined || raw === "") return 50;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(
      `Invalid WORKFLOW_TURN_MAX_STEPS: "${raw}" — expected an integer in [1, 100].`,
    );
  }
  return parsed;
};

/**
 * How often (in steps) to re-anchor the model on the playbook mid-turn. With
 * long turns the goal drifts out of recent attention; every K steps a compact
 * generic reminder is appended at the context tail. Kept append-only so the
 * accumulated history stays a byte-identical prefix (prompt cache intact).
 * Tunable via `WORKFLOW_REANCHOR_EVERY_STEPS` (default 10, range [1, 100]).
 */
const parseReanchorEverySteps = (): number => {
  const raw = process.env.WORKFLOW_REANCHOR_EVERY_STEPS;
  if (raw === undefined || raw === "") return 10;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(
      `Invalid WORKFLOW_REANCHOR_EVERY_STEPS: "${raw}" — expected an integer in [1, 100].`,
    );
  }
  return parsed;
};

/**
 * Compact generic re-anchor injected mid-turn. Deliberately NAMES no task —
 * `completeTask` may have advanced the cursor since the turn opened, so a
 * task-specific reminder could be stale. The live cursor is already in the
 * steering message at the head of the turn.
 */
const REANCHOR_TEXT =
  "Re-read the playbook in `<workflow_context>` and stay on the current open task. Call `completeTask` the moment its expected output exists, then continue to the next task in the same turn.";

/**
 * Hard per-step output cap. Bounds a single runaway generation (the incident
 * burned 64,829 output tokens in one step). Safe: truncated pure text ends the
 * loop cleanly and resumes next turn; a truncated tool-call is healed by
 * `workflowRepairToolCall`. Tunable via `WORKFLOW_STEP_MAX_OUTPUT_TOKENS`
 * (default 16000, range [1000, 64000]).
 */
const parseWorkflowStepMaxOutputTokens = (): number => {
  const raw = process.env.WORKFLOW_STEP_MAX_OUTPUT_TOKENS;
  if (raw === undefined || raw === "") return 16_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 64_000) {
    throw new Error(
      `Invalid WORKFLOW_STEP_MAX_OUTPUT_TOKENS: "${raw}" — expected an integer in [1000, 64000].`,
    );
  }
  return parsed;
};

export const WorkflowCallOptionsSchema = ChatbotCallOptionsSchema.extend({
  /** The `workflow_runs` row this turn executes. */
  workflowRunId: z.uuid(),
  /** The run's write-autonomy mode (gates tools + the run_plan path). */
  workflowAutonomy: z.enum(["read_only", "approval_required", "autonomous"]),
  /**
   * Rendered `{{playbookBlock}}` fragment — goal, autonomy, trigger payload,
   * and the task list with live statuses. Built by the turn handler from the
   * run row.
   */
  playbookBlock: z.string(),
  /**
   * Domain-tool names hinted by the playbook (`tasks[].toolHints`), union
   * across tasks. Pre-activated on the DynamicToolManager at call time so
   * hinted tools are live from step 0 — reliability without paying the full
   * catalogue's schemas.
   */
  toolHints: z.array(z.string()).optional(),
});

export type WorkflowCallOptions = z.infer<typeof WorkflowCallOptionsSchema>;

const buildWorkflowRuntimeContextBase = (
  options: WorkflowCallOptions,
): AgentRuntimeContextBase => ({
  ...buildChatbotRuntimeContextBase(options),
  agentKey: `workflow:${options.workflowRunId}`,
  workflowRunId: options.workflowRunId,
  workflowAutonomy: options.workflowAutonomy,
  playbookBlock: options.playbookBlock,
});

/** Mirror of the chatbot's domain-registry picker, typed on WorkflowTools. */
const domainRegistryCache = new WeakMap<
  WorkflowTools,
  SearchableToolRegistry
>();
const pickDomainRegistry = (tools: WorkflowTools): SearchableToolRegistry => {
  const cached = domainRegistryCache.get(tools);
  if (cached) return cached;
  const domainTools: SearchableToolRegistry = {};
  for (const [name, t] of Object.entries(tools)) {
    if (t.category === "domain") {
      domainTools[name] = {
        description: t.description,
        searchHint: t.searchHint,
        category: t.category,
      };
    }
  }
  domainRegistryCache.set(tools, domainTools);
  return domainTools;
};

const workflowSystemPrompt = (
  ctx: AgentRuntimeContext,
  tools: WorkflowTools,
): Promise<string> => {
  const registry = pickDomainRegistry(tools);
  // Don't advertise a gated write tool in `<domain_tools>` — the run can't
  // activate it (searchTools + step-gate withhold it), so listing it as
  // searchable only tempts a wasted turn. Stable per run (autonomy is fixed).
  const hidden = ctx.workflowAutonomy
    ? workflowMainHiddenToolNames(ctx.workflowAutonomy)
    : undefined;
  const deferred =
    hidden === undefined
      ? registry
      : Object.fromEntries(
          Object.entries(registry).filter(([name]) => !hidden.has(name)),
        );
  return buildWorkflowSystemPrompt(ctx, deferred);
};

/**
 * Progressive Disclosure + autonomy gate. Same per-step recompute as the
 * chatbot (`core + activated domain tools`), with the write gate layered on:
 *  - `read_only` — withhold every write tool (`manageRecord`/`manageLink`/
 *    `memory`); the run only reads.
 *  - `approval_required` — withhold the direct object-write tools
 *    (`manageRecord`/`manageLink`) so writes go through the gated Python SDK
 *    (`records.bulk_*`, which pauses on a `record_write` approval); `memory` stays.
 *  - `autonomous` — full tool set (direct writes).
 * A hard gate, not a prompt suggestion.
 */
const workflowPrepareStep = (
  tools: WorkflowTools,
): PrepareStepFunction<WorkflowTools> => {
  const isToolName = (name: string): name is keyof WorkflowTools =>
    name in tools;
  const coreNames: (keyof WorkflowTools)[] = [];
  for (const [name, t] of Object.entries(tools)) {
    if (t.category === "core" && isToolName(name)) coreNames.push(name);
  }
  const reanchorEvery = parseReanchorEverySteps();

  return (stepContext) => {
    const ctx = getRuntimeContext(stepContext);
    const activatedDomainNames = ctx.dynamicToolManager
      .getSnapshot()
      .filter(isToolName);
    const active = [...coreNames, ...activatedDomainNames];
    // `workflowAutonomy` is always set for this agent (required in call
    // options); the guard just satisfies the optional context type.
    const activeTools =
      ctx.workflowAutonomy === undefined
        ? active
        : active.filter(
            (n) => !workflowMainHiddenToolNames(ctx.workflowAutonomy!).has(n),
          );
    // Append-only re-anchor every K steps — a byte-stable prefix (the real
    // accumulated messages) plus a tiny tail the model re-reads this step
    // only. Never insert mid-history (that shifts every later token → cache
    // bust). stepNumber 0 is the turn's first step (already re-pinned by the
    // steering message), so start at the first multiple past it.
    if (
      stepContext.stepNumber > 0 &&
      stepContext.stepNumber % reanchorEvery === 0
    ) {
      return {
        activeTools,
        messages: [
          ...stepContext.messages,
          { role: "user", content: REANCHOR_TEXT },
        ],
      };
    }
    return { activeTools };
  };
};

/**
 * End the turn when any tool parks on an approval — `python` (a `run_plan`
 * plan or a gated `records.bulk_*` write) or the workflow `askUserQuestion`.
 * Matched by output SHAPE (`approvalPendingId`), never by tool name, so every
 * kind stops the turn; the orchestrator then parks the run on a wait token and
 * the loop resumes after the decision.
 */
const anyToolAwaitingApproval: StopCondition<WorkflowTools> = ({ steps }) => {
  const lastStep = steps.at(-1);
  if (lastStep === undefined) return false;
  return lastStep.toolResults.some(
    (tr) => approvalPendingId(tr.output) !== null,
  );
};

const makeWorkflowAgentSet = (
  model: ResolvedModel,
): AgentSet<WorkflowCallOptions, WorkflowTools> =>
  buildAgentSet<WorkflowCallOptions, WorkflowTools>({
    id: "workflow",
    buildTools: () => buildWorkflowTools({ dispatchAgent: dispatchAgentTool }),
    systemPrompt: workflowSystemPrompt,
    model,
    fallbackModel: resolveModel("chat-fallback"),
    stopWhen: [
      stepCountIs(parseWorkflowTurnMaxSteps()),
      anyToolAwaitingApproval,
    ],
    maxOutputTokens: parseWorkflowStepMaxOutputTokens(),
    repairToolCall: workflowRepairToolCall,
    prepareStep: workflowPrepareStep,
    buildRuntimeContextBase: buildWorkflowRuntimeContextBase,
    onRuntimeContext: (ctx, options) => {
      if (options.toolHints !== undefined && options.toolHints.length > 0) {
        // Pre-activate the playbook-declared tools at step 0 — but never a
        // gated one, so the session snapshot never advertises a withheld
        // write tool as callable (matches the step-gate + searchTools).
        const hidden = workflowMainHiddenToolNames(options.workflowAutonomy);
        const hints = options.toolHints.filter((h) => !hidden.has(h));
        if (hints.length > 0) ctx.dynamicToolManager.activate(hints);
      }
    },
    callOptionsSchema: WorkflowCallOptionsSchema,
  });

/** Per-replica memoization, one set per serving profile — mirrors
 * `getChatbotAgentSet`. No key → the `workflow` role binding. */
const workflowAgentSets = new Map<
  string,
  AgentSet<WorkflowCallOptions, WorkflowTools>
>();

export const getWorkflowAgentSet = (
  profileKey?: string,
): AgentSet<WorkflowCallOptions, WorkflowTools> => {
  const resolved =
    profileKey === undefined
      ? resolveModel("workflow")
      : resolveChatModelForProfile(profileKey);
  const key = resolved.profile.key;
  const cached = workflowAgentSets.get(key);
  if (cached) return cached;
  const set = makeWorkflowAgentSet(resolved);
  workflowAgentSets.set(key, set);
  return set;
};
