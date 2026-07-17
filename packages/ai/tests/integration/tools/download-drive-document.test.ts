/**
 * Integration tests for the `download_drive_document` tool. Covers
 * ACL, not-ready guard, idempotent re-download, the 100 MB
 * conversation quota, and the `NOT_FOUND` / `S3_OBJECT_MISSING`
 * error codes.
 *
 * Real Postgres is required (every other ai-test in this package
 * also runs against a live DB — see `tests/lib/db-fixtures.ts`).
 * Only the S3 fetch is mocked at the module boundary so the test
 * controls the bytes returned for each `s3Key`. The conversation
 * sandbox is mocked via the shared `sandbox-fixture`.
 */
import db from "@fretik/shared/db";
import { documents, organization, team } from "@fretik/shared/db/schema";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
import { installSandboxMocks, sandboxFs } from "../../lib/sandbox-fixture";

installSandboxMocks();

// --------------------------------------------------------------- //
// S3 mock — only this layer is faked; DB is real.                  //
// --------------------------------------------------------------- //

const s3Bytes = new Map<string, Uint8Array>();
// Mock the full `lib/s3` surface. Bun's `mock.module` is process-global,
// so any export consumed by a downstream test file (chat-files
// handlers, sql, …) must exist here even if it's a no-op — otherwise
// the bare-import of `getPresignedUrl` in another file fails to
// resolve.
void mock.module("@fretik/shared/lib/s3", () => ({
  putObject: async () => {
    /* no-op */
  },
  getObject: async () => null,
  getObjectBytes: async (key: string): Promise<Uint8Array | null> =>
    s3Bytes.get(key) ?? null,
  listObjects: async () => [],
  deleteObject: async () => {
    /* no-op */
  },
  deleteObjects: async () => {
    /* no-op */
  },
  getPresignedUrl: async (key: string) => `https://mock.s3/${key}`,
  uploadToS3: async () => "",
  getFileFromS3: async () => null,
  deleteFilesFromS3: async () => {
    /* no-op */
  },
}));

const { createDownloadDriveDocumentTool } =
  await import("../../../src/tools/download-drive-document");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");

// --------------------------------------------------------------- //
// Real DB fixture — org + two teams (ACL test needs cross-team).   //
// --------------------------------------------------------------- //

interface DriveFixture {
  organizationId: string;
  teamId: string;
  otherTeamId: string;
  insertedDocIds: string[];
  /** Insert a documents row scoped to the fixture's primary team. */
  insertDoc: (args: {
    teamId?: string;
    status?: "uploading" | "converting" | "ready" | "error";
    originalFilename?: string;
    fileSize?: number;
    mimeType?: string;
    bytes?: Uint8Array;
  }) => Promise<string>;
}

let fx: DriveFixture;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const buildOptions = (conversationId: string, teamId: string) => {
  const ctx = {
    organizationId: fx.organizationId,
    teamId,
    conversationId,
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  };
  return {
    toolCallId: `tc-${Date.now().toString()}`,
    messages: [] as never[],
    context: wrapRuntimeContext(ctx),
  };
};

const execDownload = async (
  conversationId: string,
  documentId: string,
  teamId: string,
): Promise<Record<string, unknown>> => {
  const tool = createDownloadDriveDocumentTool();
  if (typeof tool.execute !== "function") {
    throw new Error("download_drive_document tool missing execute");
  }
  const result = await tool.execute(
    { documentId },
    buildOptions(conversationId, teamId),
  );
  if (!isRecord(result)) {
    throw new Error(
      `download_drive_document returned non-object: ${JSON.stringify(result)}`,
    );
  }
  return result;
};

beforeAll(async () => {
  const suffix = randomUUID().slice(0, 8);
  const [org] = await db
    .insert(organization)
    .values({
      name: `dl-test-org-${suffix}`,
      slug: `dl-test-org-${suffix}`,
      createdAt: new Date(),
    })
    .returning({ id: organization.id });
  if (!org) throw new Error("fixture: failed to insert organization");

  const teamRows = await db
    .insert(team)
    .values([
      {
        name: `dl-test-team-${suffix}`,
        organizationId: org.id,
        createdAt: new Date(),
      },
      {
        name: `dl-test-other-${suffix}`,
        organizationId: org.id,
        createdAt: new Date(),
      },
    ])
    .returning({ id: team.id });
  const primary = teamRows[0];
  const other = teamRows[1];
  if (!primary || !other) {
    throw new Error("fixture: failed to insert two teams");
  }

  const insertedDocIds: string[] = [];
  const insertDoc: DriveFixture["insertDoc"] = async (args) => {
    const id = randomUUID();
    const originalFilename = args.originalFilename ?? "doc.pdf";
    // Keys are derived from id + originalFilename — same as production
    // (`buildDocumentOriginalKey`). Stage the mocked S3 bytes under
    // that key so `getObjectBytes` resolves it via `s3Bytes.get(...)`.
    const ext = originalFilename.includes(".")
      ? originalFilename.slice(originalFilename.lastIndexOf("."))
      : ".pdf";
    const s3Key = `documents/${id}${ext}`;
    const bytes = args.bytes ?? null;
    if (bytes !== null) s3Bytes.set(s3Key, bytes);

    const fileSize = args.fileSize ?? (bytes ? bytes.byteLength : 1024);

    await db.insert(documents).values({
      id,
      teamId: args.teamId ?? primary.id,
      status: args.status ?? "ready",
      originalFilename,
      fileSize,
      mimeType: args.mimeType ?? "application/pdf",
      fileHash: `hash-${randomUUID()}`,
    });
    insertedDocIds.push(id);
    return id;
  };

  fx = {
    organizationId: org.id,
    teamId: primary.id,
    otherTeamId: other.id,
    insertedDocIds,
    insertDoc,
  };
});

