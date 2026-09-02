/**
 * `vision` on a virtual figure path — `attachments/<file>/img-N.ext`.
 *
 * The tool resolves these DB-FIRST: `ai_chat_files` scoped to the
 * conversation gives the file hash, `file_extractions` scoped to the
 * organization gives the image manifest, and only then does S3 hand over the
 * bytes. Zero sandbox involvement.
 *
 * It ran as a unit test until 2026-09-02 against a `db` Proxy that answered
 * `aiChatFiles` on (conversationId, filename) and `fileExtractions` on
 * (organizationId, fileHash) — i.e. that re-implemented in JavaScript the two
 * predicates the whole file is about. Both scopes were therefore enforced by
 * the test rather than tested by it, and neither cross-boundary case below
 * could be written at all.
 *
 * Real Postgres. S3 and the vision model stay doubled: one is a bucket, the
 * other a model call, and `describeVisionFile` is also the only place the
 * bytes handed to the model can be observed.
 */
import db from "@fretik/shared/db";
import { aiChatFiles, fileExtractions } from "@fretik/shared/db/schema";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
import { mockModule } from "../../lib/mock-module";
import { installSandboxMocks } from "../../lib/sandbox-fixture";
import { asToolRecord } from "../../lib/tool-result";
import type { MemoryTestFixture } from "../lib/db-fixtures";
import { createMemoryTestFixture } from "../lib/db-fixtures";

installSandboxMocks();

/** Stored image bytes keyed by full S3 key. */
const s3Images = new Map<string, Uint8Array>();
/** Every describeVisionFile invocation, for assertions. */
const visionCalls: { mimeType: string; filename?: string; bytes: number }[] =
  [];

/**
 * ONE override, spread over the real module.
 *
 * `mockModule` and not `mockModuleStrict` on purpose: the strict variant
 * poisons every export it is not handed, and half of this module is pure key
 * arithmetic (`buildExtractionImageKey`, `extractedImageContentType`) that the
 * tool calls on exactly the path under test. Listing those in the factory
 * means re-writing them, which is how the fake this file replaces came to
 * decide for itself where a figure lives. Left real, the S3 KEY the tool
 * builds is the one production builds, and the map below is addressed by it.
 *
 * The remaining S3 functions stay real and unreachable — nothing here calls
 * them, and the preload points the bucket at a dead port, so a stray call
 * fails by name rather than reaching a bucket.
 */
await mockModule("@fretik/shared/services/file-extraction/storage", {
  readExtractionImage: async (key: string) => s3Images.get(key) ?? null,
});

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
    return {
      question: args.question,
      model: "test/vision-model",
      description: `described ${args.filename ?? "?"}`,
      truncated: false,
    };
  },
});

const { createVisionTool } = await import("../../../src/tools/vision");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");
const { buildExtractionImageKey } =
  await import("@fretik/shared/services/file-extraction/storage");

let fx: MemoryTestFixture;
let otherFx: MemoryTestFixture;
let conversationId: string;
/** A second conversation in the SAME workspace — the neighbour that must not leak. */
let otherConversationId: string;

beforeAll(async () => {
  fx = await createMemoryTestFixture();
  otherFx = await createMemoryTestFixture();
  conversationId = await fx.createConversation();
  otherConversationId = await fx.createConversation();
});

afterAll(async () => {
  await fx.cleanup();
  await otherFx.cleanup();
});

beforeEach(async () => {
  s3Images.clear();
  visionCalls.length = 0;
  await db
    .delete(aiChatFiles)
    .where(
      inArray(aiChatFiles.conversationId, [
        conversationId,
        otherConversationId,
      ]),
    );
  await db
    .delete(fileExtractions)
    .where(
      inArray(fileExtractions.organizationId, [
        fx.organizationId,
        otherFx.organizationId,
      ]),
    );
});

const execVision = async (
  file_path: string,
  question = "what does it show?",
): Promise<Record<string, unknown>> => {
  const tool = createVisionTool();
  if (typeof tool.execute !== "function") {
    throw new Error("vision tool missing execute");
  }
  const ctx = {
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    conversationId,
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  };
  const result = await tool.execute(
    { file_path, question },
    {
      toolCallId: `tc-${Math.random().toString(36).slice(2, 8)}`,
      messages: [],
      context: wrapRuntimeContext(ctx),
    },
  );
  return asToolRecord("vision", result);
};

const attach = async (args: {
  conversationId: string;
  filename: string;
  fileHash: string | null;
}): Promise<void> => {
  await db.insert(aiChatFiles).values({
    conversationId: args.conversationId,
    filename: args.filename,
    mimeType: "application/pdf",
    size: 1024,
    fileHash: args.fileHash,
  });
};

const extractionFor = async (args: {
  organizationId: string;
  fileHash: string;
  imageIds: string[];
}): Promise<void> => {
  await db.insert(fileExtractions).values({
    organizationId: args.organizationId,
    fileHash: args.fileHash,
    mimeType: "application/pdf",
    route: "mistral-ocr",
    imageIds: args.imageIds,
  });
};

