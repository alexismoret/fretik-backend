import { describe, expect, test } from "bun:test";
import {
  buildTriggerCatalog,
  describeTriggerConfigForAgent,
  WORKFLOW_TRIGGER_KINDS,
} from "../../src/schemas/workflow-triggers";
import {
  CreateWorkflowSchema,
  eventSubscriptions,
  triggerConfigConsistencyError,
  workflowEventActivationError,
} from "../../src/schemas/workflows";

/**
 * The trigger registry is the single source of truth the editor, the agent
 * catalog, and the write-path validation all read from. These guard its shape
 * so a drift (a kind losing its config default, the folder param disappearing,
 * or the type↔config consistency check loosening) turns red.
 */

const basePlaybook = {
  goal: "do the thing",
  tasks: [{ key: "t1", title: "Task", instructions: "do it" }],
};

describe("trigger catalog", () => {
  test("exposes every kind with its config defaults", () => {
    const catalog = buildTriggerCatalog();
    expect(catalog.triggerTypes.map((k) => k.type)).toEqual([
      "manual",
      "cron",
      "event",
      "form",
    ]);
    expect(WORKFLOW_TRIGGER_KINDS.cron.requiresSchedule).toBe(true);
    expect(WORKFLOW_TRIGGER_KINDS.cron.defaultConfig.cron?.pattern).toMatch(
      /^\S+ \S+ \S+ \S+ \S+$/,
    );
    expect(
      WORKFLOW_TRIGGER_KINDS.event.defaultConfig.event?.events?.[0]?.type,
    ).toBe("document.uploaded");
    expect(WORKFLOW_TRIGGER_KINDS.form.requiresSchedule).toBe(false);
    expect(WORKFLOW_TRIGGER_KINDS.form.defaultConfig.form?.visibility).toBe(
      "private",
    );
  });

  test("exposes the form field type catalog", () => {
    const catalog = buildTriggerCatalog();
    const types = catalog.formFieldTypes.map((f) => f.type);
    expect(types).toContain("short_text");
    expect(types).toContain("file");
    const file = catalog.formFieldTypes.find((f) => f.type === "file");
    expect(file?.constraints).toContain("maxFiles");
  });

  test("document.uploaded declares an available folder filter param", () => {
    const catalog = buildTriggerCatalog();
    const uploaded = catalog.eventTypes.find(
      (e) => e.type === "document.uploaded",
    );
    const folder = uploaded?.params.find((p) => p.kind === "folder");
    // Rooted at ONE subscription, not at triggerConfig: an event trigger holds
    // a list of them and each is filtered on its own.
    expect(folder?.key).toBe("filter.folderId");
    expect(folder?.available).toBe(true);
  });

  test("record object-type filter is declared but not yet available", () => {
    const catalog = buildTriggerCatalog();
    const created = catalog.eventTypes.find((e) => e.type === "record.created");
    const collection = created?.params.find((p) => p.kind === "collection");
    expect(collection?.available).toBe(false);
  });

  test("agent describe names every kind + the folder filter key", () => {
    const describe = describeTriggerConfigForAgent();
    expect(describe).toContain("manual");
    expect(describe).toContain("cron");
    expect(describe).toContain("event");
    expect(describe).toContain("form");
    expect(describe).toContain("document.uploaded");
    expect(describe).toContain("folderId");
  });
});

