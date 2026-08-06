import { auth, runs, schedules, tasks, wait } from "@trigger.dev/sdk";
import {
  WORKFLOW_CRON_TASK_ID,
  WORKFLOW_RUN_TASK_ID,
  type WorkflowRunTaskPayload,
} from "../schemas/workflows";

/**
 * Thin wrapper over the Trigger.dev management API (server-side calls
 * authenticated by `TRIGGER_SECRET_KEY`). Every workflow interaction with
 * Trigger.dev goes through here so the env-var check + the task ids + the
 * tag/queue conventions live in one place.
 *
 * The DB is the source of truth for runs — Trigger.dev only executes. We
 * trigger by task-id STRING (never `tasks.trigger<typeof task>`) so
 * `@fretik/shared` never has to import `@fretik/workflows` (which depends
 * on shared — that would be a package cycle). The payload is typed by
 * `WorkflowRunTaskPayload` from the shared schema instead.
 */

const assertConfigured = (): void => {
  const key = process.env.TRIGGER_SECRET_KEY;
  if (key === undefined || key === "") {
    throw new Error(
      "TRIGGER_SECRET_KEY is not set — the workflow engine cannot reach Trigger.dev. Set it in this service's env.",
    );
  }
};

/** Realtime tag placed on every run so the frontend can subscribe by team. */
export const workflowTeamTag = (teamId: string): string => `team:${teamId}`;
/** Realtime tag placed on every run so the detail page can subscribe by workflow. */
export const workflowTag = (workflowId: string): string =>
  `workflow:${workflowId}`;

/**
 * Trigger a `workflow-run` orchestrator run. Bounded per workflow via
 * `concurrencyKey` (the task's queue declares the per-workflow limit); runs
 * beyond the limit wait as `queued` — that queue is the backpressure for
 * bulk-upload bursts. Tagged for realtime. Returns the Trigger run id
 * (stamped onto `workflow_runs.trigger_run_id` for cancel + subscribe) and a
 * scoped public token for the frontend.
 */
export const triggerWorkflowRun = async (
  payload: WorkflowRunTaskPayload,
  opts: { idempotencyKey?: string },
): Promise<{ runId: string; publicAccessToken: string }> => {
  assertConfigured();
  const handle = await tasks.trigger(WORKFLOW_RUN_TASK_ID, payload, {
    queue: "workflow-runs",
    concurrencyKey: payload.workflowId,
    // Explicit queue residency bound. Overrides the dev default of 10 min
    // (which would silently expire a queued burst in local testing) and
    // matches the theoretical worst case of a 500-run backlog draining at
    // the per-workflow concurrency. An expired run is reclaimed as
    // failed(EXPIRED) by the stall sweeper.
    ttl: process.env["WORKFLOW_RUN_QUEUE_TTL"] ?? "7d",
    tags: [workflowTeamTag(payload.teamId), workflowTag(payload.workflowId)],
    ...(opts.idempotencyKey !== undefined
      ? { idempotencyKey: opts.idempotencyKey }
      : {}),
  });
  return {
    runId: handle.id,
    publicAccessToken: handle.publicAccessToken,
  };
};

/**
 * Create (or update — idempotent by `deduplicationKey`) the cron schedule
 * for a workflow. `externalId` carries the workflow id so the shared
 * `workflow-cron` task can look the workflow up and fire a run. Returns the
 * Trigger schedule id (stamped onto `workflows.trigger_schedule_id`).
 */
export const createWorkflowCronSchedule = async (params: {
  workflowId: string;
  cron: string;
  timezone?: string;
}): Promise<{ scheduleId: string }> => {
  assertConfigured();
  const schedule = await schedules.create({
    task: WORKFLOW_CRON_TASK_ID,
    cron: params.cron,
    externalId: params.workflowId,
    deduplicationKey: `workflow:${params.workflowId}`,
    ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
  });
  return { scheduleId: schedule.id };
};

/** Delete a workflow's cron schedule (on pause/archive). No-op-safe: a
 * missing schedule id is ignored by the caller. */
export const deleteWorkflowSchedule = async (
  scheduleId: string,
): Promise<void> => {
  assertConfigured();
  await schedules.del(scheduleId);
};

/** Cancel an in-flight Trigger run (the Stop action). */
export const cancelWorkflowTriggerRun = async (
  triggerRunId: string,
): Promise<void> => {
  assertConfigured();
  await runs.cancel(triggerRunId);
};

/**
 * Complete a run's approval wait token so the orchestrator loop resumes.
 * Called from the approval-decision path once the user grants/rejects.
 */
export const completeWorkflowWaitToken = async (
  tokenId: string,
  decision: "approved" | "rejected",
): Promise<void> => {
  assertConfigured();
  await wait.completeToken<{ decision: "approved" | "rejected" }>(tokenId, {
    decision,
  });
};

/**
 * Mint a scoped public access token the browser uses to subscribe to a
 * team's workflow runs in realtime (`runs.subscribeToRunsWithTag`). Scoped
 * to the team tag only — never "all runs". `skipColumns` is baked into the
 * token so the browser cannot widen the projection. Also returns the Trigger
 * API base URL and the tag so the frontend needs no Trigger config of its own.
 */
export const createWorkflowRealtimeToken = async (
  teamId: string,
): Promise<{ token: string; url: string; tag: string }> => {
  assertConfigured();
  const url = process.env.TRIGGER_API_URL;
  if (url === undefined || url === "") {
    throw new Error(
      "TRIGGER_API_URL is not set — the browser cannot subscribe to Trigger.dev realtime. Set it in this service's env.",
    );
  }
  const token = await auth.createPublicToken({
    scopes: { read: { tags: [workflowTeamTag(teamId)] } },
    expirationTime: "1hr",
    realtime: { skipColumns: ["payload", "output"] },
  });
  return { token, url, tag: workflowTeamTag(teamId) };
};
