import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { McpTarget } from "../../src/services/external-apps/mcp/target";

/**
 * Contract of the direct MCP client wrapper (`client.ts`) with `@ai-sdk/mcp`
 * mocked: cursor pagination, the 50-page cap, close-on-success and
 * close-on-error, error mapping (JSON-RPC errors surface as thrown Errors), and
 * malformed-tool filtering.
 */

interface Scenario {
  pages: Array<{ tools: unknown[]; nextCursor?: string }>;
  infinite: boolean;
  listError?: Error;
  callResult?: unknown;
  callError?: Error;
  closeCalls: number;
  createError?: Error;
}

let scenario: Scenario;

void mock.module("@ai-sdk/mcp", () => ({
  createMCPClient: async () => {
    if (scenario.createError) throw scenario.createError;
    let page = 0;
    return {
      listTools: async () => {
        if (scenario.listError) throw scenario.listError;
        if (scenario.infinite) {
          return {
            tools: [{ name: `t${(page++).toString()}` }],
            nextCursor: "more",
          };
        }
        const p = scenario.pages[page] ?? { tools: [] };
        page++;
        return p;
      },
      callTool: async () => {
        if (scenario.callError) throw scenario.callError;
        return scenario.callResult;
      },
      close: async () => {
        scenario.closeCalls++;
      },
    };
  },
}));

const { listToolsOnTarget, callToolOnTarget } =
  await import("../../src/services/external-apps/mcp/client");

const TARGET: McpTarget = { url: "https://mcp.example.com/mcp", headers: {} };

/** Await a promise and return the thrown error (or undefined on success). */
const caught = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
    return undefined;
  } catch (error) {
    return error;
  }
};

beforeEach(() => {
  scenario = { pages: [], infinite: false, closeCalls: 0 };
});

describe("listToolsOnTarget", () => {
  test("follows nextCursor across pages and closes on success", async () => {
    scenario.pages = [
      { tools: [{ name: "a" }], nextCursor: "c1" },
      { tools: [{ name: "b" }], nextCursor: "c2" },
      { tools: [{ name: "c" }] },
    ];
    const tools = await listToolsOnTarget(TARGET);
    expect(tools.map((t) => t.name)).toEqual(["a", "b", "c"]);
    expect(scenario.closeCalls).toBe(1);
  });

  test("caps at 50 pages for an infinitely-paginating server", async () => {
    scenario.infinite = true;
    const tools = await listToolsOnTarget(TARGET);
    expect(tools.length).toBe(50);
    expect(scenario.closeCalls).toBe(1);
  });

  test("filters malformed tool entries (no/empty name)", async () => {
    scenario.pages = [
      { tools: [{ name: "ok" }, { noName: true }, { name: "" }, 42] },
    ];
    const tools = await listToolsOnTarget(TARGET);
    expect(tools.map((t) => t.name)).toEqual(["ok"]);
  });

  test("maps annotations (readOnlyHint) and drops unknown keys", async () => {
    scenario.pages = [
      {
        tools: [
          {
            name: "search",
            annotations: { readOnlyHint: true, weird: "x" },
          },
        ],
      },
    ];
    const [tool] = await listToolsOnTarget(TARGET);
    expect(tool?.annotations).toEqual({ readOnlyHint: true });
  });

  test("closes and maps the error when listTools throws", async () => {
    scenario.listError = new Error("boom");
    const err = await caught(listToolsOnTarget(TARGET));
    expect(String(err)).toMatch(
      /MCP tools\/list failed for "mcp\.example\.com": boom/,
    );
    expect(scenario.closeCalls).toBe(1);
  });

  test("maps a create/connect failure", async () => {
    scenario.createError = new Error("401 Unauthorized");
    const err = await caught(listToolsOnTarget(TARGET));
    expect(String(err)).toMatch(
      /MCP tools\/list failed for "mcp\.example\.com": 401 Unauthorized/,
    );
  });
});

describe("callToolOnTarget", () => {
  test("returns the mapped result and closes", async () => {
    scenario.callResult = {
      content: [{ type: "text", text: "hi" }],
      isError: false,
    };
    const res = await callToolOnTarget(TARGET, "search", { q: "x" });
    expect(res).toEqual({
      content: [{ type: "text", text: "hi" }],
      isError: false,
    });
    expect(scenario.closeCalls).toBe(1);
  });

  test("surfaces a JSON-RPC error as a thrown Error and closes", async () => {
    scenario.callError = new Error("MCP error -32602: invalid params");
    const err = await caught(callToolOnTarget(TARGET, "search", {}));
    expect(String(err)).toMatch(/invalid params/);
    expect(scenario.closeCalls).toBe(1);
  });
});
