import {
  arr,
  asNumber,
  asString,
  bool,
  isRecord,
  num,
  path,
  prop,
  str,
  strArray,
} from "@fretik/shared/external-apps/json-access";
import type {
  ProviderMappers,
  RequestMapper,
  ResponseMapper,
} from "@fretik/shared/external-apps/provider-types";

/**
 * Microsoft Graph request/response transformers for the Planner provider.
 *
 * Request mappers turn the manifest's clean snake_case args into the Graph
 * request body + the `If-Match` header that PATCH/DELETE require. Response
 * mappers normalize Graph's camelCase payloads (and the `@odata.etag` /
 * open-type `assignments` shapes) back into the manifest `types`.
 */

// ── Helpers ────────────────────────────────────────────────────────────

/** The literal Graph expects for an unset / "use default" order hint. */
const ORDER_HINT_DEFAULT = " !";

/** Read `@odata.etag` off a Graph resource (top-level special property). */
const etagOf = (raw: unknown): string => str(prop(raw, "@odata.etag"));

/**
 * Graph `assignments` is an open-type map keyed by user ID:
 * `{ "<userId>": { "@odata.type": "#microsoft.graph.plannerAssignment",
 * "orderHint": " !" } }`. Build it from a flat list of user IDs.
 */
const buildAssignments = (userIds: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const id of userIds) {
    out[id] = {
      "@odata.type": "#microsoft.graph.plannerAssignment",
      orderHint: ORDER_HINT_DEFAULT,
    };
  }
  return out;
};

/** Flatten the `assignments` open-type map back to a list of user IDs. */
const assigneeIdsOf = (raw: unknown): string[] => {
  const assignments = prop(raw, "assignments");
  return isRecord(assignments) ? Object.keys(assignments) : [];
};

/** Project the agent-supplied etag into the `If-Match` header. */
const ifMatch = (args: Record<string, unknown>): Record<string, string> => ({
  "If-Match": str(args.etag),
});

// ── Request mappers — writes ───────────────────────────────────────────

const createTask: RequestMapper = (args) => {
  const body: Record<string, unknown> = {
    planId: str(args.plan_id),
    title: str(args.title),
  };
  const bucketId = asString(args.bucket_id);
  if (bucketId !== undefined && bucketId !== "") body.bucketId = bucketId;
  const assignees = strArray(args.assignee_ids);
  if (assignees.length > 0) body.assignments = buildAssignments(assignees);
  const dueDate = asString(args.due_date);
  if (dueDate !== undefined && dueDate !== "") body.dueDateTime = dueDate;
  const startDate = asString(args.start_date);
  if (startDate !== undefined && startDate !== "") {
    body.startDateTime = startDate;
  }
  const percent = asNumber(args.percent_complete);
  if (percent !== undefined) body.percentComplete = percent;
  const priority = asNumber(args.priority);
  if (priority !== undefined) body.priority = priority;
  return { body };
};

const updateTask: RequestMapper = (args) => {
  const body: Record<string, unknown> = {};
  const title = asString(args.title);
  if (title !== undefined) body.title = title;
  const bucketId = asString(args.bucket_id);
  if (bucketId !== undefined) body.bucketId = bucketId;
  // ISO strings clear the field when explicitly null; we only set when given.
  const dueDate = asString(args.due_date);
  if (dueDate !== undefined) body.dueDateTime = dueDate;
  const startDate = asString(args.start_date);
  if (startDate !== undefined) body.startDateTime = startDate;
  const percent = asNumber(args.percent_complete);
  if (percent !== undefined) body.percentComplete = percent;
  const priority = asNumber(args.priority);
  if (priority !== undefined) body.priority = priority;
  const assignees = args.assignee_ids;
  if (assignees !== undefined) {
    body.assignments = buildAssignments(strArray(assignees));
  }
  return {
    headers: { ...ifMatch(args), Prefer: "return=representation" },
    body,
  };
};

const updateTaskDetails: RequestMapper = (args) => {
  const body: Record<string, unknown> = {};
  const description = asString(args.description);
  if (description !== undefined) body.description = description;
  // Graph `checklist` is an open-type map keyed by a client-chosen GUID-ish
  // id; each value is a `plannerChecklistItem`. Replacing the whole list
  // means sending every desired item with a fresh key. Deterministic keys
  // (index-based) keep the generator/runtime reproducible.
  const checklist = args.checklist;
  if (checklist !== undefined) {
    const items: Record<string, unknown> = {};
    arr(checklist).forEach((item, idx) => {
      items[`item${(idx + 1).toString()}`] = {
        "@odata.type": "#microsoft.graph.plannerChecklistItem",
        title: str(prop(item, "title")),
        isChecked: bool(prop(item, "is_checked")),
      };
    });
    body.checklist = items;
  }
  return {
    headers: { ...ifMatch(args), Prefer: "return=representation" },
    body,
  };
};

