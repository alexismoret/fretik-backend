import { describe, expect, test } from "bun:test";
import {
  buildTriggerCatalog,
  describeTriggerConfigForAgent,
  WORKFLOW_TRIGGER_KINDS,
} from "../../src/schemas/workflow-triggers";
import {
  CreateWorkflowSchema,
  triggerConfigConsistencyError,
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
    expect(WORKFLOW_TRIGGER_KINDS.event.defaultConfig.event?.type).toBe(
      "document.uploaded",
    );
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
    expect(folder?.key).toBe("event.filter.folderId");
    expect(folder?.available).toBe(true);
  });

  test("record object-type filter is declared but not yet available", () => {
    const catalog = buildTriggerCatalog();
    const created = catalog.eventTypes.find((e) => e.type === "record.created");
    const objectType = created?.params.find((p) => p.kind === "object_type");
    expect(objectType?.available).toBe(false);
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
