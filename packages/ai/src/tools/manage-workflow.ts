import db from "@fretik/shared/db";
import { readSessionFile } from "@fretik/shared/lib/chatbot-session-storage";
import {
  OBJECT_COLOR_TOKENS,
  isValidObjectColor,
} from "@fretik/shared/lib/colors/object-colors";
import { isValidIcon } from "@fretik/shared/lib/icons/search";
import { describeFormFieldsForAgent } from "@fretik/shared/schemas/workflow-forms";
import {
  buildTriggerCatalog,
  describeTriggerConfigForAgent,
} from "@fretik/shared/schemas/workflow-triggers";
import {
  type CreateWorkflowInput,
  type UpdateWorkflowInput,
  WorkflowPlaybookSchema,
  WorkflowTriggerConfigSchema,
  workflowAutonomySchema,
  workflowTriggerTypeSchema,
} from "@fretik/shared/schemas/workflows";
import { isOrgAdmin } from "@fretik/shared/services/organization/member-role";
import { activateWorkflow } from "@fretik/shared/services/workflows/activate";
import type { RunAttachment } from "@fretik/shared/services/workflows/attach-run-files";
import { countTestRuns } from "@fretik/shared/services/workflows/count-test-runs";
import { createWorkflow } from "@fretik/shared/services/workflows/create";
import { createWorkflowRun } from "@fretik/shared/services/workflows/create-run";
import {
  getWorkflow,
  getWorkflowRow,
} from "@fretik/shared/services/workflows/get";
import { getWorkflowRun } from "@fretik/shared/services/workflows/get-run";
import { hasSuccessfulRun } from "@fretik/shared/services/workflows/has-successful-run";
import { listWorkflows } from "@fretik/shared/services/workflows/list";
import { pauseWorkflow } from "@fretik/shared/services/workflows/pause";
import { updateWorkflow } from "@fretik/shared/services/workflows/update";
import type { WorkflowRequester } from "@fretik/shared/services/workflows/visibility";
import { tool } from "ai";
import { z } from "zod";
import { listConversationFiles } from "../agents/shared/fragments";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { workflowToolHintNames } from "../agents/workflow/tools";
import { WORKSPACE_DIRS } from "../lib/conversation-storage";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";
import { materializeRunOutputs } from "../services/workflow-runs/materialize-run-outputs";

/**
 * Test runs of one workflow the builder may launch from one conversation
 * before it has to bring the user in. Five rounds is already well past the
 * point where the agent is learning something new from the next run.
 */
const MAX_TEST_RUNS_PER_CONVERSATION = 5;

/** Conversation attachments named on a `run_test` result before the tail is summarised. */
const HELD_BACK_FILES_LISTED = 5;

/** A `list` entry states what the workflow does, not its whole playbook. */
const LISTING_DESCRIPTION_CHARS = 200;
const truncateForListing = (text: string): string =>
  text.length > LISTING_DESCRIPTION_CHARS
    ? `${text.slice(0, LISTING_DESCRIPTION_CHARS).trimEnd()}…`
    : text;

/**
 * `attachments/<name>` → `<name>`. The workspace path is what every other tool
 * and the `<file_attachments>` block speak; `ai_chat_files.filename` and a form
 * payload speak basenames. Applied on BOTH sides of `run_test` — normalising
 * only `files` still rejected the payload, which cost a wasted round-trip on
 * the first `run_test` of the 2026-07-28 session.
 */
export const toAttachmentBasename = (name: string): string =>
  name.startsWith(`${WORKSPACE_DIRS.attachments}/`)
    ? name.slice(WORKSPACE_DIRS.attachments.length + 1)
    : name;

type WorkflowRow = NonNullable<Awaited<ReturnType<typeof getWorkflowRow>>>;

interface PreparedRunLaunch {
  payload: Record<string, unknown>;
  attachments: RunAttachment[];
  notHandedOver: string[];
}

/**
 * Resolve what a run launched from this chat receives: the conversation
 * attachments it is handed, and a trigger payload that names them the way the
 * run's own workspace will. Shared by `run_test` and `run` — both launch the
 * same machine, they only differ in what a failure costs.
 *
 * Returns a tool error (never throws) when a named file is unreadable or a
 * required form file field is unsatisfied.
 */
