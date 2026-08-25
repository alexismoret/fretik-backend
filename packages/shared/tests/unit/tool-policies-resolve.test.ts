import { describe, expect, test } from "bun:test";
import type { ToolPolicyLevel } from "../../src/schemas/tool-policies";
import type { WorkflowAutonomy } from "../../src/schemas/workflows";
import {
  resolveBuiltinToolPolicy,
  resolveConnectionActionPolicy,
  resolveToolPolicy,
} from "../../src/services/tool-policies/resolve";

/**
 * The full precedence matrix. `blocked` override is absolute; otherwise
 * autonomy governs writes only (read + plain chat pass the base through).
 */

const AUTONOMIES: (WorkflowAutonomy | null)[] = [
  null,
  "read_only",
  "approval_required",
  "autonomous",
];

describe("resolveToolPolicy — blocked override is absolute", () => {
  for (const autonomy of AUTONOMIES) {
    for (const kind of ["read", "write"] as const) {
      test(`blocked stays blocked (autonomy=${autonomy}, kind=${kind})`, () => {
        expect(
          resolveToolPolicy({
            kind,
            defaultLevel: "auto",
            override: "blocked",
            autonomy,
          }),
        ).toBe("blocked");
      });
    }
  }
});

describe("resolveToolPolicy — reads ignore autonomy", () => {
  for (const autonomy of AUTONOMIES) {
    test(`read default auto stays auto (autonomy=${autonomy})`, () => {
      expect(
        resolveToolPolicy({
          kind: "read",
          defaultLevel: "auto",
          override: undefined,
          autonomy,
        }),
      ).toBe("auto");
    });
    test(`read override approval stays approval (autonomy=${autonomy})`, () => {
      expect(
        resolveToolPolicy({
          kind: "read",
          defaultLevel: "auto",
          override: "approval",
          autonomy,
        }),
      ).toBe("approval");
    });
  }
});

describe("resolveToolPolicy — plain chat passes base through", () => {
  const cases: [
    ToolPolicyLevel | undefined,
    ToolPolicyLevel,
    ToolPolicyLevel,
  ][] = [
    [undefined, "approval", "approval"], // write default
    [undefined, "auto", "auto"], // read default
    ["auto", "approval", "auto"], // override wins
    ["approval", "auto", "approval"], // override wins
  ];
  for (const [override, def, expected] of cases) {
    test(`override=${override} default=${def} → ${expected}`, () => {
      expect(
        resolveToolPolicy({
          kind: "write",
          defaultLevel: def,
          override,
          autonomy: null,
        }),
      ).toBe(expected);
    });
  }
});

describe("resolveToolPolicy — writes under workflow autonomy", () => {
  test("read_only hides every write (→ blocked)", () => {
    for (const base of ["auto", "approval"] as const) {
      expect(
        resolveToolPolicy({
          kind: "write",
          defaultLevel: base,
          override: undefined,
          autonomy: "read_only",
        }),
      ).toBe("blocked");
    }
  });

  test("approval_required escalates auto → approval, leaves approval", () => {
    expect(
      resolveToolPolicy({
        kind: "write",
        defaultLevel: "auto",
        override: undefined,
        autonomy: "approval_required",
      }),
    ).toBe("approval");
    expect(
      resolveToolPolicy({
        kind: "write",
        defaultLevel: "approval",
        override: undefined,
        autonomy: "approval_required",
      }),
    ).toBe("approval");
  });

  test("autonomous auto-grants (approval → auto), leaves auto", () => {
    expect(
      resolveToolPolicy({
        kind: "write",
        defaultLevel: "approval",
        override: undefined,
        autonomy: "autonomous",
      }),
    ).toBe("auto");
    expect(
      resolveToolPolicy({
        kind: "write",
        defaultLevel: "auto",
        override: undefined,
        autonomy: "autonomous",
      }),
    ).toBe("auto");
  });

  test("autonomous never resurrects a blocked override", () => {
    expect(
      resolveToolPolicy({
        kind: "write",
        defaultLevel: "approval",
        override: "blocked",
        autonomy: "autonomous",
      }),
    ).toBe("blocked");
  });
});

describe("resolveBuiltinToolPolicy — catalog-driven", () => {
  test("write tool defaults to approval in chat", () => {
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageRecord",
        teamPolicies: {},
        autonomy: null,
      }),
    ).toBe("approval");
  });

  test("read tool defaults to auto in chat", () => {
    expect(
      resolveBuiltinToolPolicy({
        toolName: "listRecords",
        teamPolicies: {},
        autonomy: null,
      }),
    ).toBe("auto");
  });

  test("team override applies", () => {
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageDrive",
        teamPolicies: { manageDrive: "blocked" },
        autonomy: null,
      }),
    ).toBe("blocked");
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageDrive",
        teamPolicies: { manageDrive: "auto" },
        autonomy: null,
      }),
    ).toBe("auto");
  });

  test("infra tool (not in catalog) is always auto", () => {
    expect(
      resolveBuiltinToolPolicy({
        toolName: "python",
        teamPolicies: { python: "blocked" }, // ignored — not policy-managed
        autonomy: null,
      }),
    ).toBe("auto");
  });
});

describe("resolveConnectionActionPolicy — manifest defaults + overrides", () => {
  test("read action defaults to auto", () => {
    expect(
      resolveConnectionActionPolicy({
        action: { name: "list_messages", kind: "read" },
        actionPolicies: null,
        autonomy: null,
      }),
    ).toBe("auto");
  });

  test("write action defaults to approval", () => {
    expect(
      resolveConnectionActionPolicy({
        action: { name: "send_email", kind: "write" },
        actionPolicies: null,
        autonomy: null,
      }),
    ).toBe("approval");
  });

  test("connection override blocks a read", () => {
    expect(
      resolveConnectionActionPolicy({
        action: { name: "list_messages", kind: "read" },
        actionPolicies: { list_messages: "blocked" },
        autonomy: null,
      }),
    ).toBe("blocked");
  });

  test("autonomous auto-grants a write action", () => {
    expect(
      resolveConnectionActionPolicy({
        action: { name: "send_email", kind: "write" },
        actionPolicies: null,
        autonomy: "autonomous",
      }),
    ).toBe("auto");
  });
});
