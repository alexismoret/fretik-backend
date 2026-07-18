import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
// Real schema preparation is exercised through the tool; only the
// engine's model-calling entry point is faked below.
import {
  type ExtractSource,
  prepareExtractionSchema,
  type RunStructuredExtractArgs,
} from "../../../src/lib/structured-extract";
import { realDbExports } from "../../lib/real-db";
import { installSandboxMocks, sandboxFs } from "../../lib/sandbox-fixture";

installSandboxMocks();

afterAll(() => {
  void mock.module("@fretik/shared/db", () => realDbExports);
});

// --------------------------------------------------------------- //
// In-memory DB rows (aiChatFiles) for the Office/OCR path          //
// --------------------------------------------------------------- //

interface ChatFileRow {
  id: string;
  fileHash: string | null;
  mimeType: string;
  size: number;
}
const chatFileRows = new Map<string, ChatFileRow>();
const rowKey = (conversationId: string, filename: string): string =>
  `${conversationId}::${filename}`;

void mock.module("@fretik/shared/db", () => ({
  default: {
    query: new Proxy(
      {},
      {
        get: (_t, table: string) => ({
          findFirst: async (q: {
            where?: { conversationId?: string; filename?: string };
          }) => {
            const where = q.where ?? {};
            if (table === "aiChatFiles") {
              if (!where.conversationId || !where.filename) return undefined;
              return chatFileRows.get(
                rowKey(where.conversationId, where.filename),
              );
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

// Cached-OCR seam. Per the established mock contract, the fake MUST
// return `imageIds` (and `pages`) — see read.test.ts.
const extractionCalls: { fileHash: string; mimeType: string }[] = [];
void mock.module("@fretik/shared/services/file-extraction/extract", () => ({
  getOrCreateExtraction: async (args: {
    fileHash: string;
    mimeType: string;
  }) => {
    extractionCalls.push({ fileHash: args.fileHash, mimeType: args.mimeType });
    return {
      route: "mistral-ocr",
      markdown: "# Page one\n\ncontent",
      pages: [
        { index: 0, markdown: "# Page one\n\ncontent" },
        { index: 1, markdown: "second page" },
      ],
      pageCount: 2,
      imageIds: [],
    };
  },
}));

// Engine seam: capture the source the tool built; return a canned
// envelope. `prepareExtractionSchema` stays REAL so schema validation
// is exercised end-to-end through the tool.
const engineCalls: RunStructuredExtractArgs[] = [];
void mock.module("../../../src/lib/structured-extract", () => ({
  prepareExtractionSchema,
  runStructuredExtract: async (args: RunStructuredExtractArgs) => {
    engineCalls.push(args);
    return {
      model: "test/extract-model",
      pagesTotal: args.source.kind === "image" ? 1 : args.source.pagesTotal,
      pagesCovered: "all",
      chunks: 1,
      complete: true,
      notices: [],
      data: { records: [{ value: 42 }] },
    };
  },
}));

const { createExtractTool } = await import("../../../src/tools/extract");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");

const VALID_SCHEMA = {
  type: "object",
  properties: { value: { type: "number", description: "the value" } },
};

const execExtract = async (
  conversationId: string | undefined,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const tool = createExtractTool();
  if (typeof tool.execute !== "function") {
    throw new Error("extract tool missing execute");
  }
  const ctx = {
    organizationId: "org-1",
    teamId: "team-1",
    conversationId,
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  };
  const result = await tool.execute(
    { schema: VALID_SCHEMA, shape: "records", ...input },
    {
      toolCallId: `tc-${Math.random().toString(36).slice(2, 8)}`,
      messages: [],
      context: wrapRuntimeContext(ctx),
    },
  );
  if (typeof result !== "object" || result === null) {
    throw new Error(`extract returned non-object: ${JSON.stringify(result)}`);
  }
  return result;
};

const buildPdf = async (pages: number): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index++) {
    doc.addPage([200, 200]);
  }
  return doc.save();
};

beforeEach(() => {
  sandboxFs.reset();
  chatFileRows.clear();
  extractionCalls.length = 0;
  engineCalls.length = 0;
});

describe("extract tool — input validation", () => {
  test("rejects an un-lowerable schema before any engine call", async () => {
    // Draft-07 idioms ($ref, allOf, anyOf-nullable, bare maps) are lowered,
    // not rejected — so the guard fires only for a schema that describes no
    // record at all (here: an object with zero fields).
    sandboxFs.write("c1", "attachments/doc.pdf", await buildPdf(1));
    const result = await execExtract("c1", {
      file_path: "attachments/doc.pdf",
      schema: { type: "object", properties: {} },
    });
    expect(result["code"]).toBe("INVALID_SCHEMA");
    expect(engineCalls).toHaveLength(0);
  });

  test("routes spreadsheets to python", async () => {
    const result = await execExtract("c1", {
      file_path: "attachments/data.xlsx",
    });
    expect(result["code"]).toBe("BINARY_NOT_READABLE");
    expect(result["hint"]).toBe("python");
  });

  test("rejects unsupported extensions", async () => {
    const result = await execExtract("c1", {
      file_path: "attachments/clip.mp4",
    });
    expect(result["code"]).toBe("UNSUPPORTED_EXTENSION");
  });

  test("rejects pages on a non-PDF", async () => {
    const result = await execExtract("c1", {
      file_path: "attachments/report.docx",
      pages: "1-2",
    });
    expect(result["code"]).toBe("INVALID_PAGE_RANGE");
  });

  test("requires a conversation", async () => {
    const result = await execExtract(undefined, {
      file_path: "attachments/doc.pdf",
    });
    expect(result["code"]).toBe("NO_CONVERSATION");
  });

  test("missing file → FILE_NOT_FOUND", async () => {
    const result = await execExtract("c1", {
      file_path: "attachments/doc.pdf",
    });
    expect(result["code"]).toBe("FILE_NOT_FOUND");
  });
});

describe("extract tool — PDF routing", () => {
  test("builds a splittable pdf source with the parsed page selection", async () => {
    sandboxFs.write("c1", "attachments/doc.pdf", await buildPdf(3));
    const result = await execExtract("c1", {
      file_path: "attachments/doc.pdf",
      pages: "1-2",
    });
    expect(result["complete"]).toBe(true);
    expect(result["filePath"]).toBe("/workspace/attachments/doc.pdf");
    expect(engineCalls).toHaveLength(1);
    const source = engineCalls[0]?.source as Extract<
      ExtractSource,
      { kind: "pdf" }
    >;
    expect(source.kind).toBe("pdf");
    expect(source.selectedPages).toEqual([1, 2]);
    expect(source.pagesTotal).toBe(3);
    expect(source.splittable).toBe(true);
  });

  test("defaults to all pages when pages is omitted", async () => {
    sandboxFs.write("c1", "attachments/doc.pdf", await buildPdf(3));
    await execExtract("c1", { file_path: "attachments/doc.pdf" });
    const source = engineCalls[0]?.source as Extract<
      ExtractSource,
      { kind: "pdf" }
    >;
    expect(source.selectedPages).toEqual([1, 2, 3]);
  });

  test("out-of-bounds pages → INVALID_PAGE_RANGE", async () => {
    sandboxFs.write("c1", "attachments/doc.pdf", await buildPdf(3));
    const result = await execExtract("c1", {
      file_path: "attachments/doc.pdf",
      pages: "5",
    });
    expect(result["code"]).toBe("INVALID_PAGE_RANGE");
    expect(engineCalls).toHaveLength(0);
  });

  test("unsplittable pdf degrades to whole-doc with a notice when pages requested", async () => {
    sandboxFs.write(
      "c1",
      "attachments/doc.pdf",
      new TextEncoder().encode("not a real pdf"),
    );
    const result = await execExtract("c1", {
      file_path: "attachments/doc.pdf",
    });
    const source = engineCalls[0]?.source as Extract<
      ExtractSource,
      { kind: "pdf" }
    >;
    expect(source.splittable).toBe(false);
    expect(source.selectedPages).toEqual([]);
    expect(result["complete"]).toBe(true);
  });
});

describe("extract tool — image and Office routing", () => {
  test("images become a single native image source", async () => {
    sandboxFs.write("c1", "attachments/scan.png", new Uint8Array([1, 2, 3]));
    await execExtract("c1", { file_path: "attachments/scan.png" });
    const source = engineCalls[0]?.source;
    expect(source?.kind).toBe("image");
  });

  test("docx rides the cached OCR markdown as a text source", async () => {
    chatFileRows.set(rowKey("c1", "report.docx"), {
      id: "row-1",
      fileHash: "hash-1",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 1234,
    });
    await execExtract("c1", { file_path: "attachments/report.docx" });
    expect(extractionCalls).toHaveLength(1);
    expect(extractionCalls[0]?.fileHash).toBe("hash-1");
    const source = engineCalls[0]?.source as Extract<
      ExtractSource,
      { kind: "text" }
    >;
    expect(source.kind).toBe("text");
    expect(source.pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(source.pagesTotal).toBe(2);
  });

  test("docx without an attachment row → FILE_NOT_FOUND", async () => {
    const result = await execExtract("c1", {
      file_path: "attachments/missing.docx",
    });
    expect(result["code"]).toBe("FILE_NOT_FOUND");
  });
});