const prepareRunLaunch = async (params: {
  row: WorkflowRow;
  conversationId: string | undefined;
  files: string[] | undefined;
  payload: Record<string, unknown> | undefined;
}): Promise<PreparedRunLaunch | ReturnType<typeof toolError>> => {
  const { row, conversationId } = params;

  // The run executes in its own fresh conversation and sees ONLY files
  // attached to it here — chat attachments never carry over by themselves.
  // `ai_chat_files.filename` is a bare basename, but every OTHER tool — and
  // the `<file_attachments>` block itself — speaks `attachments/<name>`.
  // Rejecting that form cost one wasted call on the first run_test of a prod
  // session; accept both.
  const fileNames = (params.files ?? []).map(toAttachmentBasename);
  const attachments: RunAttachment[] = [];
  if (fileNames.length > 0) {
    if (!conversationId) {
      return toolError(
        TOOL_ERROR_CODES.NO_CONVERSATION,
        "files requires an active conversation to read attachments from.",
      );
    }
    const chatFiles = await db.query.aiChatFiles.findMany({
      columns: { filename: true, mimeType: true, status: true },
      where: { conversationId, filename: { in: fileNames } },
    });
    const byName = new Map(chatFiles.map((f) => [f.filename, f]));
    for (const filename of fileNames) {
      const chatFile = byName.get(filename);
      const bytes =
        chatFile && chatFile.status !== "error"
          ? await readSessionFile(conversationId, `attachments/${filename}`)
          : null;
      if (!chatFile || !bytes) {
        return toolError(
          TOOL_ERROR_CODES.WORKFLOW_ERROR,
          `"${filename}" is not a readable attachment of this conversation.`,
          "Pass filenames exactly as listed in the attached-files block.",
        );
      }
      attachments.push({ filename, mimeType: chatFile.mimeType, bytes });
    }
  }

  // The payload mirrors a real form submission: file fields carry the attached
  // filenames, required file fields must be satisfied.
  const payload: Record<string, unknown> = { ...(params.payload ?? {}) };
  if (row.triggerType === "form") {
    const fileFields = (row.triggerConfig.form?.fields ?? []).filter(
      (field) => field.type === "file",
    );
    const soleField = fileFields.length === 1 ? fileFields[0] : undefined;
    if (
      soleField &&
      attachments.length > 0 &&
      payload[soleField.key] === undefined
    ) {
      payload[soleField.key] = attachments.map((a) => a.filename);
    }
    const attachedNames = new Set(attachments.map((a) => a.filename));
    for (const field of fileFields) {
      const value = payload[field.key];
      const names = (
        typeof value === "string"
          ? [value]
          : Array.isArray(value)
            ? value.filter((v): v is string => typeof v === "string")
            : []
      ).map(toAttachmentBasename);
      // Write the normalised names back: the run reads this payload and must
      // see the names its own workspace uses.
      if (names.length > 0) payload[field.key] = names;
      const unknown = names.filter((name) => !attachedNames.has(name));
      if (unknown.length > 0) {
        return toolError(
          TOOL_ERROR_CODES.WORKFLOW_ERROR,
          `Form field '${field.key}' references files not attached to the run: ${unknown.join(", ")}.`,
          "Payload strings attach nothing — list every file in `files`.",
        );
      }
      if (field.required && names.length === 0) {
        return toolError(
          TOOL_ERROR_CODES.WORKFLOW_ERROR,
          `Form field '${field.key}' requires at least one file; the run got none.`,
          "Attach the file(s) to this conversation, then pass their filenames in `files` (several file fields: also map them under payload.<key>).",
        );
      }
    }
  }

  // Every attachment of this conversation the run did NOT get. A run sees
  // `files` and nothing else, so a source document left behind produces a
  // deliverable that looks complete and isn't: prod 2026-07-28 tested twice
  // with 2 of 3 documents, and the missing invoice's amounts came back as
  // empty cells nobody questioned. A plain list, not an error — an example or
  // template file usually has no business inside the run.
  const heldBack = conversationId
    ? (await listConversationFiles(conversationId))
        .map((file) => file.filename)
        .filter((name) => !fileNames.includes(name))
    : [];
  const notHandedOver =
    heldBack.length > HELD_BACK_FILES_LISTED
      ? [
          ...heldBack.slice(0, HELD_BACK_FILES_LISTED),
          `+${(heldBack.length - HELD_BACK_FILES_LISTED).toString()} more`,
        ]
      : heldBack;

  return { payload, attachments, notHandedOver };
};

/** Narrow `prepareRunLaunch`'s union without a cast. */
const isPreparedLaunch = (
  result: PreparedRunLaunch | ReturnType<typeof toolError>,
): result is PreparedRunLaunch => "payload" in result;

/**
 * What the agent must do after firing a run. Deliberately NOT "end your turn":
 * a launch no longer stops the loop, so the agent finishes whatever else the
 * user asked for. What it must never do is wait — the conversation is resumed
 * on its own once every run it launched has finished.
 */
const BACKGROUND_RUN_NEXT =
  "The run continues in the background — finish any other work this turn needs, then end the turn. This conversation is notified and resumed automatically once every run it launched has finished. Never wait: no get_run polling, no sleeping.";

