/**
 * Unit tests for the sandbox-first conversation storage façade.
 *
 * The path-resolution helpers (`resolveWorkspacePath`) and the
 * exported workspace constants are pure logic and exercised here
 * directly. Sandbox + S3 round-trips (`writeFile`, `readFile`,
 * `attachUserFile`, …) are exercised through the in-memory mock
 * fixture so we keep these unit-style without spinning up E2B or S3.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { installSandboxMocks, sandboxFs } from "../../lib/sandbox-fixture";

installSandboxMocks();

const {
  attachUserFile,
  deleteFile,
  fileExists,
  listFiles,
  mirrorSandboxChanges,
  readFileText,
  resolveWorkspacePath,
  WORKSPACE_DIRS,
  WORKSPACE_ROOT,
  writeFile,
} = await import("../../../src/lib/conversation-storage");

beforeEach(() => {
  sandboxFs.reset();
});

describe("resolveWorkspacePath", () => {
  test("accepts workspace-relative paths", () => {
    const r = resolveWorkspacePath("attachments/foo.pdf");
    expect(r?.relative).toBe("attachments/foo.pdf");
    expect(r?.absolute).toBe("/workspace/attachments/foo.pdf");
  });

  test("strips the /workspace/ prefix on absolute paths", () => {
    const r = resolveWorkspacePath("/workspace/outputs/chart.png");
    expect(r?.relative).toBe("outputs/chart.png");
    expect(r?.absolute).toBe("/workspace/outputs/chart.png");
  });

  test("rejects absolute paths outside /workspace/", () => {
    expect(resolveWorkspacePath("/etc/passwd")).toBeNull();
    expect(resolveWorkspacePath("/var/log/foo.log")).toBeNull();
  });

  test("rejects literal `..` traversal segments", () => {
    expect(resolveWorkspacePath("../escape")).toBeNull();
    expect(resolveWorkspacePath("attachments/../../etc/passwd")).toBeNull();
    expect(resolveWorkspacePath("/workspace/../etc/passwd")).toBeNull();
  });

  test("sanitises forbidden characters per segment", () => {
    const r = resolveWorkspacePath("attachments/some file*name?.pdf");
    expect(r?.relative).toBe("attachments/some_file_name_.pdf");
  });

  test("rejects empty input", () => {
    expect(resolveWorkspacePath("")).toBeNull();
  });

  test("treats bare basenames as workspace-relative (no auto-prefix here)", () => {
    // The auto-attachments prefix is the read tool's convenience —
    // the façade resolver itself just normalises.
    const r = resolveWorkspacePath("invoice.pdf");
    expect(r?.relative).toBe("invoice.pdf");
  });
});

describe("WORKSPACE_DIRS / WORKSPACE_ROOT exports", () => {
  test("WORKSPACE_ROOT is /workspace", () => {
    expect(WORKSPACE_ROOT).toBe("/workspace");
  });

  test("named subdirs cover the documented six dirs", () => {
    expect(WORKSPACE_DIRS.attachments).toBe("attachments");
    expect(WORKSPACE_DIRS.outputs).toBe("outputs");
    expect(WORKSPACE_DIRS.outputsPersisted).toBe("outputs/persisted");
    expect(WORKSPACE_DIRS.drive).toBe("drive");
    expect(WORKSPACE_DIRS.skills).toBe("skills");
    expect(WORKSPACE_DIRS.context).toBe("context");
    expect(WORKSPACE_DIRS.memory).toBe("memory");
  });
});

describe("attachUserFile", () => {
  test("writes the file under attachments/ and queues an S3 backup", async () => {
    const result = await attachUserFile(
      "conv-1",
      "invoice.pdf",
      new TextEncoder().encode("PDF bytes"),
    );

    expect(result.path).toBe("attachments/invoice.pdf");
    expect(result.absolutePath).toBe("/workspace/attachments/invoice.pdf");
    expect(sandboxFs.exists("conv-1", "attachments/invoice.pdf")).toBe(true);

    // S3 backup queue is fire-and-forget — give it a microtask to drain.
    await new Promise((r) => setImmediate(r));
    expect(sandboxFs.existsS3("conv-1", "attachments/invoice.pdf")).toBe(true);
  });

  test("sanitises the filename so attempts at path injection don't escape attachments/", async () => {
    const result = await attachUserFile("conv-1", "../escape.pdf", "x");
    // ".." is replaced with "_" via per-segment sanitisation; the
    // filename stays under attachments/.
    expect(result.path).toMatch(/^attachments\//);
    expect(result.path).not.toContain("..");
  });
});

describe("writeFile / readFileText", () => {
  test("round-trips a string under attachments/", async () => {
    await writeFile("conv-2", "attachments/note.md", "hello world");
    const text = await readFileText("conv-2", "attachments/note.md");
    expect(text).toBe("hello world");
  });

  test("absolute /workspace/ paths are normalised", async () => {
    await writeFile("conv-2", "/workspace/outputs/derived.csv", "a,b,c");
    const text = await readFileText("conv-2", "outputs/derived.csv");
    expect(text).toBe("a,b,c");
  });

  test("only attachments/ + outputs/ are mirrored to S3", async () => {
    await writeFile("conv-3", "attachments/a.txt", "A");
    await writeFile("conv-3", "outputs/b.txt", "B");
    // drive/ is read-only contractually, but writes still land in the
    // sandbox; they're just NOT backed up to S3.
    await writeFile("conv-3", "drive/c.txt", "C");
    await new Promise((r) => setImmediate(r));

    expect(sandboxFs.existsS3("conv-3", "attachments/a.txt")).toBe(true);
    expect(sandboxFs.existsS3("conv-3", "outputs/b.txt")).toBe(true);
    expect(sandboxFs.existsS3("conv-3", "drive/c.txt")).toBe(false);
  });
});

describe("fileExists / listFiles / deleteFile", () => {
  test("fileExists returns false for missing, true after write", async () => {
    expect(await fileExists("conv-4", "attachments/x.txt")).toBe(false);
    await writeFile("conv-4", "attachments/x.txt", "x");
    expect(await fileExists("conv-4", "attachments/x.txt")).toBe(true);
  });

  test("listFiles narrows by subdir", async () => {
    await writeFile("conv-5", "attachments/a.txt", "a");
    await writeFile("conv-5", "outputs/b.txt", "b");

    // The full workspace listing contains everything bootstrap
    // pushed (skill bundles + init marker) plus our two writes.
    // Asserting on the totals is brittle; narrow by subdir instead.
    const attachments = await listFiles("conv-5", "attachments");
    expect(attachments.map((f) => f.path).sort()).toEqual([
      "attachments/a.txt",
    ]);

    const outputs = await listFiles("conv-5", "outputs");
    expect(outputs.map((f) => f.path).sort()).toEqual(["outputs/b.txt"]);
  });

  test("deleteFile removes from sandbox and from S3 when backup-eligible", async () => {
    await writeFile("conv-6", "attachments/doomed.txt", "x");
    await new Promise((r) => setImmediate(r));
    expect(sandboxFs.exists("conv-6", "attachments/doomed.txt")).toBe(true);
    expect(sandboxFs.existsS3("conv-6", "attachments/doomed.txt")).toBe(true);

    await deleteFile("conv-6", "attachments/doomed.txt");
    await new Promise((r) => setImmediate(r));
    expect(sandboxFs.exists("conv-6", "attachments/doomed.txt")).toBe(false);
    expect(sandboxFs.existsS3("conv-6", "attachments/doomed.txt")).toBe(false);
  });
});

describe("mirrorSandboxChanges", () => {
  test("mirrors only paths under attachments/ + outputs/ to S3", async () => {
    // Pre-populate the sandbox as if python wrote three files.
    sandboxFs.write("conv-7", "attachments/uploaded.txt", "A");
    sandboxFs.write("conv-7", "outputs/chart.png", "P");
    sandboxFs.write("conv-7", "drive/skipped.txt", "D");

    await mirrorSandboxChanges(
      "conv-7",
      [
        { path: "attachments/uploaded.txt", mime: "text/plain", size: 1 },
        { path: "outputs/chart.png", mime: "image/png", size: 1 },
        { path: "drive/skipped.txt", mime: "text/plain", size: 1 },
      ],
      [],
    );
    await new Promise((r) => setImmediate(r));

    expect(sandboxFs.existsS3("conv-7", "attachments/uploaded.txt")).toBe(true);
    expect(sandboxFs.existsS3("conv-7", "outputs/chart.png")).toBe(true);
    expect(sandboxFs.existsS3("conv-7", "drive/skipped.txt")).toBe(false);
  });

  test("propagates deletions to S3 for backup-eligible paths", async () => {
    sandboxFs.seedS3("conv-8", "attachments/old.txt", "x");
    expect(sandboxFs.existsS3("conv-8", "attachments/old.txt")).toBe(true);

    await mirrorSandboxChanges("conv-8", [], ["attachments/old.txt"]);
    await new Promise((r) => setImmediate(r));

    expect(sandboxFs.existsS3("conv-8", "attachments/old.txt")).toBe(false);
  });
});