afterAll(async () => {
  // Cascade delete via the team FK on documents.
  await db.delete(organization).where(eq(organization.id, fx.organizationId));
});

beforeEach(() => {
  sandboxFs.reset();
  s3Bytes.clear();
});

describe("download_drive_document — ACL + status checks", () => {
  test("returns NOT_FOUND when the document doesn't exist", async () => {
    const out = await execDownload("conv-1", randomUUID(), fx.teamId);
    expect(out["code"]).toBe("NOT_FOUND");
  });

  test("returns FORBIDDEN for documents owned by another team", async () => {
    const docId = await fx.insertDoc({
      teamId: fx.otherTeamId,
      bytes: new TextEncoder().encode("secret"),
    });
    const out = await execDownload("conv-1", docId, fx.teamId);
    expect(out["code"]).toBe("FORBIDDEN");
    expect(sandboxFs.list("conv-1", "drive").length).toBe(0);
  });

  test("returns NOT_READY when the document is still processing", async () => {
    const docId = await fx.insertDoc({ status: "uploading" });
    const out = await execDownload("conv-1", docId, fx.teamId);
    expect(out["code"]).toBe("NOT_READY");
    expect(typeof out["error"]).toBe("string");
  });
});

describe("download_drive_document — happy path + idempotence", () => {
  test("streams bytes from S3 into /workspace/drive/{id}-{filename}", async () => {
    const payload = new TextEncoder().encode("PDF bytes");
    const docId = await fx.insertDoc({
      originalFilename: "invoice.pdf",
      bytes: payload,
    });

    const out = await execDownload("conv-2", docId, fx.teamId);
    expect(out["error"]).toBeUndefined();
    expect(out["path"]).toBe(`drive/${docId}-invoice.pdf`);
    expect(out["absolutePath"]).toBe(`/workspace/drive/${docId}-invoice.pdf`);
    expect(out["filename"]).toBe("invoice.pdf");
    expect(out["mimeType"]).toBe("application/pdf");
    expect(out["size"]).toBe(payload.byteLength);

    const stored = sandboxFs.read("conv-2", `drive/${docId}-invoice.pdf`);
    expect(stored).not.toBeNull();
    expect(new TextDecoder().decode(stored ?? new Uint8Array())).toBe(
      "PDF bytes",
    );
  });

  test("a second call short-circuits with alreadyPresent=true", async () => {
    const docId = await fx.insertDoc({
      originalFilename: "report.pdf",
      bytes: new TextEncoder().encode("payload"),
    });

    const first = await execDownload("conv-3", docId, fx.teamId);
    expect(first["error"]).toBeUndefined();
    expect(first["alreadyPresent"]).toBeUndefined();

    const second = await execDownload("conv-3", docId, fx.teamId);
    expect(second["error"]).toBeUndefined();
    expect(second["alreadyPresent"]).toBe(true);
  });

  test("drive/ files are NOT mirrored to S3 (re-downloadable from documents)", async () => {
    const docId = await fx.insertDoc({
      originalFilename: "no-backup.pdf",
      bytes: new TextEncoder().encode("payload"),
    });

    await execDownload("conv-4", docId, fx.teamId);
    await new Promise((r) => setImmediate(r));

    expect(sandboxFs.existsS3("conv-4", `drive/${docId}-no-backup.pdf`)).toBe(
      false,
    );
  });
});

describe("download_drive_document — quota", () => {
  test("rejects with QUOTA_EXCEEDED once the cumulative drive/ size > 100 MB", async () => {
    sandboxFs.write(
      "conv-5",
      "drive/00000000-already-here.bin",
      new Uint8Array(99 * 1024 * 1024),
    );

    const docId = await fx.insertDoc({
      originalFilename: "big.pdf",
      fileSize: 5 * 1024 * 1024,
      bytes: new Uint8Array(5 * 1024 * 1024),
    });

    const out = await execDownload("conv-5", docId, fx.teamId);
    expect(out["code"]).toBe("QUOTA_EXCEEDED");
    expect(typeof out["usedBytes"]).toBe("number");
    expect(typeof out["quotaBytes"]).toBe("number");
    expect(sandboxFs.exists("conv-5", `drive/${docId}-big.pdf`)).toBe(false);
  });
});

describe("download_drive_document — S3 errors", () => {
  test("returns S3_OBJECT_MISSING when the bucket has no bytes for the key", async () => {
    // Insert without seeding bytes for the s3Key.
    const docId = await fx.insertDoc({ originalFilename: "ghost.pdf" });

    const out = await execDownload("conv-6", docId, fx.teamId);
    expect(out["code"]).toBe("S3_OBJECT_MISSING");
  });
});
