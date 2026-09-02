import type { DomainEvent, Workflow } from "@fretik/shared/db/schema";
import { describe, expect, test } from "bun:test";
import {
  buildTriggerJobs,
  isImportedRecord,
  isWorkflowOriginated,
  matchesEvent,
  pairWorkflowsWithEvents,
  selectTriggerCandidates,
  triggerRunKey,
} from "../../src/lib/workflow-trigger-matching";

/**
 * The event-trigger bridge's decisions.
 *
 * These rules decide whether a journal entry becomes a workflow run, and two of
 * their failure modes have no floor under them: a workflow that triggers on its
 * own output runs forever, and a bulk import of 200 000 rows fires 200 000
 * runs. Neither is caught by a type, and until 2026-09-02 neither was caught by
 * a test — the predicates lived unexported inside the sweep, behind a cursor
 * read, three queries and a BullMQ enqueue.
 *
 * They are pure, so this file runs with no database, no Redis and no queue: the
 * only `@fretik/shared` import is a type, which is erased.
 */

const event = (over: Partial<DomainEvent>): DomainEvent => ({
  id: "00000000-0000-0000-0000-0000000000e1",
  organizationId: "org-1",
  teamId: "team-1",
  type: "record.created",
  actorType: "user",
  actorUserId: null,
  agentKey: null,
  conversationId: null,
  subjectType: null,
  subjectRecordId: null,
  payload: {},
  occurredAt: new Date("2026-09-02T10:00:00Z"),
  recordedAt: new Date("2026-09-02T10:00:01Z"),
  dedupKey: null,
  ...over,
});

const workflow = (over: Partial<Workflow>): Workflow => ({
  id: "00000000-0000-0000-0000-0000000000w1",
  organizationId: "org-1",
  teamId: "team-1",
  userId: null,
  name: "Subject",
  description: "",
  icon: null,
  color: null,
  status: "active",
  triggerType: "event",
  triggerConfig: {},
  playbook: {
    goal: "g",
    tasks: [{ key: "t", title: "T", description: "", instructions: "i" }],
  },
  autonomy: "approval_required",
  modelProfileKey: null,
  reasoningLevel: null,
  limits: {},
  notifications: {
    emailOnCompletion: false,
    notifyTriggeredBy: false,
    recipientUserIds: [],
  },
  triggerScheduleId: null,
  formToken: null,
  pausedReason: null,
  createdByUserId: null,
  lastRunAt: null,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
  ...over,
});

describe("isWorkflowOriginated — the anti-loop guard", () => {
  test("an event a run wrote as itself is skipped", () => {
    expect(isWorkflowOriginated(event({ actorType: "workflow" }))).toBe(true);
  });

  test("an event carrying a workflow agent key is skipped", () => {
    expect(isWorkflowOriginated(event({ agentKey: "workflow:abc-123" }))).toBe(
      true,
    );
  });

  test("a human's event is not", () => {
    expect(isWorkflowOriginated(event({}))).toBe(false);
  });

  test("an agent key that merely CONTAINS the word is not a workflow's", () => {
    // The check is a prefix, and it has to stay one: `chatbot:workflow-help`
    // is the assistant talking about workflows, not a run writing its own
    // journal. Treating it as self-originated would silently stop a legitimate
    // trigger, which is the failure nobody reports because nothing happens.
    expect(
      isWorkflowOriginated(event({ agentKey: "chatbot:workflow-help" })),
    ).toBe(false);
  });
});

describe("isImportedRecord", () => {
  test("a bulk import's writes do not fire triggers", () => {
    expect(isImportedRecord(event({ agentKey: "import:op-42" }))).toBe(true);
  });

  test("an ordinary agent write does", () => {
    expect(isImportedRecord(event({ agentKey: "chatbot:xyz" }))).toBe(false);
    expect(isImportedRecord(event({ agentKey: null }))).toBe(false);
  });
});

describe("matchesEvent", () => {
  const listener = (config: Workflow["triggerConfig"]["event"]): Workflow =>
    workflow({ triggerConfig: { event: config } });

  test("a workflow with no event config never matches", () => {
    expect(matchesEvent(workflow({}), event({}))).toBe(false);
  });

  test("the type must be equal, not merely similar", () => {
    const w = listener({ type: "record.created" });
    expect(matchesEvent(w, event({ type: "record.created" }))).toBe(true);
    expect(matchesEvent(w, event({ type: "record.created.v2" }))).toBe(false);
    expect(matchesEvent(w, event({ type: "record.updated" }))).toBe(false);
  });

  test("no filter means every event of that type", () => {
    expect(
      matchesEvent(
        listener({ type: "record.created" }),
        event({ payload: { collection: "invoices" } }),
      ),
    ).toBe(true);
  });

  test("every filter entry must match — one miss is a miss", () => {
    const w = listener({
      type: "record.created",
      filter: { collection: "invoices", status: "new" },
    });
    expect(
      matchesEvent(
        w,
        event({ payload: { collection: "invoices", status: "new" } }),
      ),
    ).toBe(true);
    expect(
      matchesEvent(
        w,
        event({ payload: { collection: "invoices", status: "old" } }),
      ),
    ).toBe(false);
    // A filtered key the payload does not carry at all is a miss, not a pass:
    // the alternative would fire the workflow on every event of the type the
    // day the producer stops sending that field.
    expect(
      matchesEvent(w, event({ payload: { collection: "invoices" } })),
    ).toBe(false);
  });
});

