import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
import { realDbExports } from "../../lib/real-db";
import { installSandboxMocks, sandboxFs } from "../../lib/sandbox-fixture";

installSandboxMocks();

// The db fake below only implements `query.*.findFirst` and is
// process-global — restore the real module (preload-captured, see
// tests/lib/real-db.ts) for the test files that run after this one.
afterAll(() => {
  void mock.module("@fretik/shared/db", () => realDbExports);
});

// --------------------------------------------------------------- //
// Extracted-figure resolution: `vision` on a virtual path          //
// (`attachments/<file>/img-N.ext`) must resolve DB-first from the  //
// extraction cache on S3 — zero sandbox involvement.               //
// --------------------------------------------------------------- //

interface ChatFileRow {
  fileHash: string | null;
}
interface ExtractionRow {
  imageIds: string[] | null;
}
const chatFileRows = new Map<string, ChatFileRow>();
const extractionRows = new Map<string, ExtractionRow>();
/** Stored image bytes keyed by full S3 key. */
const s3Images = new Map<string, Uint8Array>();
/** Every describeVisionFile invocation, for assertions. */
const visionCalls: { mimeType: string; filename?: string; bytes: number }[] =
  [];

const rowKey = (conversationId: string, filename: string): string =>
  `${conversationId}::${filename}`;

void mock.module("@fretik/shared/db", () => ({
  default: {
    query: new Proxy(
      {},
      {
        get: (_t, table: string) => ({
          findFirst: async (q: {
            where?: {
              conversationId?: string;
              filename?: string;
              organizationId?: string;
              fileHash?: string;
            };
          }) => {
            const where = q.where ?? {};
            if (table === "aiChatFiles") {
              if (!where.conversationId || !where.filename) return undefined;
              return chatFileRows.get(
                rowKey(where.conversationId, where.filename),
              );
            }
            if (table === "fileExtractions") {
              if (!where.organizationId || !where.fileHash) return undefined;
              return extractionRows.get(where.fileHash);
            }
            return undefined;
          },
          findMany: async () => [],
        }),
      },
    ),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

// Mirror the real module's full export surface (mock.module is
// process-global — see read.test.ts); only `readExtractionImage` is
// backed by the in-memory map, the pure helpers keep real behavior.
void mock.module("@fretik/shared/services/file-extraction/storage", () => ({
  MAX_EXTRACTED_IMAGES: 12,
  MAX_EXTRACTED_IMAGE_BYTES: 3 * 1024 * 1024,
  extractedImageContentType: (imageId: string) =>
    imageId.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
  buildExtractionSidecarKey: (org: string, hash: string) =>
    `file-extractions/${org}/${hash}.md`,
  buildExtractionImageKey: (org: string, hash: string, imageId: string) =>
    `file-extractions/${org}/${hash}/${imageId}`,
  writeExtractionSidecar: async () => "unused",
  writeExtractionImages: async () => [],
  readExtractionSidecar: async () => null,
  readExtractionImage: async (key: string) => s3Images.get(key) ?? null,
}));

/** Flip per-test to simulate the model stopping at its output cap. */
let nextTruncated = false;
/** Raw bytes of the last describeVisionFile call, for slice assertions. */
let lastVisionBytes: Uint8Array | null = null;

void mock.module("../../../src/lib/vision", () => ({
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
}));

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
  if (typeof result !== "object" || result === null) {
    throw new Error(`vision returned non-object: ${JSON.stringify(result)}`);
  }
  return result;
};

const seedFigure = (args: {
  conversationId: string;
  filename: string;
  fileHash: string;
  imageIds: string[];
  storedImages?: string[];
}): void => {
  chatFileRows.set(rowKey(args.conversationId, args.filename), {
    fileHash: args.fileHash,
  });
  extractionRows.set(args.fileHash, { imageIds: args.imageIds });
  for (const id of args.storedImages ?? args.imageIds) {
    s3Images.set(
      `file-extractions/org-1/${args.fileHash}/${id}`,
      new Uint8Array([9, 9, 9, 9]),
    );
  }
};

beforeEach(() => {
  sandboxFs.reset();
  chatFileRows.clear();
  extractionRows.clear();
  s3Images.clear();
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

describe("vision tool — extracted figures (cache-resolved, no sandbox)", () => {
  test("resolves a stored figure and describes its bytes", async () => {
    seedFigure({
      conversationId: "conv-v",
      filename: "report.pdf",
      fileHash: "hash-r",
      imageIds: ["img-2.jpeg"],
    });
    const out = await execVision("conv-v", "attachments/report.pdf/img-2.jpeg");
    expect(out["description"]).toBe("described img-2.jpeg");
    expect(out["mimeType"]).toBe("image/jpeg");
    expect(out["model"]).toBe("test/vision-model");
    expect(visionCalls).toHaveLength(1);
    expect(visionCalls[0]?.bytes).toBe(4);
  });

  test("figure id not in the manifest → FILE_NOT_FOUND steering to read", async () => {
    seedFigure({
      conversationId: "conv-v",
      filename: "report.pdf",
      fileHash: "hash-r",
      imageIds: ["img-0.jpeg"],
    });
    const out = await execVision("conv-v", "attachments/report.pdf/img-9.jpeg");
    expect(out["code"]).toBe("FILE_NOT_FOUND");
    expect(String(out["error"])).toContain('read("attachments/report.pdf")');
    expect(visionCalls).toHaveLength(0);
  });

  test("attachment without a hash (legacy) → FILE_NOT_FOUND, no vision call", async () => {
    chatFileRows.set(rowKey("conv-v", "old.pdf"), { fileHash: null });
    const out = await execVision("conv-v", "attachments/old.pdf/img-0.jpeg");
    expect(out["code"]).toBe("FILE_NOT_FOUND");
    expect(visionCalls).toHaveLength(0);
  });

  test("manifest lists the id but S3 misses the object → FILE_NOT_FOUND", async () => {
    seedFigure({
      conversationId: "conv-v",
      filename: "report.pdf",
      fileHash: "hash-r",
      imageIds: ["img-1.png"],
      storedImages: [],
    });
    const out = await execVision("conv-v", "attachments/report.pdf/img-1.png");
    expect(out["code"]).toBe("FILE_NOT_FOUND");
    expect(visionCalls).toHaveLength(0);
  });
});
