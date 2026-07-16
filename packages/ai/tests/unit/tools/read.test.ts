import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
import { installSandboxMocks, sandboxFs } from "../../lib/sandbox-fixture";

installSandboxMocks();

// --------------------------------------------------------------- //
// New-architecture mocks: chat-file rows + content-addressed       //
// extraction. The read tool now resolves attachments by the stored //
// MIME (from `ai_chat_files`) and, for documents/images, defers to //
// `getOrCreateExtraction` instead of a sandbox `.md` sidecar.      //
// --------------------------------------------------------------- //

interface ChatFileRow {
  id: string;
  fileHash: string | null;
  mimeType: string;
}
const chatFileRows = new Map<string, ChatFileRow>();
/** Extraction markdown keyed by fileHash (null markdown = image-skip). */
const extractions = new Map<string, string | null>();
/** Stored embedded-image ids keyed by fileHash ([] = legacy/no images). */
const extractionImageIds = new Map<string, string[]>();

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
            if (table !== "aiChatFiles") return undefined;
            const where = q.where ?? {};
            if (!where.conversationId || !where.filename) return undefined;
            return chatFileRows.get(
              rowKey(where.conversationId, where.filename),
            );
          },
          findMany: async () => [],
        }),
      },
    ),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

void mock.module("@fretik/shared/services/file-extraction/extract", () => ({
  getOrCreateExtraction: async (input: { fileHash: string }) => {
    const markdown = extractions.get(input.fileHash) ?? null;
    return {
      route: "mistral-ocr",
      markdown,
      pages: [],
      pageCount: null,
      charCount: markdown?.length ?? null,
      sidecarS3Key: null,
      imageIds: extractionImageIds.get(input.fileHash) ?? [],
    };
  },
}));

// Context files are served Bun-side (no sandbox): the read tool loads
// the accessible set, then reads extracted markdown from the `content`
// column or the S3 sidecar — never a sandbox `.md`.
interface ContextFileRow {
  id: string;
  profileId: string;
  filename: string;
  mimeType: string;
  status: string;
  content: string | null;
}
const contextFiles: ContextFileRow[] = [];
const contextOriginals = new Map<string, Uint8Array>();
const contextSidecars = new Map<string, Uint8Array>();

void mock.module("../../../src/services/chatbot-context/load-context", () => ({
  loadAccessibleContext: async () => ({
    userProfile: null,
    teamProfile: null,
    files: contextFiles.map((f) => ({ ...f, scope: "team" as const })),
  }),
}));

void mock.module("@fretik/shared/lib/ai-context-storage", () => ({
  readContextOriginal: async (_profileId: string, fileId: string) =>
    contextOriginals.get(fileId) ?? null,
  readContextSidecar: async (_profileId: string, fileId: string) =>
    contextSidecars.get(fileId) ?? null,
  // mock.module is process-global: other test files in the same run
  // import modules that pull the remaining exports — an incomplete
  // mock breaks THEIR import with "Export named ... not found", so
  // mirror the module's full export surface (no-ops are fine).
  buildContextOriginalKey: (profileId: string, fileId: string) =>
    `mock/${profileId}/${fileId}`,
  buildContextSidecarKey: (profileId: string, fileId: string) =>
    `mock/${profileId}/${fileId}.md`,
  uploadContextSidecar: async () => undefined,
  deleteContextOriginal: async () => undefined,
  deleteContextSidecar: async () => undefined,
}));

const { createReadTool } = await import("../../../src/tools/read");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { TaskManager } = await import("../../../src/agents/shared/task-manager");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");

