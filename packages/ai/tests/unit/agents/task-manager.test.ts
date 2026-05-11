import { describe, expect, test } from "bun:test";
import {
  TaskManager,
  type Task,
} from "../../../src/agents/shared/task-manager";

const t = (content: string, status: Task["status"] = "pending"): Task => ({
  content,
  activeForm: `${content} (ing)`,
  status,
});

describe("TaskManager", () => {
  test("empty snapshot by default", () => {
    const m = new TaskManager();
    expect(m.getSnapshot()).toEqual([]);
  });

  test("setTasks() stores and returns the list in order", () => {
    const m = new TaskManager();
    const result = m.setTasks([t("a"), t("b"), t("c")]);
    expect(result.map((x) => x.content)).toEqual(["a", "b", "c"]);
    expect(m.getSnapshot().map((x) => x.content)).toEqual(["a", "b", "c"]);
  });

  test("setTasks() is full-replace semantics", () => {
    const m = new TaskManager();
    m.setTasks([t("a"), t("b")]);
    m.setTasks([t("c")]);
    expect(m.getSnapshot().map((x) => x.content)).toEqual(["c"]);
  });

  test("clear() removes every task", () => {
    const m = new TaskManager();
    m.setTasks([t("a"), t("b")]);
    m.clear();
    expect(m.getSnapshot()).toEqual([]);
  });

  test("setTasks() deep-copies input so outside mutations don't leak in", () => {
    const m = new TaskManager();
    const input = [t("a"), t("b")];
    m.setTasks(input);
    const firstInput = input[0];
    if (!firstInput) throw new Error("fixture invariant: input[0] exists");
    firstInput.status = "completed";
    const firstSnapshot = m.getSnapshot()[0];
    if (!firstSnapshot) throw new Error("invariant: snapshot[0] exists");
    expect(firstSnapshot.status).toBe("pending");
  });

  test("getSnapshot() returns a fresh copy each call", () => {
    const m = new TaskManager();
    m.setTasks([t("a")]);
    const s1 = m.getSnapshot();
    s1.push(t("rogue"));
    expect(m.getSnapshot()).toHaveLength(1);
  });

  test("setTasks() returns a fresh array independent of the internal state", () => {
    const m = new TaskManager();
    const result = m.setTasks([t("a")]);
    result.push(t("rogue"));
    expect(m.getSnapshot()).toHaveLength(1);
  });

  test("parallel setTasks() resolves to last-writer-wins without partial state", async () => {
    // Concurrency contract: full-replacement semantics means two
    // parallel setTasks calls end in the state of whichever executed
    // last — identical to a single call with that list. Verify by
    // racing 20 concurrent submissions and checking the final state
    // is a verbatim copy of one of the inputs (never a merge or a
    // partial overwrite).
    const m = new TaskManager();
    const submissions = Array.from({ length: 20 }, (_, i) => [
      t(`run-${String(i)}-step-1`),
      t(`run-${String(i)}-step-2`),
    ]);
    await Promise.all(
      submissions.map(
        (list) =>
          new Promise<void>((resolve) => {
            queueMicrotask(() => {
              m.setTasks(list);
              resolve();
            });
          }),
      ),
    );
    const final = m.getSnapshot();
    expect(final).toHaveLength(2);
    const matchedSubmission = submissions.find(
      (sub) =>
        sub[0]?.content === final[0]?.content &&
        sub[1]?.content === final[1]?.content,
    );
    expect(matchedSubmission).toBeDefined();
  });
});
