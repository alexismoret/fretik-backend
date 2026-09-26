import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  admitDelegation,
  delegationTurnKey,
  releaseDelegationSlot,
  resetDelegationSlots,
} from "../../../src/agents/shared/delegation-slots";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import type { AgentRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";

/**
 * How many sub-agents one turn may run. These used to be prose ("cap parallel
 * dispatch at 3") that the step budget did not back — twelve calls a step
 * went through whatever the sentence said. The code holds them now: a
 * dispatch over the concurrency cap WAITS, one over the per-turn total is
 * REFUSED. Defaults: 5 at once, 10 per turn.
 */

const ctx = (traceId?: string): AgentRuntimeContext => ({
  organizationId: "org-1",
  teamId: "team-1",
  conversationId: "conv-1",
  modelProfile: getProfileForRole("chat"),
  dynamicToolManager: new DynamicToolManager(),
  ...(traceId === undefined ? {} : { traceId }),
});

/** Resolve after every pending microtask and timer of this tick has run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
  resetDelegationSlots();
});

afterEach(() => {
  delete process.env.DISPATCH_AGENT_MAX_CONCURRENT;
  delete process.env.DISPATCH_AGENT_MAX_PER_TURN;
});

describe("delegation slots", () => {
  test("every agent of one turn counts against the same key", () => {
    // A sub-agent's trace id is the turn's plus a suffix; the page builder's
    // too. One split folds them onto the turn.
    expect(delegationTurnKey(ctx("turn-a.sub.call_1"))).toBe("turn-a");
    expect(delegationTurnKey(ctx("turn-a"))).toBe("turn-a");
    expect(delegationTurnKey(ctx())).toBe("conv-1");
  });

  test("a dispatch over the concurrency cap waits for a slot", async () => {
    process.env.DISPATCH_AGENT_MAX_CONCURRENT = "2";
    await admitDelegation("t");
    await admitDelegation("t");
    let thirdStarted = false;
    const third = admitDelegation("t").then((verdict) => {
      thirdStarted = true;
      return verdict;
    });
    await settle();
    expect(thirdStarted).toBe(false);

    releaseDelegationSlot("t");
    expect(await third).toEqual({ admitted: true });
    expect(thirdStarted).toBe(true);
  });

  test("a slot handed to a waiter cannot be taken by a later arrival", async () => {
    // The race the handover exists for: free the slot, then let the waiter
    // take it, and a dispatch arriving in between slips past the cap.
    process.env.DISPATCH_AGENT_MAX_CONCURRENT = "1";
    await admitDelegation("t");
    const waiter = admitDelegation("t");
    releaseDelegationSlot("t");
    let lateStarted = false;
    const late = admitDelegation("t").then(() => {
      lateStarted = true;
    });
    await waiter;
    await settle();
    // The waiter holds the one slot; the late arrival queues behind it.
    expect(lateStarted).toBe(false);
    releaseDelegationSlot("t");
    await late;
    expect(lateStarted).toBe(true);
  });

  test("a dispatch over the per-turn total is refused, not queued", async () => {
    process.env.DISPATCH_AGENT_MAX_PER_TURN = "3";
    for (let i = 0; i < 3; i += 1) {
      expect(await admitDelegation("t")).toEqual({ admitted: true });
      releaseDelegationSlot("t");
    }
    expect(await admitDelegation("t")).toEqual({ admitted: false, limit: 3 });
    // Another turn has its own budget.
    expect(await admitDelegation("other")).toEqual({ admitted: true });
  });
});