describe("selectTriggerCandidates", () => {
  const none: ReadonlySet<string> = new Set();

  test("keeps an ordinary event", () => {
    const e = event({});
    expect(selectTriggerCandidates([e], none)).toEqual([e]);
  });

  test("drops a workflow's own event and a bulk import's", () => {
    expect(
      selectTriggerCandidates(
        [event({ actorType: "workflow" }), event({ agentKey: "import:1" })],
        none,
      ),
    ).toEqual([]);
  });

  test("drops an event written under a workflow run's conversation", () => {
    // THE loop-closer. A run's own SDK and sub-agent writes carry neither
    // `actorType: "workflow"` nor a `workflow:` key — they look exactly like a
    // human's. Only the conversation gives them away, and if this exclusion
    // ever stops working the workflow re-triggers on its own turn output, in a
    // loop that costs money on every lap.
    const inner = event({ conversationId: "conv-run-1" });
    const unrelated = event({ conversationId: "conv-chat-9" });
    expect(
      selectTriggerCandidates([inner, unrelated], new Set(["conv-run-1"])),
    ).toEqual([unrelated]);
  });

  test("an event with no conversation is never excluded by that rule", () => {
    const e = event({ conversationId: null });
    expect(selectTriggerCandidates([e], new Set(["conv-run-1"]))).toEqual([e]);
  });
});

describe("pairWorkflowsWithEvents", () => {
  test("a workflow only ever sees its own team's events", () => {
    // The scoping claim, made where it is decided. The sweep reads events for
    // many teams in one batch, so a bug here is not a missed trigger — it is
    // one workspace's workflow running on another workspace's data.
    const mine = workflow({
      id: "w-mine",
      teamId: "team-1",
      triggerConfig: { event: { type: "record.created" } },
    });
    const theirs = workflow({
      id: "w-theirs",
      teamId: "team-2",
      triggerConfig: { event: { type: "record.created" } },
    });
    const pairs = pairWorkflowsWithEvents(
      [event({ id: "e1", teamId: "team-1" })],
      [mine, theirs],
    );
    expect(pairs.map((p) => p.workflow.id)).toEqual(["w-mine"]);
  });

  test("one event can fan out to several workflows of the same team", () => {
    const config = { event: { type: "record.created" } };
    const pairs = pairWorkflowsWithEvents(
      [event({ id: "e1" })],
      [
        workflow({ id: "w1", triggerConfig: config }),
        workflow({ id: "w2", triggerConfig: config }),
      ],
    );
    expect(pairs.map((p) => p.workflow.id).sort()).toEqual(["w1", "w2"]);
  });

  test("a non-matching config produces no pair", () => {
    expect(
      pairWorkflowsWithEvents(
        [event({ type: "record.updated" })],
        [workflow({ triggerConfig: { event: { type: "record.created" } } })],
      ),
    ).toEqual([]);
  });

  test("no workflows, or no events, is an empty result rather than a throw", () => {
    expect(pairWorkflowsWithEvents([], [workflow({})])).toEqual([]);
    expect(pairWorkflowsWithEvents([event({})], [])).toEqual([]);
  });
});

describe("buildTriggerJobs", () => {
  const pair = {
    workflow: workflow({ id: "w1" }),
    event: event({ id: "e1", payload: { collection: "invoices" } }),
  };

  test("the jobId IS the dedup key the database enforces", () => {
    // Three mechanisms dedup a replayed sweep — the partial unique index on
    // (workflow_id, source_event_id), the `existing` set, and this jobId — and
    // they only work as one if they agree on the identity. If the jobId drifted
    // from `(workflow, event)`, a replayed batch would enqueue duplicates that
    // only Postgres would reject, after the Trigger.dev call had been paid for.
    const [job] = buildTriggerJobs([pair], new Set());
    expect(job?.opts?.jobId).toBe("wfrun-w1-e1");
    expect(triggerRunKey("w1", "e1")).toBe("w1:e1");
  });

  test("a pair that already has a run is skipped", () => {
    expect(
      buildTriggerJobs([pair], new Set([triggerRunKey("w1", "e1")])),
    ).toEqual([]);
  });

  test("the job carries the event payload as the trigger payload", () => {
    const [job] = buildTriggerJobs([pair], new Set());
    expect(job?.data).toEqual({
      workflowId: "w1",
      teamId: "team-1",
      sourceEventId: "e1",
      triggerPayload: { collection: "invoices" },
    });
  });

  test("retries are bounded and both retention caps are set", () => {
    // An unbounded `attempts` on a job that calls Trigger.dev turns one bad
    // event into a permanent retry loop; a missing retention cap grows the
    // BullMQ key set without limit. Neither surfaces as a failure — the queue
    // just gets slower and Redis gets bigger.
    const [job] = buildTriggerJobs([pair], new Set());
    expect(job?.opts?.attempts).toBe(3);
    expect(job?.opts?.removeOnComplete).toEqual({ count: 500 });
    expect(job?.opts?.removeOnFail).toEqual({ count: 500 });
  });
});
