import { describe, expect, test } from "bun:test";
import { mcpToolsToDescriptor } from "../../src/services/external-apps/mcp/to-descriptor";
import type { McpTool } from "../../src/services/external-apps/mcp/types";

/**
 * How an MCP server's `tools/list` becomes an action surface.
 *
 * Two decisions live here and both were wrong in production against a Directus
 * MCP server that annotates nothing:
 *
 *  1. Every tool came out `write` — including `schema` and `items(action:
 *     "read")` — which is correct and must stay correct: a tool whose own
 *     argument selects between reading and deleting cannot be classified read.
 *  2. Every read was ALSO gated behind an approval card, because the default
 *     keyed off a curated-vendor list that no longer exists. It now keys off
 *     the server's own `readOnlyHint`, which is the only honest signal.
 *
 * Pure function, no `where` clause — unit.
 */

const tool = (over: Partial<McpTool> & { name: string }): McpTool => ({
  inputSchema: { type: "object", properties: {} },
  ...over,
});

const descriptorFor = (tools: McpTool[]) =>
  mcpToolsToDescriptor({
    key: "acme-mcp",
    displayName: "Acme",
    categories: ["productivity"],
    tools,
  });

describe("read/write classification", () => {
  test("`readOnlyHint: true` is the ONLY thing that makes a read", () => {
    const [action] = descriptorFor([
      tool({ name: "list-items", annotations: { readOnlyHint: true } }),
    ]).actions;
    expect(action?.kind).toBe("read");
    expect(action?.kindSource).toBe("annotation");
  });

  test("an un-annotated tool is a write, however read-ish its name", () => {
    // `schema`, `search`, `get_*` — all of them. Guessing from the name is what
    // the classifier refuses to do, and this is the case that hit production.
    const actions = descriptorFor([
      tool({ name: "schema" }),
      tool({ name: "search_orders" }),
      tool({ name: "get_customer" }),
    ]).actions;
    expect(actions.map((a) => a.kind)).toEqual(["write", "write", "write"]);
    expect(actions.map((a) => a.kindSource)).toEqual([
      "default",
      "default",
      "default",
    ]);
  });

  test("`destructiveHint` wins over a missing readOnlyHint", () => {
    const [action] = descriptorFor([
      tool({ name: "purge", annotations: { destructiveHint: true } }),
    ]).actions;
    expect(action?.kind).toBe("write");
    expect(action?.kindSource).toBe("annotation");
  });
});

describe("approval default", () => {
  test("a declared read auto-runs — no card for something the server called read-only", () => {
    const [action] = descriptorFor([
      tool({ name: "list-items", annotations: { readOnlyHint: true } }),
    ]).actions;
    expect(action?.approvalDefault).toBe("auto");
  });

  test("everything we cannot know about gates", () => {
    const actions = descriptorFor([
      tool({ name: "schema" }),
      tool({ name: "delete-item", annotations: { readOnlyHint: false } }),
    ]).actions;
    expect(actions.map((a) => a.approvalDefault)).toEqual([
      "approval",
      "approval",
    ]);
  });

  test("the default no longer depends on anything outside the tool itself", () => {
    // Same tool, same descriptor input: there is no vendor/trust axis left that
    // could make two teams' identical servers behave differently.
    const one = descriptorFor([
      tool({ name: "list-items", annotations: { readOnlyHint: true } }),
    ]);
    const two = mcpToolsToDescriptor({
      key: "other-mcp",
      displayName: "Other",
      categories: [],
      tools: [
        tool({ name: "list-items", annotations: { readOnlyHint: true } }),
      ],
    });
    expect(one.actions[0]?.approvalDefault).toBe(
      two.actions[0]?.approvalDefault,
    );
  });
});

describe("fingerprint", () => {
  test("covers OUR compiler version, not just the server's tools", () => {
    // Snapshots are get-or-insert by fingerprint (`upsertToolSnapshot`), so a
    // fingerprint that hashes only the server's tools means a change to
    // classification, approval defaults, codegen or SKILL prose produces an
    // identical key — the nightly refresh sees "no drift" and every connection
    // already in production keeps its stale compiled surface forever.
    //
    // This pin is the tripwire: bumping `COMPILER_VERSION` MUST change it. If
    // you are here because this failed, update the value — that is the test
    // doing its job. If you changed a compilation rule and did NOT land here,
    // you forgot to bump the version.
    const fingerprint = descriptorFor([
      tool({ name: "list-items", annotations: { readOnlyHint: true } }),
      tool({ name: "schema" }),
    ]).fingerprint;
    expect(fingerprint).toBe("2ec63e78fa31");
  });

  test("is stable under tool order — it keys a snapshot, not a response", () => {
    const a = descriptorFor([tool({ name: "b" }), tool({ name: "a" })]);
    const b = descriptorFor([tool({ name: "a" }), tool({ name: "b" })]);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test("still moves when the server's tools move", () => {
    const before = descriptorFor([tool({ name: "schema" })]);
    const after = descriptorFor([
      tool({ name: "schema", annotations: { readOnlyHint: true } }),
    ]);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});
