import { beforeEach, describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
import { mockModule } from "../../lib/mock-module";
import { installSandboxMocks, sandboxFs } from "../../lib/sandbox-fixture";
import { asToolRecord } from "../../lib/tool-result";

installSandboxMocks();

/**
 * `vision` over a file that is IN THE SANDBOX: the truncation signal and page
 * targeting.
 *
 * No database double, because none of this reaches one — the bytes come from
 * the sandbox filesystem and the description from the model seam. The other
 * half of the tool resolves a virtual figure path out of the extraction cache,
 * which is two scoped queries, and lives in
 * `tests/integration/tools/vision-extracted-image.test.ts` since 2026-09-02.
 */

/** Flip per-test to simulate the model stopping at its output cap. */
let nextTruncated = false;
/** Raw bytes of the last describeVisionFile call, for slice assertions. */
let lastVisionBytes: Uint8Array | null = null;
/** Every describeVisionFile invocation, for assertions. */
const visionCalls: { mimeType: string; filename?: string; bytes: number }[] =
  [];

await mockModule("../../../src/lib/vision", {
  describeVisionFile: async (args: {
    bytes: Uint8Array;
    mimeType: string;
    question: string;
    filename?: string;
  }) => {
    visionCalls.push({
      mimeType: args.mimeType,
      filename: args.filename,
      bytes: args.bytes.byteLength,
    });
    lastVisionBytes = args.bytes;
    return {
      question: args.question,
      model: "test/vision-model",
      description: `described ${args.filename ?? "?"}`,
      truncated: nextTruncated,
    };
  },
});

const { createVisionTool } = await import("../../../src/tools/vision");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");

const execVision = async (
  conversationId: string,
  file_path: string,
  question = "what does it show?",
  pages?: string,
): Promise<Record<string, unknown>> => {
  const tool = createVisionTool();
  if (typeof tool.execute !== "function") {
    throw new Error("vision tool missing execute");
  }
  const ctx = {
    organizationId: "org-1",
    teamId: "team-1",
    conversationId,
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  };
  const result = await tool.execute(
    { file_path, question, pages },
    {
      toolCallId: `tc-${Math.random().toString(36).slice(2, 8)}`,
      messages: [],
      context: wrapRuntimeContext(ctx),
    },
  );
  return asToolRecord("vision", result);
};

beforeEach(() => {
  sandboxFs.reset();
  visionCalls.length = 0;
  nextTruncated = false;
  lastVisionBytes = null;
});

const buildPdf = async (pageCount: number): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pageCount; index++) {
    doc.addPage([200, 200]);
  }
  return doc.save();
};

describe("vision tool — truncation signal + page targeting", () => {
  test("a capped description surfaces truncated:true and a notice", async () => {
    sandboxFs.write("conv-v", "attachments/photo.png", new Uint8Array([1, 2]));
    nextTruncated = true;
    const out = await execVision("conv-v", "attachments/photo.png");
    expect(out["truncated"]).toBe(true);
    expect(String(out["notice"])).toContain("output cap");
  });

  test("a complete description carries truncated:false and no notice", async () => {
    sandboxFs.write("conv-v", "attachments/photo.png", new Uint8Array([1, 2]));
    const out = await execVision("conv-v", "attachments/photo.png");
    expect(out["truncated"]).toBe(false);
    expect(out["notice"]).toBeUndefined();
  });

  test("pages slices the PDF before the vision call", async () => {
    sandboxFs.write("conv-v", "attachments/doc.pdf", await buildPdf(3));
    const out = await execVision(
      "conv-v",
      "attachments/doc.pdf",
      "layout?",
      "1-2",
    );
    expect(out["description"]).toContain("described");
    expect(lastVisionBytes).not.toBeNull();
    const sliced = await PDFDocument.load(lastVisionBytes as Uint8Array);
    expect(sliced.getPageCount()).toBe(2);
  });

  test("out-of-bounds pages → INVALID_PAGE_RANGE, no vision call", async () => {
    sandboxFs.write("conv-v", "attachments/doc.pdf", await buildPdf(3));
    const out = await execVision(
      "conv-v",
      "attachments/doc.pdf",
      "layout?",
      "7",
    );
    expect(out["code"]).toBe("INVALID_PAGE_RANGE");
    expect(visionCalls).toHaveLength(0);
  });

  test("pages on a non-PDF → INVALID_PAGE_RANGE", async () => {
    sandboxFs.write("conv-v", "attachments/photo.png", new Uint8Array([1, 2]));
    const out = await execVision(
      "conv-v",
      "attachments/photo.png",
      "colours?",
      "1",
    );
    expect(out["code"]).toBe("INVALID_PAGE_RANGE");
    expect(visionCalls).toHaveLength(0);
  });
});
