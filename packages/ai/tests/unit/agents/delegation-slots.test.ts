import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  claimDispatch,
  delegationTurnKey,
  resetDelegationSlots,
} from "../../../src/agents/shared/delegation-slots";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import type { AgentRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";

/**
 * How many sub-agents one turn may start. This used to be prose ("cap
 * parallel dispatch at 3") that the step budget did not back — twelve calls a
 * step went through whatever the sentence said. The code holds it now: a
 * dispatch over the per-turn total is REFUSED. Default: 10 per turn.
 */

const ctx = (traceId?: string): AgentRuntimeContext => ({
  organizationId: "org-1",
  teamId: "team-1",
  conversationId: "conv-1",
  modelProfile: getProfileForRole("chat"),
  dynamicToolManager: new DynamicToolManager(),
  ...(traceId === undefined ? {} : { traceId }),
});

beforeEach(() => {
  resetDelegationSlots();
});

afterEach(() => {
  delete process.env.DISPATCH_AGENT_MAX_PER_TURN;
});

describe("delegation slots", () => {
  test("every agent of one turn counts against the same key", () => {
    // A delegate's trace id is the turn's plus a suffix (the page builder's).
    // One split folds them onto the turn.
    expect(delegationTurnKey(ctx("turn-a.page"))).toBe("turn-a");
    expect(delegationTurnKey(ctx("turn-a"))).toBe("turn-a");
    expect(delegationTurnKey(ctx())).toBe("conv-1");
  });

  test("a dispatch over the per-turn total is refused", () => {
    process.env.DISPATCH_AGENT_MAX_PER_TURN = "3";
    for (let i = 0; i < 3; i += 1) {
      expect(claimDispatch("t")).toEqual({ admitted: true });
    }
    expect(claimDispatch("t")).toEqual({ admitted: false, limit: 3 });
    // Another turn has its own budget.
    expect(claimDispatch("other")).toEqual({ admitted: true });
  });
});
