import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
// Real schema building is exercised through the tool; only the engine's
// model-calling entry point is faked below.
import {
  buildExtractionSchema,
  type ExtractSource,
  type RunStructuredExtractArgs,
} from "../../../src/lib/structured-extract";
import { mockModule } from "../../lib/mock-module";
import { realDbExports } from "../../lib/real-db";
import { installSandboxMocks, sandboxFs } from "../../lib/sandbox-fixture";

installSandboxMocks();

afterAll(() => {
  void mock.module("@fretik/shared/db", () => realDbExports);
});

// Engine seam: capture the source the tool built; return a canned envelope.
// `buildExtractionSchema` stays REAL so field→schema building is exercised
// end-to-end through the tool.
const engineCalls: RunStructuredExtractArgs[] = [];
await mockModule("../../../src/lib/structured-extract", {
  buildExtractionSchema,
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
});

const { createExtractTool } = await import("../../../src/tools/extract");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");

const VALID_FIELDS = [
  { name: "value", type: "number" as const, description: "the value" },
];

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
    { fields: VALID_FIELDS, shape: "records", ...input },
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
  engineCalls.length = 0;
});

describe("extract tool — input validation", () => {
  test("empty fields → INVALID_ARGS with a worked example, no engine call", async () => {
    sandboxFs.write("c1", "attachments/doc.pdf", await buildPdf(1));
    const result = await execExtract("c1", {
      file_path: "attachments/doc.pdf",
      fields: [],
    });
    expect(result["code"]).toBe("INVALID_ARGS");
    expect(String(result["hint"])).toContain("Example call");
    expect(engineCalls).toHaveLength(0);
  });

  // The `schema` param is gone: it was undocumented, serialised into the wire
  // schema as an object accepting no properties, and models planning "let me
  // build the schema" sent `{}` — 25/25 calls in prod failed INVALID_SCHEMA
  // before falling back to hand-parsing. `fields` is the only surface now.
  test("a legacy `schema`-only call no longer reaches the engine", async () => {
    sandboxFs.write("c1", "attachments/doc.pdf", await buildPdf(1));
    const result = await execExtract("c1", {
      file_path: "attachments/doc.pdf",
      fields: [],
      schema: {
        type: "object",
        properties: { amount: { type: "number", description: "total" } },
      },
    });
    expect(result["code"]).toBe("INVALID_ARGS");
    expect(engineCalls).toHaveLength(0);
  });

  test("routes spreadsheets to python", async () => {
    const result = await execExtract("c1", {
      file_path: "attachments/data.xlsx",
    });
    expect(result["code"]).toBe("BINARY_NOT_READABLE");
    expect(result["hint"]).toBe("python");
  });

  test("routes Office documents to read (native-only extract)", async () => {
    const result = await execExtract("c1", {
      file_path: "attachments/report.docx",
    });
    expect(result["code"]).toBe("UNSUPPORTED_EXTENSION");
    expect(result["hint"]).toBe("read");
    expect(engineCalls).toHaveLength(0);
  });

  test("rejects unsupported extensions", async () => {
    const result = await execExtract("c1", {
      file_path: "attachments/clip.mp4",
    });
    expect(result["code"]).toBe("UNSUPPORTED_EXTENSION");
  });

  test("rejects pages on a non-PDF (image)", async () => {
    sandboxFs.write("c1", "attachments/scan.png", new Uint8Array([1, 2, 3]));
    const result = await execExtract("c1", {
      file_path: "attachments/scan.png",
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

  // Models fill every field of the schema, so an OPTIONAL string arrives as
  // "" — 13 of 38 prod calls, on the first attempt of every run, all rejected
  // before reaching the engine. Blank means what omitting it means.
  test.each(["", "  ", "all", "ALL"])(
    "pages %p is treated as the whole document",
    async (pages) => {
      sandboxFs.write("c1", "attachments/doc.pdf", await buildPdf(3));
      const result = await execExtract("c1", {
        file_path: "attachments/doc.pdf",
        pages,
      });
      expect(result["code"]).toBeUndefined();
      const source = engineCalls[0]?.source as Extract<
        ExtractSource,
        { kind: "pdf" }
      >;
      expect(source.selectedPages).toEqual([1, 2, 3]);
    },
  );

  test("a blank pages on an image is not a page-range error", async () => {
    sandboxFs.write("c1", "attachments/scan.png", new Uint8Array([1, 2, 3]));
    const result = await execExtract("c1", {
      file_path: "attachments/scan.png",
      pages: "",
    });
    expect(result["code"]).toBeUndefined();
    expect(engineCalls[0]?.source.kind).toBe("image");
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

  test("unsplittable pdf degrades to whole-doc", async () => {
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

  test("images become a single native image source", async () => {
    sandboxFs.write("c1", "attachments/scan.png", new Uint8Array([1, 2, 3]));
    await execExtract("c1", { file_path: "attachments/scan.png" });
    const source = engineCalls[0]?.source;
    expect(source?.kind).toBe("image");
  });
});
