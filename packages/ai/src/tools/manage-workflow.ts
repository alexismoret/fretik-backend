import db from "@fretik/shared/db";
import { readSessionFile } from "@fretik/shared/lib/chatbot-session-storage";
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
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { workflowToolHintNames } from "../agents/workflow/tools";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

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
      "- create_draft: name + playbook (one goal + 1-20 ordered tasks; each task = title + instructions, optional expectedOutput + toolHints). Optional icon (from searchIcons), color, description, triggerType (manual|cron|event|form) + triggerConfig, autonomy (read_only|approval_required|autonomous, default approval_required), modelProfileKey, scope (team|private, default team). Starts as draft. The user sets run time/token limits themselves on the workflow page.",
      "- update: workflowId + any field, including scope (re-scope anytime). Safe anytime — runs snapshot the playbook, so edits never disturb a running or past run.",
      "- list / get: the team's workflows (+ your private ones) / one workflow's full playbook. Each result carries `scope`.",
      "- get_trigger_catalog: the machine-readable catalog of trigger kinds + each event type's editable filter params. Read it before setting triggerType/triggerConfig.",
      "- run_test: workflowId (+ optional payload, + files: attachment filenames to hand to the run) fires a test run in the background. Launch it, say so, and END your turn — this conversation is notified and resumed automatically when the run finishes. Never poll get_run or sleep while it runs.",
      "- get_run: runId → status, per-task outcomes, result summary, error.",
      "- activate / pause: flip a workflow live / paused. Cron workflows get their schedule on activate.",
      "",
      "Loop: create_draft → run_test (turn ends) → resumed on completion → analyze with get_run → adjust with update → activate.",
      "Activation gate: activate needs ≥1 succeeded run. To skip testing, confirm with the user first (askUserQuestion), then pass confirm: true.",
      "",
      "Form trigger (triggerType 'form'): a person fills a form; each submission starts a run whose triggerPayload is the answers, with uploaded files attached to the run — write the playbook to consume triggerPayload. triggerConfig.form = { title, description?, fields[] (≥1 to activate), visibility ('public' = anyone with the link, 'private' = the workflow's team/owner), submitLabel?, successMessage? }. Each field = { key (snake_case, unique), type, label, required, +per-type constraints (minLength/maxLength, min/max/step, options[{value,label}], accept/maxFiles/maxFileSizeMb) }.",
      describeFormFieldsForAgent(),
      "After activate, `get` returns `formUrl` — the shareable link to hand the user.",
      "",
      "Writing a playbook (the run has no user to ask — be specific, stay industry-agnostic):",
      "- Task `instructions` state the GOAL and the expected output — WHAT to achieve, never a tool name or its arguments. `toolHints` is the ONLY place a tool name may appear. The executor picks the tool and its exact argument shape from the live schema (`describeObjectType`). A playbook that dictates `manageRecord` calls or field formats goes stale and breaks.",
      "- A playbook runs against whatever its trigger delivers, run after run. Decide from the user's request how variable that input is — fixed template / stable format with varying content / open input — and generalize each task to that level; `skills/platform-guide/references/workflows.md` § 'Design for the input space' carries the doctrine. Variability ambiguous? askUserQuestion before baking an example file's structure into a task.",
      "- When the conversation shows what the output must look like (example file, exact columns, required format), capture it in `playbook.deliverable` = { format, description } — a run executes in a FRESH conversation and never sees this chat, so a contract left only here is invisible to the executor. Details + the diff-vs-example check: workflows.md.",
      "- Autonomy governs writes: `read_only` = no writes; `approval_required` (default) = object writes go through the Python objects SDK in bulk (`records.bulk_*`) and PAUSE for a human to approve, and an open decision pauses via `askUserQuestion` — say WHAT to write / decide, the platform handles the pause + resume; `autonomous` = writes apply directly. Never merge 'present a list and then create it' into a plan that assumes the user is watching — describe the write, the run pauses for approval on its own.",
      "- Scope governs identity: `team` (default) runs as the team assistant — sees only team-shared external-app connections, everyone on the team sees and runs it. `private` runs as you — sees your personal connections too (plus team ones), and only you (and org admins) see or run it. A connections listing tags each row `scope: user` (personal) or `scope: team` (shared); if the playbook needs a `scope: user` connection, the workflow MUST be `private` — the team assistant can never see it. Prefer `team` when a team-shared connection covers the need. Unsure which the user wants, or whether the connection is personal? `askUserQuestion`. `run_test` failing `EXTERNAL_APP_NO_CONNECTION` on what looked like a personal connection means wrong scope — set `scope: private` and retest.",
      "- `toolHints` per task: the tool carrying its core operation, core or domain (validated against the registry). Domain tools pre-load so the run doesn't spend a turn searching; a core tool is the per-task cue the executor reads every turn — an extraction task that omits `extract` gets hand-parsed. Keep the list minimal: the operation's tool, not every tool it might touch.",
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
        "get_run",
        "activate",
        "pause",
      ]),
      workflowId: z
        .uuid()
        .optional()
        .describe("Required for update / get / run_test / activate / pause."),
      runId: z.uuid().optional().describe("Required for get_run."),
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(2000).optional(),
      icon: z
        .string()
        .max(60)
        .optional()
        .describe("Lucide icon name from searchIcons."),
      color: z.string().max(20).optional(),
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
        .describe("run_test only — the trigger input handed to the agent."),
      files: z
        .array(z.string().min(1))
        .max(10)
        .optional()
        .describe(
          "run_test only — filenames of THIS conversation's attachments to hand to the run, exactly as listed in the attached-files block. Required when the workflow's form has a required file field: payload strings alone attach nothing.",
        ),
      confirm: z
        .boolean()
        .optional()
        .describe("activate only — override the ≥1-successful-test gate."),
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
            const warnings = [...iconWarnings, ...hintWarnings];
            const createInput: CreateWorkflowInput = {
              name: input.name,
              description: input.description ?? "",
              playbook,
              triggerType: input.triggerType ?? "manual",
              triggerConfig: input.triggerConfig ?? {},
              autonomy: input.autonomy ?? "approval_required",
              limits: {},
              ...(safeIcon ? { icon: safeIcon } : {}),
              ...(input.color ? { color: input.color } : {}),
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
              ...(input.color !== undefined ? { color: input.color } : {}),
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
            // The run executes in its own fresh conversation and sees ONLY
            // files attached to it here — chat attachments never carry over by
            // themselves.
            const fileNames = input.files ?? [];
            const attachments: RunAttachment[] = [];
            if (fileNames.length > 0) {
              const conversationId = ctx.conversationId;
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
                    ? await readSessionFile(
                        conversationId,
                        `attachments/${filename}`,
                      )
                    : null;
                if (!chatFile || !bytes) {
                  return toolError(
                    TOOL_ERROR_CODES.WORKFLOW_ERROR,
                    `"${filename}" is not a readable attachment of this conversation.`,
                    "Pass filenames exactly as listed in the attached-files block.",
                  );
                }
                attachments.push({
                  filename,
                  mimeType: chatFile.mimeType,
                  bytes,
                });
              }
            }

            // Test payload mirrors a real form submission: file fields carry
            // the attached filenames, required file fields must be satisfied.
            const payload: Record<string, unknown> = {
              ...(input.payload ?? {}),
            };
            if (row.triggerType === "form") {
              const fileFields = (row.triggerConfig.form?.fields ?? []).filter(
                (field) => field.type === "file",
              );
              const soleField =
                fileFields.length === 1 ? fileFields[0] : undefined;
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
                const names =
                  typeof value === "string"
                    ? [value]
                    : Array.isArray(value)
                      ? value.filter((v): v is string => typeof v === "string")
                      : [];
                const unknown = names.filter(
                  (name) => !attachedNames.has(name),
                );
                if (unknown.length > 0) {
                  return toolError(
                    TOOL_ERROR_CODES.WORKFLOW_ERROR,
                    `Form field '${field.key}' references files not attached to the run: ${unknown.join(", ")}.`,
                    "Payload strings attach nothing — list every test file in `files`.",
                  );
                }
                if (field.required && names.length === 0) {
                  return toolError(
                    TOOL_ERROR_CODES.WORKFLOW_ERROR,
                    `Form field '${field.key}' requires at least one file; the test run got none.`,
                    "Attach the file(s) to this conversation, then pass their filenames in `files` (several file fields: also map them under payload.<key>).",
                  );
                }
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
            if (run.status === "failed") {
              return {
                ok: true,
                run: { id: run.id, status: run.status },
                next: "The run failed to start — read `error` via get_run, fix, and relaunch.",
              };
            }
            return {
              ok: true,
              run: { id: run.id, status: run.status },
              // Ends the turn (stopOnBackgroundLaunch) — the run is now in
              // flight and this conversation is resumed on completion.
              backgroundRun: true,
              next: "The run continues in the background. End your turn now — say the test is launched, nothing else. This conversation is notified and resumed automatically when it finishes. Never wait by polling get_run or sleeping.",
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
            return {
              ok: true,
              run: {
                id: run.id,
                status: run.status,
                isTest: run.isTest,
                turns: run.usage.turns,
                tasks: run.taskStates.map((t) => ({
                  key: t.key,
                  title: t.title,
                  status: t.status,
                  ...(t.summary ? { summary: t.summary } : {}),
                })),
                outputSummary: run.outputSummary,
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