const deleteTask: RequestMapper = (args) => ({ headers: ifMatch(args) });

const createBucket: RequestMapper = (args) => ({
  body: {
    name: str(args.name),
    planId: str(args.plan_id),
    orderHint: ORDER_HINT_DEFAULT,
  },
});

const createPlan: RequestMapper = (args) => ({
  body: {
    container: {
      url: `https://graph.microsoft.com/v1.0/groups/${str(args.group_id)}`,
    },
    title: str(args.title),
  },
});

// ── Response mappers ───────────────────────────────────────────────────

const normalizeTask = (raw: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    etag: etagOf(raw),
    title: str(path(raw, "title")),
    plan_id: str(path(raw, "planId")),
    percent_complete: num(path(raw, "percentComplete")),
    has_description: bool(path(raw, "hasDescription")),
    created_at: str(path(raw, "createdDateTime")),
  };
  const bucketId = asString(path(raw, "bucketId"));
  if (bucketId !== undefined && bucketId !== "") out.bucket_id = bucketId;
  const priority = asNumber(path(raw, "priority"));
  if (priority !== undefined) out.priority = priority;
  const dueDate = asString(path(raw, "dueDateTime"));
  if (dueDate !== undefined) out.due_date = dueDate;
  const startDate = asString(path(raw, "startDateTime"));
  if (startDate !== undefined) out.start_date = startDate;
  const assignees = assigneeIdsOf(raw);
  if (assignees.length > 0) out.assignee_ids = assignees;
  return out;
};

const normalizeChecklistItem = (
  id: string,
  value: unknown,
): Record<string, unknown> => ({
  id,
  title: str(prop(value, "title")),
  is_checked: bool(prop(value, "isChecked")),
});

const normalizeReference = (
  url: string,
  value: unknown,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { url };
  const alias = asString(prop(value, "alias"));
  if (alias !== undefined && alias !== "") out.alias = alias;
  return out;
};

const normalizeTaskDetails = (raw: unknown): Record<string, unknown> => {
  const checklistMap = prop(raw, "checklist");
  const checklist = isRecord(checklistMap)
    ? Object.entries(checklistMap).map(([id, value]) =>
        normalizeChecklistItem(id, value),
      )
    : [];
  const referenceMap = prop(raw, "references");
  const references = isRecord(referenceMap)
    ? Object.entries(referenceMap).map(([url, value]) =>
        normalizeReference(url, value),
      )
    : [];
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    etag: etagOf(raw),
    checklist,
    references,
  };
  const description = asString(path(raw, "description"));
  if (description !== undefined) out.description = description;
  return out;
};

const normalizePlan = (raw: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    etag: etagOf(raw),
    title: str(path(raw, "title")),
    created_at: str(path(raw, "createdDateTime")),
  };
  // `container.containerId` is the owning group when `type === "group"`;
  // older plans expose `owner` (the group id) instead.
  const containerId = asString(path(raw, "container", "containerId"));
  const owner = asString(path(raw, "owner"));
  const groupId = containerId ?? owner;
  if (groupId !== undefined && groupId !== "") out.group_id = groupId;
  return out;
};

const normalizeBucket = (raw: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    etag: etagOf(raw),
    name: str(path(raw, "name")),
    plan_id: str(path(raw, "planId")),
  };
  const orderHint = asString(path(raw, "orderHint"));
  if (orderHint !== undefined) out.order_hint = orderHint;
  return out;
};

/**
 * Creates / updates either echo the resource (Prefer: return=representation)
 * or 204 with the new etag in the `ETag` response header. The Nango proxy
 * returns the JSON body as `data`; we surface `id` + `etag` when present.
 * A 204 delete yields an empty body → `{}`.
 */
const writeResult: ResponseMapper = (raw) => {
  const out: Record<string, unknown> = {};
  const id = asString(prop(raw, "id"));
  if (id !== undefined) out.id = id;
  const etag = etagOf(raw);
  if (etag !== "") out.etag = etag;
  return out;
};

const listOf =
  (normalize: (raw: unknown) => Record<string, unknown>): ResponseMapper =>
  (raw) =>
    arr(path(raw, "value")).map(normalize);

const taskList = listOf(normalizeTask);
const planList = listOf(normalizePlan);
const bucketList = listOf(normalizeBucket);

export const plannerMappers: ProviderMappers = {
  request: {
    createTask,
    updateTask,
    updateTaskDetails,
    deleteTask,
    createBucket,
    createPlan,
  },
  response: {
    taskList,
    task: normalizeTask,
    taskDetails: normalizeTaskDetails,
    plan: normalizePlan,
    planList,
    bucketList,
    writeResult,
  },
};
