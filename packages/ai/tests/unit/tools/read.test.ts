import { beforeEach, describe, expect, test } from "bun:test";
import { installSandboxMocks, sandboxFs } from "../../lib/sandbox-fixture";

installSandboxMocks();

const { createReadTool } = await import("../../../src/tools/read");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { TaskManager } = await import("../../../src/agents/shared/task-manager");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");

type ExecuteOptions = {
  toolCallId: string;
  messages: never[];
  experimental_context: unknown;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const readString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === "string" ? value : "";
};

const buildExecuteOptions = (conversationId: string): ExecuteOptions => {
  const ctx = {
    organizationId: "org-1",
    teamId: "team-1",
    conversationId,
    dynamicToolManager: new DynamicToolManager(),
    taskManager: new TaskManager(),
  };
  return {
    toolCallId: `tc-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`,
    messages: [],
    experimental_context: wrapRuntimeContext(ctx),
  };
};

const execRead = async (
  conversationId: string,
  file_path: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<unknown> => {
  const tool = createReadTool();
  if (typeof tool.execute !== "function") {
    throw new Error("read tool missing execute");
  }
  return await tool.execute(
    { file_path, ...opts },
    buildExecuteOptions(conversationId),
  );
};

const expectRecord = (result: unknown): Record<string, unknown> => {
  if (!isRecord(result)) {
    throw new Error(`read returned non-object: ${JSON.stringify(result)}`);
  }
  return result;
};

beforeEach(() => {
  sandboxFs.reset();
});

describe("read tool — path sandbox", () => {
  test("rejects an absolute path outside /workspace/", async () => {
    const out = expectRecord(await execRead("conv-a", "/etc/passwd"));
    expect(out["code"]).toBe("PATH_OUT_OF_SANDBOX");
    expect(readString(out, "error")).toContain("sandbox");
  });

  test("rejects traversal via ../", async () => {
    const out = expectRecord(
      await execRead("conv-a", "../other-conv/secret.md"),
    );
    expect(out["code"]).toBe("PATH_OUT_OF_SANDBOX");
  });

  test("accepts absolute /workspace/ path", async () => {
    sandboxFs.write("conv-a", "attachments/note.md", "hello");
    const out = expectRecord(
      await execRead("conv-a", "/workspace/attachments/note.md"),
    );
    expect(out["source"]).toBe("original");
  });
});

describe("read tool — extension routing", () => {
  test("bare basename is auto-resolved under attachments/", async () => {
    sandboxFs.write(
      "conv-c",
      "attachments/shipping-notes.md",
      "first\nsecond\nthird",
    );
    const out = expectRecord(await execRead("conv-c", "shipping-notes.md"));
    expect(out["source"]).toBe("original");
    expect(out["startLine"]).toBe(1);
    expect(out["numLines"]).toBe(3);
    expect(out["totalLines"]).toBe(3);
    const content = readString(out, "content");
    expect(content).toContain("     1\tfirst");
    expect(content).toContain("     2\tsecond");
    expect(content).toContain("     3\tthird");
  });

  test("explicit subdir paths read directly (outputs/)", async () => {
    sandboxFs.write("conv-c2", "outputs/report.md", "alpha\nbravo");
    const out = expectRecord(await execRead("conv-c2", "outputs/report.md"));
    expect(out["source"]).toBe("original");
    expect(out["totalLines"]).toBe(2);
  });

  test("offset + limit slice returns real file line numbers", async () => {
    sandboxFs.write(
      "conv-slice",
      "attachments/long.md",
      "alpha\nbravo\ncharlie\ndelta\necho",
    );
    const out = expectRecord(
      await execRead("conv-slice", "attachments/long.md", {
        offset: 3,
        limit: 2,
      }),
    );
    expect(out["startLine"]).toBe(3);
    expect(out["numLines"]).toBe(2);
    expect(out["totalLines"]).toBe(5);
    const content = readString(out, "content");
    expect(content).toContain("     3\tcharlie");
    expect(content).toContain("     4\tdelta");
    expect(content).not.toContain("echo");
  });

  test("offset past EOF returns numLines=0 without erroring", async () => {
    sandboxFs.write("conv-eof", "attachments/short.md", "only");
    const out = expectRecord(
      await execRead("conv-eof", "attachments/short.md", { offset: 99 }),
    );
    expect(out["numLines"]).toBe(0);
    expect(out["totalLines"]).toBe(1);
    expect(out["content"]).toBe("");
  });

  test("persisted-output txt under outputs/persisted/ reports source=persisted-output", async () => {
    sandboxFs.write(
      "conv-p",
      "outputs/persisted/tc-abc123.txt",
      "one\ntwo\nthree",
    );
    const out = expectRecord(
      await execRead("conv-p", "outputs/persisted/tc-abc123.txt"),
    );
    expect(out["source"]).toBe("persisted-output");
  });

  test("PDF auto-resolves to {basename}.md OCR sidecar in the same dir", async () => {
    sandboxFs.write(
      "conv-d",
      "attachments/invoice.md",
      "Invoice #42 — Total: 100 EUR",
    );
    const out = expectRecord(
      await execRead("conv-d", "attachments/invoice.pdf"),
    );
    expect(out["source"]).toBe("ocr-sidecar");
    expect(readString(out, "content")).toContain("Invoice #42");
  });

  test("PDF without sidecar returns NO_OCR_SIDECAR with actionable hint", async () => {
    const out = expectRecord(
      await execRead("conv-d-missing", "attachments/invoice.pdf"),
    );
    expect(out["code"]).toBe("NO_OCR_SIDECAR");
    expect(readString(out, "error")).toContain("pdfplumber");
    expect(readString(out, "error")).toContain("vision");
  });

  test("DOCX without sidecar returns NO_OCR_SIDECAR with python hint", async () => {
    const out = expectRecord(
      await execRead("conv-docx-missing", "attachments/contract.docx"),
    );
    expect(out["code"]).toBe("NO_OCR_SIDECAR");
    expect(out["hint"]).toBe("python");
  });

  test("image without sidecar returns vision hint", async () => {
    const out = expectRecord(await execRead("conv-e", "attachments/cat.jpg"));
    expect(out["code"]).toBe("NO_OCR_SIDECAR");
    expect(out["hint"]).toBe("vision");
  });

  test("image with sidecar returns the markdown", async () => {
    sandboxFs.write(
      "conv-f",
      "attachments/receipt.md",
      "Receipt\nTotal: 12.50 EUR",
    );
    const out = expectRecord(
      await execRead("conv-f", "attachments/receipt.jpg"),
    );
    expect(out["source"]).toBe("ocr-sidecar");
    expect(readString(out, "content")).toContain("Receipt");
  });

  test("XLSX without sidecar returns python hint", async () => {
    const out = expectRecord(await execRead("conv-g", "attachments/data.xlsx"));
    expect(out["code"]).toBe("BINARY_NOT_READABLE");
    expect(out["hint"]).toBe("python");
  });

  test("context/<file>.pdf resolves the sidecar inside context/, not attachments/", async () => {
    sandboxFs.write(
      "conv-ctx",
      "context/handbook.md",
      "Internal handbook contents",
    );
    const out = expectRecord(
      await execRead("conv-ctx", "context/handbook.pdf"),
    );
    expect(out["source"]).toBe("ocr-sidecar");
    expect(readString(out, "content")).toContain("Internal handbook");
  });

  test("missing file returns FILE_NOT_FOUND", async () => {
    const out = expectRecord(await execRead("conv-x", "attachments/ghost.md"));
    expect(out["code"]).toBe("FILE_NOT_FOUND");
  });
});

describe("read tool — persisted-output handoff", () => {
  test("oversized content is wrapped in a <persisted-output> envelope", async () => {
    // READ_PERSIST_THRESHOLD_CHARS = 120K. The read tool's
    // MAX_READ_CHARS = 30K byte cap trims the joined slice before
    // line numbering, so the persist threshold can only be crossed
    // when `addLineNumbers()` (7-char `cat -n` prefix per line)
    // inflates the slice past 120K. We achieve that by feeding many
    // short lines: 30 000 × 1-char lines produces a ~60K raw join,
    // the byte cap trims to ~15 000 lines (~30K joined), then line
    // numbering adds ~7 chars per line → ~135K serialised content
    // → persisted envelope.
    const huge = Array.from({ length: 30_000 }, () => "x").join("\n");
    sandboxFs.write("conv-h", "attachments/big.md", huge);
    const out = await execRead("conv-h", "attachments/big.md", {
      limit: 30_000,
    });
    // maybePersistLargeOutput returns a string envelope when the
    // serialised payload exceeds the read tool's threshold.
    expect(typeof out).toBe("string");
    const envelope = out as string;
    expect(envelope).toContain("<persisted-output>");
    expect(envelope).toContain("Output too large");
    // The envelope must reference the new outputs/persisted/ path,
    // not any legacy /tmp prefix.
    expect(envelope).toContain("outputs/persisted/");
    expect(envelope).not.toContain("/tmp/");
  });
});