/**
 * Drop every `toolHints` entry that names no real workflow tool (typos,
 * forbidden tools — they would silently no-op at run time) instead of failing
 * the write. Returns the sanitized playbook plus a warning naming what was
 * dropped, so the model can correct on the next update without losing the
 * whole call.
 */
const sanitizeToolHints = (
  playbook: z.infer<typeof WorkflowPlaybookSchema>,
): { playbook: z.infer<typeof WorkflowPlaybookSchema>; warnings: string[] } => {
  const valid = workflowToolHintNames();
  const dropped = new Set<string>();
  const tasks = playbook.tasks.map((task) => {
    const hints = task.toolHints ?? [];
    const kept = hints.filter((hint) => valid.has(hint));
    for (const hint of hints) {
      if (!valid.has(hint)) dropped.add(hint);
    }
    return kept.length === hints.length ? task : { ...task, toolHints: kept };
  });
  if (dropped.size === 0) return { playbook, warnings: [] };
  return {
    playbook: { ...playbook, tasks },
    warnings: [
      `Dropped unknown toolHints: ${[...dropped].join(", ")}. Valid tools: ${[...workflowToolHintNames()].sort().join(", ")}.`,
    ],
  };
};

/**
 * Drop an unknown icon (a real-but-uncurated Lucide name, or a typo) instead
 * of failing the whole write — same "don't fail on a cosmetic field" stance
 * as `sanitizeToolHints`. The workflow keeps the platform default icon and the
 * warning steers the model to pick a catalog name via `searchIcons` + `update`,
 * without discarding a 50-line playbook payload over a wrong icon string.
 */
export const sanitizeIcon = (
  icon: string | undefined,
): { icon: string | undefined; warnings: string[] } => {
  if (icon === undefined || isValidIcon(icon)) return { icon, warnings: [] };
  return {
    icon: undefined,
    warnings: [
      `Ignored unknown icon '${icon}' — kept the default. Call searchIcons for a valid Lucide name, then set it via update.`,
    ],
  };
};

/** Same stance for the color: an off-palette token is dropped, not an error. */
export const sanitizeColor = (
  color: string | undefined,
): { color: string | undefined; warnings: string[] } => {
  if (color === undefined || isValidObjectColor(color)) {
    return { color, warnings: [] };
  }
  return {
    color: undefined,
    warnings: [
      `Ignored unknown color '${color}' — kept the default. Valid tokens: ${OBJECT_COLOR_TOKENS.join(", ")}.`,
    ],
  };
};

type WorkflowScope = "team" | "private";
const scopeOf = (userId: string | null): WorkflowScope =>
  userId ? "private" : "team";

/**
 * Domain tool (deferred) — the conversational builder for workflows: the
 * autonomous agents the team runs on a schedule, an event, or on demand. The
 * team creates and refines them here in chat; the run itself is executed
 * headless by the workflow agent (this tool never runs one turn of it).
 */
