import { pruneWebToolsIfUnavailable } from "../../lib/web-egress";
import { createAskUserQuestionWorkflowTool } from "../../tools/ask-user/workflow";
import { createCompleteTaskTool } from "../../tools/complete-task";
import type { createDispatchAgentTool } from "../../tools/dispatch-agent";
import { buildCoreTools, buildDomainTools } from "../chatbot/tools";
import { buildChatbotTool } from "../shared/chatbot-tool";

/**
 * Workflow executor tool set — chatbot parity minus the interactive-only
 * tools, plus the progression tool and a BLOCKING askUserQuestion:
 *
 * - `askUserQuestion` — the chat (non-blocking) variant OUT; a BLOCKING
 *   variant IN (`tools/ask-user/workflow.ts`): it parks the run on a
 *   `question` approval and the answer arrives substituted on resume.
 * - `createSkill` / `updateSkill` OUT — both return drafts a user must
 *   confirm in chat; meaningless headless.
 * - `manageObjectType` / `manageField` OUT — hard gate behind the prompt
 *   rule: a run never changes the team's schema. Excluding them from the
 *   registry means the model has no schema for them, period.
 * - `manageWorkflow` OUT — a run never builds or launches workflows
 *   (anti-recursion); the builder lives in the chat only.
 * - `completeTask` IN (core) — the ONLY progression mechanism; see
 *   `tools/complete-task.ts`.
 *
 * Progressive Disclosure is kept: domain tools stay deferred behind
 * `searchTools`, and the playbook's `toolHints` are pre-activated per call
 * by the agent's `onRuntimeContext` hook (see `./index.ts`).
 */
export const buildWorkflowTools = (extras: {
  dispatchAgent: ReturnType<typeof createDispatchAgentTool>;
}) => {
  const {
    manageObjectType: _manageObjectType,
    manageField: _manageField,
    createSkill: _createSkill,
    updateSkill: _updateSkill,
    manageWorkflow: _manageWorkflow,
    ...domainTools
  } = buildDomainTools({ pageAuthoring: false });
  const { askUserQuestion: _askUserQuestion, ...coreTools } =
    buildCoreTools(domainTools);
  // The domain tools destructured out above are the canonical
  // `WORKFLOW_FORBIDDEN_DOMAIN_TOOLS` (see `../shared/workflow-tool-gate`): a
  // run never edits schema, drafts skills, or builds workflows. Keep the two
  // lists in sync — sub-agents prune the same names by string.
  //
  // `pageAuthoring: false` extends that same doctrine to pages: a run reads,
  // retouches and publishes one, but never AUTHORS one. Authoring lives behind
  // `buildPage`, which is a chat-agent tool — so this is a real capability a
  // run no longer has, and it is the intended shape: a durable artifact of the
  // workspace gets designed by a person's request, not by a cron tick.
  //
  // Web tools stay in by default; `pruneWebToolsIfUnavailable` only honours
  // the operator kill switch, which headless runs would otherwise ignore.
  return {
    ...pruneWebToolsIfUnavailable({ ...coreTools, ...domainTools }),
    dispatchAgent: extras.dispatchAgent,
    // Blocking variant — creates a `question` approval and pauses the run.
    askUserQuestion: buildChatbotTool({
      ...createAskUserQuestionWorkflowTool(),
      category: "core",
      searchHint:
        "ask user question decision choice clarify pause wait approval human",
      // Creates a pending `question` approval row — not read-only.
      isReadOnly: false,
    }),
    completeTask: buildChatbotTool({
      ...createCompleteTaskTool(),
      category: "core",
      searchHint:
        "complete close finish current playbook task advance next step progress",
      // Result is the next task's instructions — always small.
      // Mutates workflow_runs.task_states — not read-only.
      isReadOnly: false,
    }),
  };
};

export type WorkflowTools = ReturnType<typeof buildWorkflowTools>;

/**
 * The tool names a workflow playbook's `toolHints` may reference — the
 * workflow registry's core + domain tools (the forbidden schema/meta/builder
 * tools excluded, same as `buildWorkflowTools`). Used by `manageWorkflow` to
 * reject a hint that names a non-existent or forbidden tool at author time,
 * instead of silently no-op'ing at run time. Memoized: the registry shape is
 * fixed per process. Computed WITHOUT `dispatchAgent` (names only).
 */
let cachedHintNames: ReadonlySet<string> | undefined;
export const workflowToolHintNames = (): ReadonlySet<string> => {
  if (cachedHintNames) return cachedHintNames;
  const {
    manageObjectType: _manageObjectType,
    manageField: _manageField,
    createSkill: _createSkill,
    updateSkill: _updateSkill,
    manageWorkflow: _manageWorkflow,
    ...domainTools
  } = buildDomainTools({ pageAuthoring: false });
  const { askUserQuestion: _askUserQuestion, ...coreTools } =
    buildCoreTools(domainTools);
  cachedHintNames = new Set<string>([
    ...Object.keys(coreTools),
    ...Object.keys(domainTools),
    "dispatchAgent",
    "askUserQuestion",
    "completeTask",
  ]);
  return cachedHintNames;
};