type ExecuteOptions = {
  toolCallId: string;
  messages: never[];
  context: unknown;
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
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
    taskManager: new TaskManager(),
  };
  return {
    toolCallId: `tc-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`,
    messages: [],
    context: wrapRuntimeContext(ctx),
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

/**
 * Seed a chat attachment: register its `ai_chat_files` row and back it
 * with content — S3 bytes for text MIMEs, an extraction markdown entry
 * for documents/images. `extractionMarkdown: null` simulates an image
 * with no usable text (image-skip).
 */
const seedAttachment = (args: {
  conversationId: string;
  filename: string;
  mimeType: string;
  fileHash?: string;
  textContent?: string;
  extractionMarkdown?: string | null;
  /** Stored embedded-image ids (omit = legacy/no images). */
  imageIds?: string[];
}): void => {
  const fileHash = args.fileHash ?? `hash-${args.filename}`;
  chatFileRows.set(rowKey(args.conversationId, args.filename), {
    id: `id-${args.filename}`,
    fileHash,
    mimeType: args.mimeType,
  });
  if (args.textContent !== undefined) {
    sandboxFs.seedS3(
      args.conversationId,
      `attachments/${args.filename}`,
      args.textContent,
    );
  }
  if (args.extractionMarkdown !== undefined) {
    extractions.set(fileHash, args.extractionMarkdown);
  }
  if (args.imageIds !== undefined) {
    extractionImageIds.set(fileHash, args.imageIds);
  }
};

beforeEach(() => {
  sandboxFs.reset();
  chatFileRows.clear();
  extractions.clear();
  extractionImageIds.clear();
  contextFiles.length = 0;
  contextOriginals.clear();
  contextSidecars.clear();
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

  test("accepts absolute /workspace/ attachment path", async () => {
    seedAttachment({
      conversationId: "conv-a",
      filename: "note.md",
      mimeType: "text/markdown",
      textContent: "hello",
    });
    const out = expectRecord(
      await execRead("conv-a", "/workspace/attachments/note.md"),
    );
    expect(out["source"]).toBe("original");
    expect(readString(out, "content")).toContain("hello");
  });
});

describe("read tool — attachments (transparent)", () => {
  test("bare basename is auto-resolved under attachments/", async () => {
    seedAttachment({
      conversationId: "conv-c",
      filename: "shipping-notes.md",
      mimeType: "text/markdown",
      textContent: "first\nsecond\nthird",
    });
    const out = expectRecord(await execRead("conv-c", "shipping-notes.md"));
    expect(out["source"]).toBe("original");
    expect(out["numLines"]).toBe(3);
    expect(out["totalLines"]).toBe(3);
    const content = readString(out, "content");
    expect(content).toContain("     1\tfirst");
    expect(content).toContain("     3\tthird");
  });

  test("offset + limit slice returns real file line numbers", async () => {
    seedAttachment({
      conversationId: "conv-slice",
      filename: "long.md",
      mimeType: "text/markdown",
      textContent: "alpha\nbravo\ncharlie\ndelta\necho",
    });
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
    seedAttachment({
      conversationId: "conv-eof",
      filename: "short.md",
      mimeType: "text/markdown",
      textContent: "only",
    });
    const out = expectRecord(
      await execRead("conv-eof", "attachments/short.md", { offset: 99 }),
    );
    expect(out["numLines"]).toBe(0);
    expect(out["totalLines"]).toBe(1);
    expect(out["content"]).toBe("");
  });

  test("PDF is read transparently as the extracted text", async () => {
    seedAttachment({
      conversationId: "conv-d",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      extractionMarkdown: "Invoice #42 — Total: 100 EUR",
    });
    const out = expectRecord(
      await execRead("conv-d", "attachments/invoice.pdf"),
    );
    expect(out["source"]).toBe("original");
    expect(readString(out, "content")).toContain("Invoice #42");
  });

  test("DOCX is read transparently as the extracted text", async () => {
    seedAttachment({
      conversationId: "conv-docx",
      filename: "contract.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extractionMarkdown: "## Agreement\n\nParty A and Party B",
    });
    const out = expectRecord(
      await execRead("conv-docx", "attachments/contract.docx"),
    );
    expect(out["source"]).toBe("original");
    expect(readString(out, "content")).toContain("Agreement");
  });

  test("image with usable text returns the extracted text", async () => {
    seedAttachment({
      conversationId: "conv-f",
      filename: "receipt.jpg",
      mimeType: "image/jpeg",
      extractionMarkdown: "Receipt\nTotal: 12.50 EUR",
    });
    const out = expectRecord(
      await execRead("conv-f", "attachments/receipt.jpg"),
    );
    expect(out["source"]).toBe("original");
    expect(readString(out, "content")).toContain("Receipt");
  });

  test("image with no extractable text returns a vision hint", async () => {
    seedAttachment({
      conversationId: "conv-e",
      filename: "cat.jpg",
      mimeType: "image/jpeg",
      extractionMarkdown: null,
    });
    const out = expectRecord(await execRead("conv-e", "attachments/cat.jpg"));
    expect(out["code"]).toBe("NO_TEXT_CONTENT");
    expect(out["hint"]).toBe("vision");
  });

  test("XLSX routes to python (no text dump)", async () => {
    seedAttachment({
      conversationId: "conv-g",
      filename: "data.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const out = expectRecord(await execRead("conv-g", "attachments/data.xlsx"));
    expect(out["code"]).toBe("BINARY_NOT_READABLE");
    expect(out["hint"]).toBe("python");
  });

  test("missing attachment row returns FILE_NOT_FOUND", async () => {
    const out = expectRecord(await execRead("conv-x", "attachments/ghost.md"));
    expect(out["code"]).toBe("FILE_NOT_FOUND");
  });
});

describe("read tool — extracted figures", () => {
  test("figure refs are rewritten to virtual paths when images are stored", async () => {
    seedAttachment({
      conversationId: "conv-fig",
      filename: "report.pdf",
      mimeType: "application/pdf",
      extractionMarkdown: "Intro\n\n![chart](img-0.jpeg)\n\n![logo](img-1.png)",
      imageIds: ["img-0.jpeg"],
    });
    const out = expectRecord(
      await execRead("conv-fig", "attachments/report.pdf"),
    );
    const content = readString(out, "content");
    // Manifest id rewritten; non-stored id untouched.
    expect(content).toContain("attachments/report.pdf/img-0.jpeg");
    expect(content).toContain("![logo](img-1.png)");
    expect(content).not.toContain("attachments/report.pdf/img-1.png");
  });

  test("legacy extraction (no stored images) keeps refs untouched", async () => {
    seedAttachment({
      conversationId: "conv-legacy",
      filename: "old.pdf",
      mimeType: "application/pdf",
      extractionMarkdown: "![chart](img-0.jpeg)",
    });
    const out = expectRecord(
      await execRead("conv-legacy", "attachments/old.pdf"),
    );
    expect(readString(out, "content")).toContain("![chart](img-0.jpeg)");
    expect(readString(out, "content")).not.toContain(
      "attachments/old.pdf/img-0.jpeg",
    );
  });

  test("read on a figure path steers to vision", async () => {
    seedAttachment({
      conversationId: "conv-figread",
      filename: "report.pdf",
      mimeType: "application/pdf",
      extractionMarkdown: "![chart](img-0.jpeg)",
      imageIds: ["img-0.jpeg"],
    });
    const out = expectRecord(
      await execRead("conv-figread", "attachments/report.pdf/img-0.jpeg"),
    );
    expect(out["code"]).toBe("NO_TEXT_CONTENT");
    expect(out["hint"]).toBe("vision");
    expect(readString(out, "error")).toContain("vision(");
  });
});

describe("read tool — non-attachment workspace paths", () => {
  test("explicit subdir paths read directly (outputs/)", async () => {
    sandboxFs.write("conv-c2", "outputs/report.md", "alpha\nbravo");
    const out = expectRecord(await execRead("conv-c2", "outputs/report.md"));
    expect(out["source"]).toBe("original");
    expect(out["totalLines"]).toBe(2);
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

  test("context/<file>.pdf serves the extracted markdown Bun-side (no sandbox)", async () => {
    contextFiles.push({
      id: "ctx-1",
      profileId: "profile-1",
      filename: "handbook.pdf",
      mimeType: "application/pdf",
      status: "ready",
      content: "Internal handbook contents",
    });
    const out = expectRecord(
      await execRead("conv-ctx", "context/handbook.pdf"),
    );
    expect(out["source"]).toBe("original");
    expect(readString(out, "content")).toContain("Internal handbook");
  });

  test("context/<file>.xlsx routes to python instead of dumping text", async () => {
    contextFiles.push({
      id: "ctx-2",
      profileId: "profile-1",
      filename: "grid.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      status: "ready",
      content: null,
    });
    const out = expectRecord(await execRead("conv-ctx", "context/grid.xlsx"));
    expect(out["code"]).toBe("BINARY_NOT_READABLE");
    expect(readString(out, "hint")).toBe("python");
  });
});

describe("read tool — persisted-output handoff", () => {
  test("oversized content is wrapped in a <persisted-output> envelope", async () => {
    // Many short lines: the 30K byte cap trims the join, then cat -n
    // line-numbering inflates it past the 120K persist threshold.
    const huge = Array.from({ length: 30_000 }, () => "x").join("\n");
    seedAttachment({
      conversationId: "conv-h",
      filename: "big.md",
      mimeType: "text/markdown",
      textContent: huge,
    });
    const out = await execRead("conv-h", "attachments/big.md", {
      limit: 30_000,
    });
    expect(typeof out).toBe("string");
    const envelope = out as string;
    expect(envelope).toContain("<persisted-output>");
    expect(envelope).toContain("Output too large");
    expect(envelope).toContain("outputs/persisted/");
    expect(envelope).not.toContain("/tmp/");
  });
});
