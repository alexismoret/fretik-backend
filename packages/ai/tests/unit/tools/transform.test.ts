import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
// Real chunk planning is exercised through the tool; only the model-calling
// entry point (`runProseTransform`) is faked below.
import { planProseChunks } from "../../../src/lib/prose-transform";
import { realDbExports } from "../../lib/real-db";
import { installSandboxMocks, sandboxFs } from "../../lib/sandbox-fixture";

installSandboxMocks();

afterAll(() => {
  void mock.module("@fretik/shared/db", () => realDbExports);
});

// transform's PDF/Office branch reads aiChatFiles; the text/json paths under
// test never touch it, but the module imports `db` at load — stub it so the
// import is cheap and offline (mirrors extract.test.ts).
void mock.module("@fretik/shared/db", () => ({
  default: {
    query: new Proxy(
      {},
      {
        get: () => ({
          findFirst: async () => undefined,
          findMany: async () => [],
        }),
      },
    ),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

// Engine seam: capture what the tool passed; return a deterministic result
// whose output is the chunks joined, so the written file is assertable.
const engineCalls: { chunks: readonly string[]; instruction: string }[] = [];
void mock.module("../../../src/lib/prose-transform", () => ({
  planProseChunks,
  runProseTransform: async (args: {
    chunks: readonly string[];
    instruction: string;
  }) => {
    engineCalls.push(args);
    return {
      model: "test/transform-model",
      chunks: args.chunks.length,
      complete: true,
      notices: [],
      output: args.chunks.map((chunk) => `[t]${chunk}`).join("\n\n"),
    };
  },
}));

const { createTransformTool } = await import("../../../src/tools/transform");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");

const execTransform = async (
  conversationId: string | undefined,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const tool = createTransformTool();
  if (typeof tool.execute !== "function") {
    throw new Error("transform tool missing execute");
  }
  const ctx = {
    organizationId: "org-1",
    teamId: "team-1",
    conversationId,
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  };
  const result = await tool.execute(
    { instruction: "Translate to French.", ...input },
    {
      toolCallId: `tc-${Math.random().toString(36).slice(2, 8)}`,
      messages: [],
      context: wrapRuntimeContext(ctx),
    },
  );
  if (typeof result !== "object" || result === null) {
    throw new Error(`transform returned non-object: ${JSON.stringify(result)}`);
  }
  return result;
};

beforeEach(() => {
  sandboxFs.reset();
  engineCalls.length = 0;
});

describe("transform tool — guards", () => {
  test("no conversation → NO_CONVERSATION, no engine call", async () => {
    const result = await execTransform(undefined, { file_path: "a.md" });
    expect(result["code"]).toBe("NO_CONVERSATION");
    expect(engineCalls).toHaveLength(0);
  });

  test("path outside the sandbox → PATH_OUT_OF_SANDBOX", async () => {
    const result = await execTransform("c1", { file_path: "/etc/passwd" });
    expect(result["code"]).toBe("PATH_OUT_OF_SANDBOX");
    expect(engineCalls).toHaveLength(0);
  });

  test("output_path outside outputs/ → PATH_OUT_OF_SANDBOX", async () => {
    sandboxFs.write("c1", "attachments/doc.md", "hello world");
    const result = await execTransform("c1", {
      file_path: "attachments/doc.md",
      output_path: "attachments/out.md",
    });
    expect(result["code"]).toBe("PATH_OUT_OF_SANDBOX");
    expect(engineCalls).toHaveLength(0);
  });

  test("spreadsheet → routed to python", async () => {
    const result = await execTransform("c1", {
      file_path: "attachments/x.xlsx",
    });
    expect(result["code"]).toBe("BINARY_NOT_READABLE");
    expect(result["hint"]).toBe("python");
    expect(engineCalls).toHaveLength(0);
  });

  test("image → routed to vision", async () => {
    const result = await execTransform("c1", {
      file_path: "attachments/p.png",
    });
    expect(result["code"]).toBe("NO_TEXT_CONTENT");
    expect(result["hint"]).toBe("vision");
    expect(engineCalls).toHaveLength(0);
  });

  test("unsupported extension → UNSUPPORTED_EXTENSION", async () => {
    sandboxFs.write("c1", "attachments/a.bin", "bytes");
    const result = await execTransform("c1", {
      file_path: "attachments/a.bin",
    });
    expect(result["code"]).toBe("UNSUPPORTED_EXTENSION");
    expect(engineCalls).toHaveLength(0);
  });

  test("empty source → EMPTY_SOURCE", async () => {
    sandboxFs.write("c1", "attachments/blank.md", "   \n  ");
    const result = await execTransform("c1", {
      file_path: "attachments/blank.md",
    });
    expect(result["code"]).toBe("EMPTY_SOURCE");
    expect(engineCalls).toHaveLength(0);
  });

  test("JSON without a text field → routed to python", async () => {
    sandboxFs.write("c1", "outputs/persisted/x.json", '{"rows":[1,2,3]}');
    const result = await execTransform("c1", {
      file_path: "outputs/persisted/x.json",
    });
    expect(result["code"]).toBe("BINARY_NOT_READABLE");
    expect(engineCalls).toHaveLength(0);
  });
});

describe("transform tool — happy paths", () => {
  test("a markdown file is transformed and written to outputs/", async () => {
    sandboxFs.write("c1", "attachments/faq.md", "Hello.\n\nWorld.");
    const result = await execTransform("c1", {
      file_path: "attachments/faq.md",
    });
    expect(result["code"]).toBeUndefined();
    expect(result["outputPath"]).toBe("/workspace/outputs/faq-transformed.md");
    expect(result["complete"]).toBe(true);
    expect(engineCalls).toHaveLength(1);
    expect(engineCalls[0]?.instruction).toBe("Translate to French.");
    // The engine output was persisted to the sandbox.
    const written = sandboxFs.read("c1", "outputs/faq-transformed.md");
    expect(written).not.toBeNull();
    expect(new TextDecoder().decode(written ?? new Uint8Array())).toContain(
      "[t]",
    );
  });

  test("a persisted webFetch JSON uses its `content` field as the source", async () => {
    sandboxFs.write(
      "c1",
      "outputs/persisted/web.json",
      JSON.stringify({ url: "https://x", title: "T", content: "Body text." }),
    );
    const result = await execTransform("c1", {
      file_path: "outputs/persisted/web.json",
    });
    expect(result["code"]).toBeUndefined();
    expect(engineCalls).toHaveLength(1);
    // The engine saw the `content`, not the JSON envelope.
    expect(engineCalls[0]?.chunks.join(" ")).toContain("Body text.");
    expect(engineCalls[0]?.chunks.join(" ")).not.toContain("https://x");
  });

  test("a custom output_path under outputs/ is honoured", async () => {
    sandboxFs.write("c1", "attachments/doc.txt", "content here");
    const result = await execTransform("c1", {
      file_path: "attachments/doc.txt",
      output_path: "outputs/fr/doc.md",
    });
    expect(result["outputPath"]).toBe("/workspace/outputs/fr/doc.md");
    expect(sandboxFs.read("c1", "outputs/fr/doc.md")).not.toBeNull();
  });
});