describe("trigger type ↔ config consistency", () => {
  test("empty config is consistent with any type", () => {
    expect(triggerConfigConsistencyError("manual", {})).toBeNull();
    expect(triggerConfigConsistencyError("cron", {})).toBeNull();
    expect(triggerConfigConsistencyError("event", {})).toBeNull();
  });

  test("matching config passes", () => {
    expect(
      triggerConfigConsistencyError("cron", { cron: { pattern: "0 9 * * *" } }),
    ).toBeNull();
    expect(
      triggerConfigConsistencyError("event", {
        event: { type: "document.uploaded" },
      }),
    ).toBeNull();
  });

  test("a sibling config under the wrong type is rejected", () => {
    expect(
      triggerConfigConsistencyError("event", {
        cron: { pattern: "0 9 * * *" },
      }),
    ).toContain("triggerConfig.cron");
    expect(
      triggerConfigConsistencyError("manual", {
        event: { type: "document.uploaded" },
      }),
    ).toContain("triggerConfig.event");
    expect(
      triggerConfigConsistencyError("cron", {
        form: { title: "T", fields: [], visibility: "public" },
      }),
    ).toContain("triggerConfig.form");
  });

  test("CreateWorkflowSchema enforces the same check", () => {
    expect(
      CreateWorkflowSchema.safeParse({
        name: "W",
        playbook: basePlaybook,
        triggerType: "event",
        triggerConfig: { cron: { pattern: "0 9 * * *" } },
      }).success,
    ).toBe(false);

    expect(
      CreateWorkflowSchema.safeParse({
        name: "W",
        playbook: basePlaybook,
        triggerType: "event",
        triggerConfig: {
          event: { type: "document.uploaded", filter: { folderId: "abc" } },
        },
      }).success,
    ).toBe(true);
  });
});

/**
 * An event trigger holds a LIST of subscriptions, and rows written before that
 * landed hold a single `type` + `filter`. `eventSubscriptions` is the one place
 * the two collapse — every other consumer (the matcher, the card text, the
 * editor summary) reads through it, so what it returns IS what a workflow
 * listens for.
 */
describe("eventSubscriptions", () => {
  test("returns the list as authored", () => {
    expect(
      eventSubscriptions({
        event: {
          events: [
            { type: "document.uploaded", filter: { folderId: "f1" } },
            { type: "document.revised" },
          ],
        },
      }),
    ).toEqual([
      { type: "document.uploaded", filter: { folderId: "f1" } },
      { type: "document.revised" },
    ]);
  });

  test("lifts a legacy single event into a one-entry list", () => {
    expect(
      eventSubscriptions({
        event: { type: "record.created", filter: { status: "new" } },
      }),
    ).toEqual([{ type: "record.created", filter: { status: "new" } }]);
  });

  test("a legacy event with no filter carries none", () => {
    expect(eventSubscriptions({ event: { type: "record.created" } })).toEqual([
      { type: "record.created" },
    ]);
  });

  test("nothing to listen for is an empty list, never a throw", () => {
    expect(eventSubscriptions(undefined)).toEqual([]);
    expect(eventSubscriptions({})).toEqual([]);
    expect(eventSubscriptions({ event: {} })).toEqual([]);
    expect(eventSubscriptions({ event: { events: [] } })).toEqual([]);
  });
});

describe("event trigger activation gate", () => {
  test("an empty subscription list cannot go live", () => {
    expect(workflowEventActivationError({ event: { events: [] } })).toContain(
      "at least one event",
    );
    expect(workflowEventActivationError({})).not.toBeNull();
  });

  test("one subscription is enough — in either shape", () => {
    expect(
      workflowEventActivationError({
        event: { events: [{ type: "document.uploaded" }] },
      }),
    ).toBeNull();
    expect(
      workflowEventActivationError({ event: { type: "document.uploaded" } }),
    ).toBeNull();
  });
});

describe("event trigger config validation", () => {
  const withEvents = (event: unknown) =>
    CreateWorkflowSchema.safeParse({
      name: "W",
      playbook: basePlaybook,
      triggerType: "event",
      triggerConfig: { event },
    });

  test("a list of triggerable events is accepted", () => {
    expect(
      withEvents({
        events: [
          { type: "document.uploaded", filter: { folderId: "abc" } },
          { type: "document.revised" },
        ],
      }).success,
    ).toBe(true);
  });

  test("an empty list is accepted — the editor autosaves mid-build", () => {
    expect(withEvents({ events: [] }).success).toBe(true);
  });

  test("a typo in ONE entry rejects the whole config", () => {
    // The point of validating the type at write: a workflow that never fires
    // is indistinguishable from one that has nothing to do yet.
    expect(
      withEvents({
        events: [{ type: "document.uploaded" }, { type: "document.uplaoded" }],
      }).success,
    ).toBe(false);
  });
});