export const createManageWorkflowTool = () =>
  tool({
    description: [
      "Build and manage workflows — autonomous agents that run a playbook of tasks on a schedule, an event, or on demand, with the same tools you have. Deciding WHETHER a workflow is the right feature (vs a team skill, an object type, or just doing the task now) — and how features compose — is `skills/platform-guide/SKILL.md` territory: read it before proposing.",
      "",
      "- create_draft: name + playbook (one goal + 1-20 ordered tasks; each task = title + instructions, optional expectedOutput + toolHints) + icon + color — set both at creation, best-guess is safe (an off-catalog value is dropped with a warning, never an error). Optional description, triggerType (manual|cron|event|form) + triggerConfig, autonomy (read_only|approval_required|autonomous, default approval_required), modelProfileKey, scope (team|private, default team). Starts as draft. The user sets run time/token limits themselves on the workflow page.",
      "- update: workflowId + any field, including scope (re-scope anytime). Safe anytime — runs snapshot the playbook, so edits never disturb a running or past run.",
      "- list / get: the team's workflows (+ your private ones), each with what it does / one workflow's full playbook. Each result carries `scope`. Before create_draft, ALWAYS check list (and `searchKnowledge` with sourceTypes ['workflows']) for one that already covers the need — run it, extend it, or tell the user it exists, rather than building a second one.",
      "- get_trigger_catalog: the machine-readable catalog of trigger kinds + each event type's editable filter params. Read it before setting triggerType/triggerConfig.",
      "- run_test: workflowId (+ optional payload, + files: attachment filenames to hand to the run) fires a test run in the background. The run sees `files` and nothing else — a source document you leave out comes back as empty cells, not as an error. The result echoes `notHandedOver`: this conversation's other attachments, so check none of them was needed.",
      "- run: same arguments, but a REAL run of an active workflow — it writes, sends, and emails the workflow's recipients. Needs confirm: true, which you may pass only after the user agreed in this conversation. Use it when they ask for what the workflow does; run_test is for trying one out.",
      "- Either launch leaves the run in the background: keep working on the rest of the turn, then end it normally. Never wait — no polling, no sleeping. This conversation is resumed once every run it launched has finished, with all their outcomes at once.",
      "- get_run: runId → status, per-task outcomes, result summary, error, and `outputs` — the run's deliverables, each pulled into this conversation at `runs/<runId>/<file>` so you can `read` it or load it in `python`. A run works in its own workspace, so this is the ONLY way to see what it actually produced: judge the run on the file, never on its own summary.",
      "- activate / pause: flip a workflow live / paused. Cron workflows get their schedule on activate.",
      "",
      "Loop: create_draft → run_test → resumed on completion → analyze with get_run → adjust with update → activate. One conform test is enough: re-test only when an update fixed a real structural/logic defect; a spec detail (number format, label, sort order) goes in via update with no new test, and gaps inherent to the input data are findings to report, never a reason to re-run.",
      "Activation gate: activate needs ≥1 succeeded run. To skip testing, confirm with the user first (askUserQuestion), then pass confirm: true.",
      "",
      "Form trigger (triggerType 'form'): a person fills a form; each submission starts a run whose triggerPayload is the answers, with uploaded files attached to the run — write the playbook to consume triggerPayload. triggerConfig.form = { title, description?, fields[] (≥1 to activate), visibility ('public' = anyone with the link, 'private' = the workflow's team/owner), submitLabel?, successMessage? }. Each field = { key (snake_case, unique), type, label, required, +per-type constraints (minLength/maxLength, min/max/step, options[{value,label}], accept/maxFiles/maxFileSizeMb) }.",
      describeFormFieldsForAgent(),
      "After activate, `get` returns `formUrl` — the shareable link to hand the user.",
      "",
      "Writing a playbook (the run has no user to ask — be specific, stay industry-agnostic):",
      "- Task `instructions` state the GOAL and the expected output — WHAT to achieve, never a tool name or its arguments. `toolHints` is the ONLY place a tool name may appear. The executor picks the tool and its exact argument shape from the live schema (`describeObjectType`). A playbook that dictates `manageRecord` calls or field formats goes stale and breaks.",
      "- A playbook runs against whatever its trigger delivers, run after run. Decide from the user's request how variable that input is — fixed template / stable format with varying content / open input — and generalize each task to that level; `skills/platform-guide/references/workflows.md` § 'Design for the input space' carries the doctrine. Variability ambiguous? askUserQuestion before baking an example file's structure into a task.",
      "- When the conversation shows what the output must look like (example file, exact columns, required format), capture it in `playbook.deliverable` = { format, description } — a run executes in a FRESH conversation and never sees this chat, so a contract left only here is invisible to the executor. Copy the example's structure line AND two of its data rows as read, never a description of them — the rows are the only place the way a value is written is visible. Details + the diff-vs-example check: workflows.md.",
      "- A run always produces its deliverable. A value it cannot establish leaves that cell empty and names the affected rows in the summary; a playbook that withholds the whole file until every value is confirmed spends the run and returns nothing to read or correct. Only refuse to produce when the user asked for that.",
      "- Autonomy governs writes: `read_only` = no writes; `approval_required` (default) = object writes go through the Python objects SDK in bulk (`records.bulk_*`) and PAUSE for a human to approve, and an open decision pauses via `askUserQuestion` — say WHAT to write / decide, the platform handles the pause + resume; `autonomous` = writes apply directly. Never merge 'present a list and then create it' into a plan that assumes the user is watching — describe the write, the run pauses for approval on its own.",
      "- Scope governs identity: `team` (default) runs as the team assistant — sees only team-shared external-app connections, everyone on the team sees and runs it. `private` runs as you — sees your personal connections too (plus team ones), and only you (and org admins) see or run it. A connections listing tags each row `scope: user` (personal) or `scope: team` (shared); if the playbook needs a `scope: user` connection, the workflow MUST be `private` — the team assistant can never see it. Prefer `team` when a team-shared connection covers the need. Unsure which the user wants, or whether the connection is personal? `askUserQuestion`. `run_test` failing `EXTERNAL_APP_NO_CONNECTION` on what looked like a personal connection means wrong scope — set `scope: private` and retest.",
      "- `toolHints` per task: the tool carrying its core operation, core or domain (validated against the registry). Domain tools pre-load so the run doesn't spend a turn searching; a core tool is the per-task cue the executor reads every turn — an extraction task that omits `extract` gets hand-parsed. Keep the list minimal: the operation's tool, not every tool it might touch. A task that turns on judgement (which records go together, which category applies) gets NO hint — hinting `python` there buys a hand-written scorer instead of a decision.",
      "- An extraction task never instructs 'read the documents completely': `extract` reads the document itself and returns the structured data. Instruct at most a bounded look (first page / ~50 lines) to identify each file's type and role before extracting — a full `read` on top of `extract` sends every document through the context twice.",
      "- `update` tightens in place: fold a fix into the task it belongs to, put deliverable format details in `playbook.deliverable` — never append validation tasks round after round; every appended task makes every future run longer.",
      "- Push bulk web/document research into a sub-agent (the executor's `dispatchAgent`) so intermediate reads don't bloat the run — instruct it to 'delegate the research, keep only the summary'.",
      "- Anti-race: finish any data mutation BEFORE a task that reads it back; instruct tasks to re-query state at the point of use, never to reuse a stale snapshot from an earlier task.",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum([
        "create_draft",
        "update",
        "list",
        "get",
        "get_trigger_catalog",
        "run_test",
        "run",
        "get_run",
        "activate",
        "pause",
      ]),
      workflowId: z
        .uuid()
        .optional()
        .describe(
          "Required for update / get / run_test / run / activate / pause.",
        ),
      runId: z.uuid().optional().describe("Required for get_run."),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(2000).optional(),
      icon: z
        .string()
        .max(60)
        .optional()
        .describe(
          "Lucide icon name. Best-guess a common one (file-spreadsheet, mail, chart-bar…) — an unknown name is dropped with a warning; reach for searchIcons only after a drop.",
        ),
      color: z
        .string()
        .max(20)
        .optional()
        .describe(`Palette token: ${OBJECT_COLOR_TOKENS.join(" | ")}.`),
      triggerType: workflowTriggerTypeSchema.optional(),
      triggerConfig: WorkflowTriggerConfigSchema.optional().describe(
        describeTriggerConfigForAgent(),
      ),
      playbook: WorkflowPlaybookSchema.optional().describe(
        "The plan: goal + ordered tasks. Required for create_draft.",
      ),
      autonomy: workflowAutonomySchema.optional(),
      scope: z
        .enum(["team", "private"])
        .optional()
        .describe(
          "create_draft/update. team (default) = runs as the team assistant. private = runs as you, can use your personal connections, visible only to you (+ admins).",
        ),
      modelProfileKey: z
        .string()
        .max(64)
        .optional()
        .describe("Override the model profile; omit to use the team default."),
      payload: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("run_test / run — the trigger input handed to the agent."),
      files: z
        .array(z.string().min(1))
        .max(10)
        .optional()
        .describe(
          "run_test / run — THIS conversation's attachments to hand to the run, as the path shown in the attached-files block ('attachments/report.pdf') or the bare filename. Required when the workflow's form has a required file field: payload strings alone attach nothing.",
        ),
      confirm: z
        .boolean()
        .optional()
        .describe(
          "activate: override the ≥1-successful-test gate. run_test: required from the 3rd test when the previous one succeeded. run: ALWAYS required — the user must have said yes.",
        ),
    }),
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      const { teamId, organizationId, userId } = ctx;
      // A private workflow is invisible to anyone but its owner (org
      // admins/owners see everything) — same rule as the API/UI.
      const requester: WorkflowRequester | undefined = userId
        ? { userId, isAdmin: await isOrgAdmin(organizationId, userId) }
        : undefined;

      const { icon: safeIcon, warnings: iconWarnings } = sanitizeIcon(
        input.icon,
      );
      const { color: safeColor, warnings: colorWarnings } = sanitizeColor(
        input.color,
      );

      try {
        switch (input.action) {
          case "create_draft": {
            if (!input.name || !input.playbook) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_ERROR,
                "create_draft requires name and playbook.",
              );
            }
            if (!userId) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_ERROR,
                "No acting user in context.",
              );
            }
            const { playbook, warnings: hintWarnings } = sanitizeToolHints(
              input.playbook,
            );
            const warnings = [
              ...iconWarnings,
              ...colorWarnings,
              ...hintWarnings,
            ];
            const createInput: CreateWorkflowInput = {
              name: input.name,
              description: input.description ?? "",
              playbook,
              triggerType: input.triggerType ?? "manual",
              triggerConfig: input.triggerConfig ?? {},
              autonomy: input.autonomy ?? "approval_required",
              limits: {},
              ...(safeIcon ? { icon: safeIcon } : {}),
              ...(safeColor ? { color: safeColor } : {}),
              ...(input.modelProfileKey
                ? { modelProfileKey: input.modelProfileKey }
                : {}),
              ...(input.scope === "private" ? { userId } : {}),
            };
            const workflow = await createWorkflow({
              organizationId,
              teamId,
              createdByUserId: userId,
              input: createInput,
            });
            return {
              ok: true,
              workflow: {
                id: workflow.id,
                name: workflow.name,
                status: workflow.status,
                scope: scopeOf(workflow.userId),
                ...(workflow.formUrl ? { formUrl: workflow.formUrl } : {}),
              },
              ...(warnings.length > 0 ? { warnings } : {}),
              next: "Test it with run_test, then get_run to review, before activate.",
            };
          }

          case "update": {
            if (!input.workflowId) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_ERROR,
                "update requires workflowId.",
              );
            }
            const sanitized =
              input.playbook !== undefined
                ? sanitizeToolHints(input.playbook)
                : undefined;
            if (input.scope === "private" && !userId) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_ERROR,
                "No acting user in context — can't scope a workflow to private.",
              );
            }
            const patch: UpdateWorkflowInput = {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.description !== undefined
                ? { description: input.description }
                : {}),
              ...(safeIcon !== undefined ? { icon: safeIcon } : {}),
              ...(safeColor !== undefined ? { color: safeColor } : {}),
              ...(input.triggerType !== undefined
                ? { triggerType: input.triggerType }
                : {}),
              ...(input.triggerConfig !== undefined
                ? { triggerConfig: input.triggerConfig }
                : {}),
              ...(sanitized ? { playbook: sanitized.playbook } : {}),
              ...(input.autonomy !== undefined
                ? { autonomy: input.autonomy }
                : {}),
              ...(input.modelProfileKey !== undefined
                ? { modelProfileKey: input.modelProfileKey }
                : {}),
              ...(input.scope === "private"
                ? { userId }
                : input.scope === "team"
                  ? { userId: null }
                  : {}),
            };
            const workflow = await updateWorkflow({
              id: input.workflowId,
              teamId,
              input: patch,
              requester,
            });
            if (!workflow) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_NOT_FOUND,
                "No such workflow for this team.",
              );
            }
            const updateWarnings = [
              ...iconWarnings,
              ...colorWarnings,
              ...(sanitized ? sanitized.warnings : []),
            ];
            return {
              ok: true,
              workflow: {
                id: workflow.id,
                name: workflow.name,
                status: workflow.status,
                scope: scopeOf(workflow.userId),
              },
              ...(updateWarnings.length > 0
                ? { warnings: updateWarnings }
                : {}),
            };
          }

          case "list": {
            const workflows = await listWorkflows({ teamId, requester });
            return {
              ok: true,
              workflows: workflows.map((w) => ({
                id: w.id,
                name: w.name,
                // What it does, so a candidate can be recognised here rather
                // than by calling `get` on every workflow in the team.
                description: truncateForListing(
                  w.description ?? w.playbook.goal,
                ),
                status: w.status,
                triggerType: w.triggerType,
                autonomy: w.autonomy,
                taskCount: w.playbook.tasks.length,
                scope: scopeOf(w.userId),
              })),
            };
          }

          case "get": {
            if (!input.workflowId) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_ERROR,
                "get requires workflowId.",
              );
            }
            const workflow = await getWorkflow({
              id: input.workflowId,
              teamId,
              requester,
            });
            if (!workflow) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_NOT_FOUND,
                "No such workflow for this team.",
              );
            }
            return {
              ok: true,
              workflow: {
                id: workflow.id,
                name: workflow.name,
                description: workflow.description,
                status: workflow.status,
                triggerType: workflow.triggerType,
                triggerConfig: workflow.triggerConfig,
                autonomy: workflow.autonomy,
                modelProfileKey: workflow.modelProfileKey,
                limits: workflow.limits,
                playbook: workflow.playbook,
                scope: scopeOf(workflow.userId),
                mine: workflow.userId === userId,
                ...(workflow.formUrl ? { formUrl: workflow.formUrl } : {}),
              },
            };
          }

          case "get_trigger_catalog": {
            return { ok: true, catalog: buildTriggerCatalog() };
          }

          case "run_test": {
            if (!input.workflowId) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_ERROR,
                "run_test requires workflowId.",
              );
            }
            const row = await getWorkflowRow({
              id: input.workflowId,
              teamId,
              requester,
            });
            if (!row) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_NOT_FOUND,
                "No such workflow for this team.",
              );
            }
            const prepared = await prepareRunLaunch({
              row,
              conversationId: ctx.conversationId,
              files: input.files,
              payload: input.payload,
            });
            if (!isPreparedLaunch(prepared)) return prepared;
            const { payload, attachments, notHandedOver } = prepared;

            // Iteration budget. Nothing else bounds this: the in-flight guard
            // is cron-only, the circuit breaker skips `isTest`, and the
            // finish→resume→update→run_test cycle is deduped per RUN. Prod
            // 2026-07-27 spent 27 minutes and $2.16 on four rounds of it. The
            // count rides every result so the model can see itself converging
            // — or not.
            const previousTests = ctx.conversationId
              ? await countTestRuns({
                  workflowId: row.id,
                  sourceConversationId: ctx.conversationId,
                })
              : 0;
            if (previousTests >= MAX_TEST_RUNS_PER_CONVERSATION) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_ERROR,
                `${previousTests.toString()} test runs already in this conversation — stop iterating alone.`,
                "Show the user what the last run produced versus what they asked for, and ask which difference to fix. They can also run the workflow from its page.",
              );
            }
            // Friction, not a wall: from the 3rd test after a SUCCEEDED one,
            // require an explicit confirm. A succeeded run whose deliverable
            // was worth re-testing twice usually wasn't — prod 2026-07-29
            // re-ran a succeeded run twice over number formats and shipped a
            // near-identical file both times. Failed runs stay frictionless.
            if (previousTests >= 2 && input.confirm !== true) {
              const lastTest = ctx.conversationId
                ? await db.query.workflowRuns.findFirst({
                    where: {
                      workflowId: row.id,
                      sourceConversationId: ctx.conversationId,
                      isTest: true,
                    },
                    orderBy: { createdAt: "desc" },
                    columns: { status: true },
                  })
                : undefined;
              if (lastTest?.status === "succeeded") {
                return toolError(
                  TOOL_ERROR_CODES.WORKFLOW_ERROR,
                  `The last test run SUCCEEDED and ${previousTests.toString()} tests already ran — a #${(previousTests + 1).toString()} needs confirm: true.`,
                  "A structurally conform deliverable → activate; a spec detail (format, label) → update without retesting. Re-test only for a real playbook defect the update just fixed — then pass confirm: true, or ask the user.",
                );
              }
            }

            const run = await createWorkflowRun({
              workflow: row,
              // A form workflow tests as a form run — the executor sees the
              // same trigger shape a real submission produces.
              triggerType: row.triggerType === "form" ? "form" : "manual",
              triggerPayload: payload,
              triggeredByUserId: userId ?? null,
              // Notify this chat when the test run finishes.
              sourceConversationId: ctx.conversationId ?? null,
              isTest: true,
              ...(attachments.length > 0 ? { attachments } : {}),
            });
            const testRunNumber = previousTests + 1;
            if (run.status === "failed") {
              // Failed at creation (INPUT_MISSING / TRIGGER_FAILED): the turn
              // deliberately continues — fixing the input and relaunching in
              // the same turn is the right move. These runs never started, so
              // `countTestRuns` excludes them from the iteration budget.
              return {
                ok: true,
                run: { id: run.id, status: run.status },
                next: "The run failed to start (this does not count as a test run) — read `error` via get_run, fix the cause, and relaunch in this turn.",
              };
            }
            return {
              ok: true,
              run: { id: run.id, status: run.status },
              testRunNumber,
              testRunsAllowed: MAX_TEST_RUNS_PER_CONVERSATION,
              ...(notHandedOver.length > 0 ? { notHandedOver } : {}),
              // Registered as a wait of this conversation — it is resumed once
              // this run (and any sibling) finishes. Also the marker the UI
              // reads to show the run live.
              backgroundRun: true,
              next: BACKGROUND_RUN_NEXT,
            };
          }

          case "run": {
            if (!input.workflowId) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_ERROR,
                "run requires workflowId.",
              );
            }
            const row = await getWorkflowRow({
              id: input.workflowId,
              teamId,
              requester,
            });
            if (!row) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_NOT_FOUND,
                "No such workflow for this team.",
              );
            }
            // A real run does the work for real: it writes, sends, and emails
            // the workflow's recipients. Only a live workflow may be run, and
            // only on the user's explicit say-so — a test run is the way to
            // try something out.
            if (row.status !== "active") {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_ERROR,
                `This workflow is ${row.status}, and only an active workflow can be run for real.`,
                "Activate it first, or use run_test to try it out.",
              );
            }
            if (input.confirm !== true) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_ERROR,
                "A real run needs the user's explicit go-ahead in this conversation.",
                "Tell them what it will do, ask, then pass confirm: true. Use run_test to try it out without side effects.",
              );
            }

            const prepared = await prepareRunLaunch({
              row,
              conversationId: ctx.conversationId,
              files: input.files,
              payload: input.payload,
            });
            if (!isPreparedLaunch(prepared)) return prepared;

            const run = await createWorkflowRun({
              workflow: row,
              triggerType: row.triggerType === "form" ? "form" : "manual",
              triggerPayload: prepared.payload,
              triggeredByUserId: userId ?? null,
              sourceConversationId: ctx.conversationId ?? null,
              isTest: false,
              ...(prepared.attachments.length > 0
                ? { attachments: prepared.attachments }
                : {}),
            });
            if (run.status === "failed") {
              return {
                ok: true,
                run: { id: run.id, status: run.status },
                next: "The run failed to start — read `error` via get_run, fix the cause, and relaunch in this turn.",
              };
            }
            return {
              ok: true,
              run: { id: run.id, status: run.status },
              ...(prepared.notHandedOver.length > 0
                ? { notHandedOver: prepared.notHandedOver }
                : {}),
              backgroundRun: true,
              next: BACKGROUND_RUN_NEXT,
            };
          }

          case "get_run": {
            if (!input.runId) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_ERROR,
                "get_run requires runId.",
              );
            }
            const run = await getWorkflowRun({
              id: input.runId,
              teamId,
              requester,
            });
            if (!run) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_NOT_FOUND,
                "No such run for this team.",
              );
            }
            // The deliverables are pulled into THIS conversation's workspace
            // and handed back as paths: a run writes in its own conversation,
            // so without this the builder can only grade a run on the summary
            // the run wrote about itself — which is how four consecutive test
            // runs shipped the same invented CSV column in prod.
            const outputs = run.outputs ?? [];
            const materialized =
              outputs.length > 0 && run.conversationId && ctx.conversationId
                ? await materializeRunOutputs({
                    runId: run.id,
                    runConversationId: run.conversationId,
                    conversationId: ctx.conversationId,
                    outputs,
                  })
                : new Map<string, string>();
            return {
              ok: true,
              run: {
                id: run.id,
                status: run.status,
                isTest: run.isTest,
                turns: run.usage.turns,
                // Tokens with the cache share broken out — the raw total alone
                // reads as runaway consumption when most of it is cache hits.
                usage: {
                  totalTokens: run.usage.totalTokens,
                  cachedInputTokens: run.usage.cachedInputTokens,
                  outputTokens: run.usage.outputTokens,
                },
                tasks: run.taskStates.map((t) => ({
                  key: t.key,
                  title: t.title,
                  status: t.status,
                  ...(t.summary ? { summary: t.summary } : {}),
                })),
                outputSummary: run.outputSummary,
                outputs: outputs.map((output) => ({
                  label: output.label,
                  ...(output.value !== undefined
                    ? { value: output.value }
                    : {}),
                  ...(output.mimeType !== undefined
                    ? { mimeType: output.mimeType }
                    : {}),
                  ...(output.sizeBytes !== undefined
                    ? { sizeBytes: output.sizeBytes }
                    : {}),
                  ...(output.filePath !== undefined &&
                  materialized.has(output.filePath)
                    ? { path: materialized.get(output.filePath) }
                    : {}),
                })),
                error: run.error,
              },
            };
          }

          case "activate": {
            if (!input.workflowId) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_ERROR,
                "activate requires workflowId.",
              );
            }
            if (input.confirm !== true) {
              const tested = await hasSuccessfulRun({
                workflowId: input.workflowId,
                teamId,
              });
              if (!tested) {
                return toolError(
                  TOOL_ERROR_CODES.WORKFLOW_NOT_TESTED,
                  "No succeeded run yet.",
                  "Run a test (run_test) and confirm it succeeded, or ask the user to confirm activating untested and pass confirm: true.",
                );
              }
            }
            const workflow = await activateWorkflow({
              id: input.workflowId,
              teamId,
              requester,
            });
            if (!workflow) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_NOT_FOUND,
                "No such workflow for this team.",
              );
            }
            return {
              ok: true,
              workflow: {
                id: workflow.id,
                name: workflow.name,
                status: workflow.status,
              },
            };
          }

          case "pause": {
            if (!input.workflowId) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_ERROR,
                "pause requires workflowId.",
              );
            }
            const workflow = await pauseWorkflow({
              id: input.workflowId,
              teamId,
              requester,
            });
            if (!workflow) {
              return toolError(
                TOOL_ERROR_CODES.WORKFLOW_NOT_FOUND,
                "No such workflow for this team.",
              );
            }
            return {
              ok: true,
              workflow: {
                id: workflow.id,
                name: workflow.name,
                status: workflow.status,
              },
            };
          }

          default: {
            const exhaustive: never = input.action;
            return toolError(
              TOOL_ERROR_CODES.WORKFLOW_ERROR,
              `Unknown action ${String(exhaustive)}.`,
            );
          }
        }
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.WORKFLOW_ERROR,
          `manageWorkflow ${input.action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
