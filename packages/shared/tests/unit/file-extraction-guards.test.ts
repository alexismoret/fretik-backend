import { beforeEach, describe, expect, test } from "bun:test";
import { mockModule } from "./mock-module";

// ---------------------------------------------------------------- //
// Guards around the Mistral OCR boundary: the pre-flight file-size  //
// guard in `getOrCreateExtraction` (no doomed API call) and the     //
// no-images retry in `runMistralOcr` (image extraction can never    //
// make extraction worse). The Mistral SDK client and the db are     //
// mocked at module level — dynamic imports below resolve AFTER.     //
// ---------------------------------------------------------------- //

interface OcrProcessCall {
  includeImageBase64?: boolean | null;
  imageLimit?: number | null;
}
const ocrCalls: OcrProcessCall[] = [];
let ocrBehavior: (call: OcrProcessCall) => {
  pages: {
    index: number;
    markdown: string;
    images: { id: string; imageBase64?: string | null }[];
  }[];
} = () => ({ pages: [] });

await mockModule("../../src/lib/mistral", {
  mistralClient: {
    ocr: {
      process: async (call: OcrProcessCall) => {
        ocrCalls.push(call);
        return ocrBehavior(call);
      },
    },
  },
});

// Writes are FORBIDDEN by default — the size guard's contract is that it
// returns before claiming a cache row. The blob-route tests below opt in.
let dbWritesAllowed = false;

const claimedRow = [{ id: "extraction-row" }];
const insertChain = {
  values: () => insertChain,
  onConflictDoNothing: () => insertChain,
  returning: async () => claimedRow,
};
const updateChain = {
  set: () => updateChain,
  where: () => updateChain,
  returning: async () => claimedRow,
  then: (resolve: (value: undefined) => void) => {
    resolve(undefined);
  },
};

await mockModule("../../src/db", {
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
    insert: () => {
      if (!dbWritesAllowed) {
        throw new Error("db.insert must not be reached by guarded paths");
      }
      return insertChain;
    },
    update: () => {
      if (!dbWritesAllowed) {
        throw new Error("db.update must not be reached by guarded paths");
      }
      return updateChain;
    },
  },
});

// The guarded paths under test never touch S3, and every reader is neutered
// so a stray call fails as "nothing there" rather than reaching the network.
// The list is exhaustive on purpose — not to mirror the module (`mockModule`
// carries the exports nobody overrides), but because a real S3 call escaping
// through an unlisted one would fail as a timeout, not as an assertion.
await mockModule("../../src/lib/s3", {
  putObject: async () => undefined,
  publicUrl: (key: string) => `https://s3.test/${key}`,
  // getObject/getFileFromS3 throw on a missing key; only getObjectBytes
  // flattens "missing" and "faulted" into null.
  getObject: async () => {
    throw new Error("NoSuchKey");
  },
  getObjectBytes: async () => null,
  copyObject: async () => undefined,
  listObjects: async () => [],
  deleteObject: async () => undefined,
  deleteObjects: async () => undefined,
  getPresignedUrl: async () => "https://s3.test/presigned",
  uploadToS3: async () => "unused",
  getFileFromS3: async () => {
    throw new Error("NoSuchKey");
  },
  deleteFilesFromS3: async () => undefined,
});

const {
  runMistralOcr,
  MISTRAL_OCR_LIMIT_ERROR_MESSAGE,
  MISTRAL_OCR_MAX_FILE_BYTES,
} = await import("../../src/lib/mistral-ocr");
const { getOrCreateExtraction } =
  await import("../../src/services/file-extraction/extract");

beforeEach(() => {
  ocrCalls.length = 0;
  ocrBehavior = () => ({ pages: [] });
  dbWritesAllowed = false;
});

/**
 * Blob routes — the ones that produce one markdown string instead of OCR
 * pages — still owe their callers a page. Drive's pre-extract reads
 * `pages` and treats an empty list as a failed extraction, which is how
 * an HTML upload used to fail on its first pass and succeed on the
 * second: the live path returned no page, the cache hit rebuilt one.
 */
describe("getOrCreateExtraction — blob routes yield a page", () => {
  test("the inline text route (json, svg, source code) returns one page", async () => {
    const result = await getOrCreateExtraction({
      organizationId: "org-1",
      fileHash: "hash-json",
      mimeType: "application/json",
      filename: "config.json",
      getBytes: async () => new TextEncoder().encode('{"a":1}'),
      getPresignedUrl: async () => "https://s3/presigned",
    });
    expect(result.route).toBe("text");
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.markdown).toBe(result.markdown ?? "");
    expect(result.markdown).toContain('"a": 1');
  });

  test("HTML extracts to markdown on a single page", async () => {
    dbWritesAllowed = true;
    const result = await getOrCreateExtraction({
      organizationId: "org-1",
      fileHash: "hash-html",
      mimeType: "text/html",
      filename: "page.html",
      getBytes: async () =>
        new TextEncoder().encode("<h1>Title</h1><p>Body</p>"),
      getPresignedUrl: async () => "https://s3/presigned",
    });
    expect(result.route).toBe("html");
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.markdown).toContain("# Title");
    expect(ocrCalls).toHaveLength(0);
  });

  test("a horizontal rule in the markdown does not split it into pages", async () => {
    dbWritesAllowed = true;
    const result = await getOrCreateExtraction({
      organizationId: "org-1",
      fileHash: "hash-html-hr",
      mimeType: "text/html",
      filename: "ruled.html",
      getBytes: async () =>
        new TextEncoder().encode("<p>before</p><hr /><p>after</p>"),
      getPresignedUrl: async () => "https://s3/presigned",
    });
    expect(result.pages).toHaveLength(1);
  });
});

