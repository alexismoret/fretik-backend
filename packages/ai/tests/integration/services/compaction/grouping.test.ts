import type { UIMessage } from "ai";
import { describe, expect, test } from "bun:test";
import {
  dropOldestRounds,
  groupMessagesByApiRound,
} from "../../../../src/services/compaction/grouping";

const userMsg = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const assistantMsg = (id: string, text: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});

const systemMsg = (id: string, text: string): UIMessage => ({
  id,
  role: "system",
  parts: [{ type: "text", text }],
});

describe("groupMessagesByApiRound", () => {
  test("empty input returns empty array", () => {
    expect(groupMessagesByApiRound([])).toEqual([]);
  });

  test("single user message becomes one group", () => {
    const msgs = [userMsg("u1", "hello")];
    const groups = groupMessagesByApiRound(msgs);
    expect(groups.length).toBe(1);
    expect(groups[0]).toEqual(msgs);
  });

  test("user + assistant + assistant becomes one group", () => {
    const msgs = [
      userMsg("u1", "hello"),
      assistantMsg("a1", "tool call"),
      assistantMsg("a2", "answer"),
    ];
    const groups = groupMessagesByApiRound(msgs);
    expect(groups.length).toBe(1);
    expect(groups[0]?.length).toBe(3);
  });

  test("three user turns produce three groups", () => {
    const msgs = [
      userMsg("u1", "q1"),
      assistantMsg("a1", "r1"),
      userMsg("u2", "q2"),
      assistantMsg("a2", "r2"),
      userMsg("u3", "q3"),
      assistantMsg("a3", "r3"),
    ];
    const groups = groupMessagesByApiRound(msgs);
    expect(groups.length).toBe(3);
    expect(groups[0]?.[0]?.id).toBe("u1");
    expect(groups[1]?.[0]?.id).toBe("u2");
    expect(groups[2]?.[0]?.id).toBe("u3");
  });

  test("leading non-user messages form an initial pre-user group", () => {
    const msgs = [systemMsg("s1", "you are..."), userMsg("u1", "hello")];
    const groups = groupMessagesByApiRound(msgs);
    expect(groups.length).toBe(2);
    expect(groups[0]?.[0]?.id).toBe("s1");
    expect(groups[1]?.[0]?.id).toBe("u1");
  });

  test("trailing user message with no assistant reply still forms a group", () => {
    const msgs = [
      userMsg("u1", "q1"),
      assistantMsg("a1", "r1"),
      userMsg("u2", "q2 — pending"),
    ];
    const groups = groupMessagesByApiRound(msgs);
    expect(groups.length).toBe(2);
    expect(groups[1]?.[0]?.id).toBe("u2");
  });
});

describe("dropOldestRounds", () => {
  test("empty input returns empty array, droppedRounds=0", () => {
    const { messages, droppedRounds } = dropOldestRounds([], 0.2);
    expect(messages).toEqual([]);
    expect(droppedRounds).toBe(0);
  });

  test("single round cannot be dropped (we always keep at least 1)", () => {
    const msgs = [userMsg("u1", "q1"), assistantMsg("a1", "r1")];
    const { messages, droppedRounds } = dropOldestRounds(msgs, 0.5);
    expect(droppedRounds).toBe(0);
    expect(messages).toBe(msgs);
  });

  test("five rounds × 20% drops one (ceil)", () => {
    const msgs: UIMessage[] = [];
    for (let i = 1; i <= 5; i++) {
      msgs.push(userMsg(`u${i.toString()}`, `q${i.toString()}`));
      msgs.push(assistantMsg(`a${i.toString()}`, `r${i.toString()}`));
    }
    const { messages, droppedRounds } = dropOldestRounds(msgs, 0.2);
    expect(droppedRounds).toBe(1);
    expect(messages.length).toBe(8);
    // First surviving message should be the 2nd user turn.
    expect(messages[0]?.id).toBe("u2");
  });

  test("drop fraction is clamped to (0.05, 0.9)", () => {
    const msgs: UIMessage[] = [];
    for (let i = 1; i <= 10; i++) {
      msgs.push(userMsg(`u${i.toString()}`, `q${i.toString()}`));
      msgs.push(assistantMsg(`a${i.toString()}`, `r${i.toString()}`));
    }
    // Asking for 100% (1.0) is clamped to 0.9 → drops 9 of 10.
    const { droppedRounds } = dropOldestRounds(msgs, 1.0);
    expect(droppedRounds).toBe(9);
  });

  test("never empties the array — always leaves at least one round", () => {
    const msgs = [
      userMsg("u1", "q1"),
      userMsg("u2", "q2"),
      userMsg("u3", "q3"),
    ];
    const { messages } = dropOldestRounds(msgs, 0.9);
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });
});