/** The whole chain: attachment → extraction manifest → bytes in the bucket. */
const seedFigure = async (args: {
  conversationId?: string;
  organizationId?: string;
  filename: string;
  fileHash: string;
  imageIds: string[];
  storedImages?: string[];
}): Promise<void> => {
  const org = args.organizationId ?? fx.organizationId;
  await attach({
    conversationId: args.conversationId ?? conversationId,
    filename: args.filename,
    fileHash: args.fileHash,
  });
  await extractionFor({
    organizationId: org,
    fileHash: args.fileHash,
    imageIds: args.imageIds,
  });
  for (const id of args.storedImages ?? args.imageIds) {
    s3Images.set(
      buildExtractionImageKey(org, args.fileHash, id),
      new Uint8Array([9, 9, 9, 9]),
    );
  }
};

describe("vision tool — extracted figures (cache-resolved, no sandbox)", () => {
  test("resolves a stored figure and describes its bytes", async () => {
    await seedFigure({
      filename: "report.pdf",
      fileHash: "hash-r",
      imageIds: ["img-2.jpeg"],
    });

    const out = await execVision("attachments/report.pdf/img-2.jpeg");

    expect(out["description"]).toBe("described img-2.jpeg");
    expect(out["mimeType"]).toBe("image/jpeg");
    expect(out["model"]).toBe("test/vision-model");
    expect(visionCalls).toHaveLength(1);
    expect(visionCalls[0]?.bytes).toBe(4);
  });

  test("figure id not in the manifest → FILE_NOT_FOUND steering to read", async () => {
    await seedFigure({
      filename: "report.pdf",
      fileHash: "hash-r",
      imageIds: ["img-0.jpeg"],
    });

    const out = await execVision("attachments/report.pdf/img-9.jpeg");

    expect(out["code"]).toBe("FILE_NOT_FOUND");
    expect(String(out["error"])).toContain('read("attachments/report.pdf")');
    expect(visionCalls).toHaveLength(0);
  });

  test("attachment without a hash (legacy) → FILE_NOT_FOUND, no vision call", async () => {
    await attach({ conversationId, filename: "old.pdf", fileHash: null });

    const out = await execVision("attachments/old.pdf/img-0.jpeg");

    expect(out["code"]).toBe("FILE_NOT_FOUND");
    expect(visionCalls).toHaveLength(0);
  });

  test("manifest lists the id but S3 misses the object → FILE_NOT_FOUND", async () => {
    await seedFigure({
      filename: "report.pdf",
      fileHash: "hash-r",
      imageIds: ["img-1.png"],
      storedImages: [],
    });

    const out = await execVision("attachments/report.pdf/img-1.png");

    expect(out["code"]).toBe("FILE_NOT_FOUND");
    expect(visionCalls).toHaveLength(0);
  });

  test("an attachment of ANOTHER conversation is not visible here", async () => {
    // The attachment lookup is scoped to the conversation, which is what keeps
    // one turn from reading a file uploaded in another. The old fake enforced
    // that itself, in the test.
    await seedFigure({
      conversationId: otherConversationId,
      filename: "report.pdf",
      fileHash: "hash-neighbour",
      imageIds: ["img-2.jpeg"],
    });

    const out = await execVision("attachments/report.pdf/img-2.jpeg");

    expect(out["code"]).toBe("FILE_NOT_FOUND");
    expect(visionCalls).toHaveLength(0);
  });

  test("an extraction of another ORGANIZATION does not satisfy the hash", async () => {
    // Extractions are content-addressed: the same bytes uploaded by two
    // customers share a `file_hash`, and the ONLY thing keeping one tenant's
    // extracted figures out of the other's answers is `organization_id`.
    await attach({
      conversationId,
      filename: "report.pdf",
      fileHash: "hash-shared",
    });
    await extractionFor({
      organizationId: otherFx.organizationId,
      fileHash: "hash-shared",
      imageIds: ["img-2.jpeg"],
    });
    s3Images.set(
      buildExtractionImageKey(
        otherFx.organizationId,
        "hash-shared",
        "img-2.jpeg",
      ),
      new Uint8Array([9, 9, 9, 9]),
    );

    const out = await execVision("attachments/report.pdf/img-2.jpeg");

    expect(out["code"]).toBe("FILE_NOT_FOUND");
    expect(visionCalls).toHaveLength(0);
  });

  test("the same hash extracted in BOTH organizations serves this one's copy", async () => {
    // The other half of the claim: scoping must refuse the neighbour without
    // refusing the tenant's own row for the identical content.
    await seedFigure({
      filename: "report.pdf",
      fileHash: "hash-shared",
      imageIds: ["img-2.jpeg"],
    });
    await extractionFor({
      organizationId: otherFx.organizationId,
      fileHash: "hash-shared",
      imageIds: ["img-2.jpeg"],
    });

    const out = await execVision("attachments/report.pdf/img-2.jpeg");

    expect(out["description"]).toBe("described img-2.jpeg");
    expect(visionCalls).toHaveLength(1);
  });
});