describe("getOrCreateExtraction — file-size guard", () => {
  test("an over-limit document returns a clean error without any OCR call", async () => {
    const result = await getOrCreateExtraction({
      organizationId: "org-1",
      fileHash: "hash-big",
      mimeType: "application/pdf",
      filename: "big.pdf",
      fileSizeBytes: MISTRAL_OCR_MAX_FILE_BYTES + 1,
      getBytes: async () => new Uint8Array(0),
      getPresignedUrl: async () => "https://s3/presigned",
    });
    expect(result.error).toBe(MISTRAL_OCR_LIMIT_ERROR_MESSAGE);
    expect(result.markdown).toBeNull();
    expect(result.imageIds).toEqual([]);
    expect(ocrCalls).toHaveLength(0);
  });

  test("the guard message is agent-readable, not an SDK dump", () => {
    expect(MISTRAL_OCR_LIMIT_ERROR_MESSAGE).toContain("50 MB");
    expect(MISTRAL_OCR_LIMIT_ERROR_MESSAGE).toContain("1000 pages");
    expect(MISTRAL_OCR_LIMIT_ERROR_MESSAGE).toContain("python");
  });
});

describe("runMistralOcr — embedded images", () => {
  test("maps images and strips a data-URL prefix; skips empty payloads", async () => {
    ocrBehavior = () => ({
      pages: [
        {
          index: 0,
          markdown: "![a](img-0.jpeg)",
          images: [
            { id: "img-0.jpeg", imageBase64: "data:image/jpeg;base64,QUJD" },
            { id: "img-1.png", imageBase64: null },
          ],
        },
        {
          index: 1,
          markdown: "page 2",
          images: [{ id: "img-2.png", imageBase64: "RE VG".replace(" ", "") }],
        },
      ],
    });
    const result = await runMistralOcr({
      url: "https://s3/presigned",
      mimeType: "application/pdf",
      extractImages: true,
    });
    expect(result.pageCount).toBe(2);
    expect(result.images).toEqual([
      { id: "img-0.jpeg", pageIndex: 0, base64: "QUJD" },
      { id: "img-2.png", pageIndex: 1, base64: "REVG" },
    ]);
    expect(ocrCalls).toHaveLength(1);
    expect(ocrCalls[0]?.includeImageBase64).toBe(true);
  });

  test("extractImages absent → legacy no-images request, images always []", async () => {
    ocrBehavior = () => ({
      pages: [{ index: 0, markdown: "text", images: [] }],
    });
    const result = await runMistralOcr({
      url: "https://s3/presigned",
      mimeType: "application/pdf",
    });
    expect(result.images).toEqual([]);
    expect(ocrCalls[0]?.includeImageBase64).toBe(false);
    expect(ocrCalls[0]?.imageLimit).toBe(0);
  });

  test("an error with images requested retries ONCE without images", async () => {
    ocrBehavior = (call) => {
      if (call.includeImageBase64 === true) {
        throw new Error("400 extracted images can only be returned in base64");
      }
      return { pages: [{ index: 0, markdown: "recovered", images: [] }] };
    };
    const result = await runMistralOcr({
      url: "https://s3/presigned",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extractImages: true,
    });
    expect(result.pages[0]?.markdown).toBe("recovered");
    expect(result.images).toEqual([]);
    expect(ocrCalls).toHaveLength(2);
    expect(ocrCalls[1]?.includeImageBase64).toBe(false);
  });

  test("an error WITHOUT images requested propagates — no retry loop", async () => {
    ocrBehavior = () => {
      throw new Error("document exceeds page limit");
    };
    let message = "";
    try {
      await runMistralOcr({
        url: "https://s3/presigned",
        mimeType: "application/pdf",
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe("document exceeds page limit");
    expect(ocrCalls).toHaveLength(1);
  });

  test("a persistent error after the no-images retry propagates (no infinite retry)", async () => {
    ocrBehavior = () => {
      throw new Error("provider unavailable");
    };
    let message = "";
    try {
      await runMistralOcr({
        url: "https://s3/presigned",
        mimeType: "application/pdf",
        extractImages: true,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe("provider unavailable");
    expect(ocrCalls).toHaveLength(2);
  });
});
