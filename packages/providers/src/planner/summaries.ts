import type { ToolApprovalSummaryField } from "@fretik/shared/db/schema";
import {
  arr,
  asNumber,
  asString,
  str,
  strArray,
} from "@fretik/shared/external-apps/json-access";
import type {
  OperationSummaryPart,
  ProviderSummaries,
  SummaryMapper,
} from "@fretik/shared/external-apps/provider-types";

/**
 * Approval-card summaries for every Planner write action.
 *
 * Rule (ADDING_A_PROVIDER.md §8): surface only what a non-technical user can
 * verify — task titles, dates, assignee counts, % complete — NOT opaque Graph
 * IDs (task_id, plan_id, bucket_id, etag). For delete_task only a task_id
 * exists, so the title alone (from i18n) is the card.
 */

const field = (labelKey: string, value: string): ToolApprovalSummaryField => ({
  labelKey,
  value,
});

const optionalField = (
  labelKey: string,
  value: string | undefined,
): ToolApprovalSummaryField | null =>
  value !== undefined && value !== "" ? field(labelKey, value) : null;

const compact = (
  ...fields: (ToolApprovalSummaryField | null)[]
): ToolApprovalSummaryField[] =>
  fields.filter((f): f is ToolApprovalSummaryField => f !== null);

/** 0 / 50 / 100 → a human label; anything else shows the raw percentage. */
const progressLabel = (value: unknown): string | undefined => {
  const n = asNumber(value);
  if (n === undefined) return undefined;
  if (n === 0) return "Not started";
  if (n === 100) return "Completed";
  if (n === 50) return "In progress";
  return `${n.toString()}%`;
};

const assigneesField = (value: unknown): ToolApprovalSummaryField | null => {
  const ids = strArray(value);
  return ids.length > 0 ? field("assignees", ids.length.toString()) : null;
};

// ── Write summaries ────────────────────────────────────────────────────

const createTask: SummaryMapper = (args): OperationSummaryPart => ({
  titleKey: "default",
  titleParams: { title: str(args.title) },
  fields: compact(
    optionalField("due_date", asString(args.due_date)),
    optionalField("percent_complete", progressLabel(args.percent_complete)),
    assigneesField(args.assignee_ids),
  ),
});

const updateTask: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { title: str(args.title) },
  fields: compact(
    optionalField("title", asString(args.title)),
    optionalField("due_date", asString(args.due_date)),
    optionalField("percent_complete", progressLabel(args.percent_complete)),
    assigneesField(args.assignee_ids),
  ),
});

const updateTaskDetails: SummaryMapper = (args) => {
  const checklist = arr(args.checklist);
  return {
    titleKey: "default",
    fields: compact(
      optionalField("description", asString(args.description)),
      checklist.length > 0
        ? field("checklist", checklist.length.toString())
        : null,
    ),
  };
};

const deleteTask: SummaryMapper = () => ({
  titleKey: "default",
  fields: [],
});

const createBucket: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { name: str(args.name) },
  fields: compact(field("name", str(args.name))),
});

const createPlan: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { title: str(args.title) },
  fields: compact(field("title", str(args.title))),
});

export const plannerSummaries: ProviderSummaries = {
  create_task: createTask,
  update_task: updateTask,
  update_task_details: updateTaskDetails,
  delete_task: deleteTask,
  create_bucket: createBucket,
  create_plan: createPlan,
};
