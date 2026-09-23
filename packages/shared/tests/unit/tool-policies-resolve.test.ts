import { describe, expect, test } from "bun:test";
import {
  BUILTIN_TOOL_POLICY_CATALOG,
  type ToolPolicyLevel,
} from "../../src/schemas/tool-policies";
import type { WorkflowAutonomy } from "../../src/schemas/workflows";
import {
  strListOrSingle,
  TOOL_CALL_APPLY,
} from "../../src/services/tool-policies/builtin-apply";
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

describe("resolveBuiltinToolPolicy — per-action levels", () => {
  test("an action's default beats the tool's", () => {
    // manageDrive is a write tool (default approval) whose non-destructive
    // actions are catalogued `auto`.
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageDrive",
        action: "renameFolder",
        teamPolicies: {},
        autonomy: null,
      }),
    ).toBe("auto");
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageDrive",
        action: "deleteFolder",
        teamPolicies: {},
        autonomy: null,
      }),
    ).toBe("approval");
  });

  test("an uncatalogued action falls back to the tool default", () => {
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageDrive",
        action: "somethingNew",
        teamPolicies: {},
        autonomy: null,
      }),
    ).toBe("approval");
  });

  test("no action given → tool default", () => {
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageDrive",
        teamPolicies: {},
        autonomy: null,
      }),
    ).toBe("approval");
  });

  test("an action override beats a tool override", () => {
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageDrive",
        action: "deleteFolder",
        teamPolicies: {
          manageDrive: "approval",
          "manageDrive.deleteFolder": "auto",
        },
        autonomy: null,
      }),
    ).toBe("auto");
  });

  test("a tool override beats an action default (a hardened team stays hardened)", () => {
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageDrive",
        action: "renameFolder",
        teamPolicies: { manageDrive: "approval" },
        autonomy: null,
      }),
    ).toBe("approval");
  });

  test("a tool-wide block is absolute, even over an action override", () => {
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageDrive",
        action: "renameFolder",
        teamPolicies: {
          manageDrive: "blocked",
          "manageDrive.renameFolder": "auto",
        },
        autonomy: null,
      }),
    ).toBe("blocked");
  });

  test("an action key on a tool with no actions is ignored", () => {
    // manageRecord declares no per-action entries: every action stays gated.
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageRecord",
        action: "create",
        teamPolicies: { "manageRecord.create": "auto" },
        autonomy: null,
      }),
    ).toBe("auto"); // the override still applies — it is a valid map key
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageRecord",
        action: "create",
        teamPolicies: {},
        autonomy: null,
      }),
    ).toBe("approval");
  });

  test("workflow autonomy still governs an auto action default", () => {
    // A generous chat default must not loosen a run.
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageDocument",
        action: "update",
        teamPolicies: {},
        autonomy: "approval_required",
      }),
    ).toBe("approval");
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageDocument",
        action: "update",
        teamPolicies: {},
        autonomy: "read_only",
      }),
    ).toBe("blocked");
  });

  test("uploadToDrive defaults to auto tool-wide", () => {
    expect(
      resolveBuiltinToolPolicy({
        toolName: "uploadToDrive",
        teamPolicies: {},
        autonomy: null,
      }),
    ).toBe("auto");
  });

  test("config tools gate their destructive actions only", () => {
    // Editing a schema is routine; dropping one takes the data with it.
    for (const [toolName, action] of [
      ["manageCollection", "delete"],
      ["manageField", "delete"],
      ["manageField", "changeType"],
    ] as const) {
      expect(
        resolveBuiltinToolPolicy({
          toolName,
          action,
          teamPolicies: {},
          autonomy: null,
        }),
      ).toBe("approval");
    }
    for (const [toolName, action] of [
      ["manageCollection", "create"],
      ["manageCollection", "update"],
      ["manageField", "add"],
      ["manageField", "update"],
    ] as const) {
      expect(
        resolveBuiltinToolPolicy({
          toolName,
          action,
          teamPolicies: {},
          autonomy: null,
        }),
      ).toBe("auto");
    }
  });

  test("manageSync asks only before overriding the orphan floor", () => {
    // Declaring, re-pointing, refreshing or detaching a source removes no
    // record — detaching leaves the columns and their values as ordinary local
    // ones — so the whole surface is `auto`.
    for (const action of [
      "preview",
      "create",
      "update",
      "delete",
      "refresh",
      "list",
    ] as const) {
      expect(
        resolveBuiltinToolPolicy({
          toolName: "manageSync",
          action,
          teamPolicies: {},
          autonomy: null,
        }),
      ).toBe("auto");
    }
    // `confirmFullResync` is the one that applies an orphan policy to rows the
    // floor refused to touch — many at once, and no refresh brings back what
    // the app no longer returns.
    expect(
      resolveBuiltinToolPolicy({
        toolName: "manageSync",
        action: "confirmFullResync",
        teamPolicies: {},
        autonomy: null,
      }),
    ).toBe("approval");
  });

  test("every approval-gated action has a grant executor", () => {
    // An `approval` default with no entry in TOOL_CALL_APPLY would strand the
    // write: the card opens, the grant then finds nothing to run.
    for (const descriptor of Object.values(BUILTIN_TOOL_POLICY_CATALOG)) {
      const gates =
        descriptor.defaultLevel === "approval" ||
        Object.values(descriptor.actions ?? {}).some(
          (a) => a.defaultLevel === "approval",
        );
      if (!gates) continue;
      expect(
        descriptor.approvalKind === "record_write" ||
          TOOL_CALL_APPLY[descriptor.name] !== undefined,
      ).toBe(true);
    }
  });

  test("installSkill stays approval", () => {
    expect(
      resolveBuiltinToolPolicy({
        toolName: "installSkill",
        teamPolicies: {},
        autonomy: null,
      }),
    ).toBe("approval");
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

describe("uploadToDrive grant args — batch and pre-batch shapes", () => {
  /**
   * An approval row outlives the deploy that wrote it. `uploadToDrive` used
   * to store one `path` or one `fileId`; it now stores `paths` / `fileIds`.
   * A grant clicked minutes after that deploy still carries the old shape,
   * and reading only the new keys would apply it as an empty set — saving
   * nothing while the card reports success.
   */
  test("reads the batch shape", () => {
    expect(
      strListOrSingle({ paths: ["a.pdf", "b.pdf"] }, "paths", "path"),
    ).toEqual(["a.pdf", "b.pdf"]);
  });

  test("still reads a grant stored before the batch change", () => {
    expect(strListOrSingle({ path: "outputs/a.pdf" }, "paths", "path")).toEqual(
      ["outputs/a.pdf"],
    );
    expect(strListOrSingle({ fileId: "f-1" }, "fileIds", "fileId")).toEqual([
      "f-1",
    ]);
  });

  test("an absent arg is an empty list, not a crash", () => {
    expect(strListOrSingle({}, "paths", "path")).toEqual([]);
  });

  test("drops non-string entries rather than passing them to a service", () => {
    expect(
      strListOrSingle({ paths: ["a.pdf", 42, null] }, "paths", "path"),
    ).toEqual(["a.pdf"]);
  });
});
