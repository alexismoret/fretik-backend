/**
 * `downloadFile` — the supported way bytes behind a URL reach the workspace.
 *
 * The sandbox cannot fetch them itself: its egress is an allowlist, so
 * `requests`/`curl` inside `python` or `bash` die on a killed TLS handshake.
 * This tool fetches server-side, which keeps the capability without handing
 * agent-authored code an open internet connection.
 *
 * What is asserted is what a model actually hits: a file named after what it
 * IS rather than what the URL called it, a second download that does not
 * silently overwrite the first, and a partial batch that still returns the
 * files that worked. The fetch itself is doubled — reaching the network here
 * would be a test that measures someone else's uptime.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
import { installSandboxMocks, sandboxFs } from "../../lib/sandbox-fixture";

installSandboxMocks();

interface FetchOutcome {
  ok?: true;
  finalUrl?: string;
  status?: number;
  contentType?: string | null;
  contentDisposition?: string | null;
  body?: Uint8Array;
  error?: string;
  code?: string;
}

/** What the doubled fetch answers, per URL. */
const responses = new Map<string, FetchOutcome>();
const fetched: { url: string; spent: number }[] = [];

void mock.module("../../../src/lib/download-file", () => ({
  safeFetchWithGuards: (url: string, spent: number) => {
    fetched.push({ url, spent });
    const hit = responses.get(url);
    if (hit === undefined) {
      return Promise.resolve({ error: "no double", code: "DOWNLOAD_FAILED" });
    }
    return Promise.resolve(hit);
  },
}));

const { createDownloadFileTool } =
  await import("../../../src/tools/download-file");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");

/** A real PDF header, so the type resolver sees what it actually sees. */
const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3, 0xcf,
  0xd3, 0x0a,
]);

const serve = (
  url: string,
  options: {
    body?: Uint8Array;
    contentType?: string | null;
    contentDisposition?: string | null;
    finalUrl?: string;
  } = {},
): void => {
  responses.set(url, {
    ok: true,
    finalUrl: options.finalUrl ?? url,
    status: 200,
    contentType: options.contentType ?? "application/pdf",
    contentDisposition: options.contentDisposition ?? null,
    body: options.body ?? PDF_BYTES,
  });
};

const refuse = (url: string, error: string, code: string): void => {
  responses.set(url, { error, code });
};

interface DownloadOutput {
  files?: { path: string; filename: string; bytes: number; mime: string }[];
  failed?: { url: string; error: string; code: string }[];
  error?: string;
  code?: string;
}

const CONVERSATION = "conv-download";

const run = async (input: {
  urls: string[];
  filename?: string;
}): Promise<DownloadOutput> => {
  const tool = createDownloadFileTool();
  const options = {
    toolCallId: `tc-${Date.now().toString()}`,
    messages: [] as never[],
    context: wrapRuntimeContext({
      organizationId: "org-1",
      teamId: "team-1",
      conversationId: CONVERSATION,
      modelProfile: getProfileForRole("chat"),
      dynamicToolManager: new DynamicToolManager(),
    }),
  };
  const result: unknown = await tool.execute?.(input, options);
  return result as DownloadOutput;
};

beforeEach(() => {
  sandboxFs.reset();
  responses.clear();
  fetched.length = 0;
});

describe("downloadFile — what lands in the workspace", () => {
  test("a file is written under downloads/ and its path is returned", async () => {
    serve("https://example.com/report.pdf");
    const out = await run({ urls: ["https://example.com/report.pdf"] });

    expect(out.files).toHaveLength(1);
    expect(out.files?.[0]?.path).toBe("downloads/report.pdf");
    expect(sandboxFs.exists(CONVERSATION, "downloads/report.pdf")).toBe(true);
  });

  test("it is mirrored to S3 before returning, because `read` presigns it", async () => {
    // Awaited on purpose: the fire-and-forget mirror would not have landed by
    // the time the next turn asks to read the file.
    serve("https://example.com/report.pdf");
    await run({ urls: ["https://example.com/report.pdf"] });
    expect(sandboxFs.existsS3(CONVERSATION, "downloads/report.pdf")).toBe(true);
  });

  test("the name comes from Content-Disposition when the URL carries none", async () => {
    serve("https://example.com/download?id=8213", {
      contentDisposition: 'attachment; filename="Q3 results.pdf"',
    });
    const out = await run({ urls: ["https://example.com/download?id=8213"] });
    expect(out.files?.[0]?.filename).toBe("Q3_results.pdf");
  });

  test("an explicit filename wins, for a single URL", async () => {
    serve("https://example.com/x.pdf");
    const out = await run({
      urls: ["https://example.com/x.pdf"],
      filename: "invoice",
    });
    expect(out.files?.[0]?.filename).toBe("invoice.pdf");
  });

  test("the extension follows the BYTES, not the URL's claim", async () => {
    // A PDF served as `.txt` is still a PDF; naming it `.txt` would send
    // `read` and `python` down the wrong path.
    serve("https://example.com/data.txt", { contentType: "text/plain" });
    const out = await run({ urls: ["https://example.com/data.txt"] });
    expect(out.files?.[0]?.mime).toBe("application/pdf");
    expect(out.files?.[0]?.filename).toEndWith(".pdf");
  });

  test("a filename cannot escape the directory", async () => {
    serve("https://example.com/evil", {
      contentDisposition: 'attachment; filename="../../etc/passwd"',
    });
    const out = await run({ urls: ["https://example.com/evil"] });
    expect(out.files?.[0]?.path.startsWith("downloads/")).toBe(true);
    expect(out.files?.[0]?.filename).not.toContain("/");
    expect(out.files?.[0]?.filename).not.toContain("..");
  });

  test("a second file of the same name does not overwrite the first", async () => {
    sandboxFs.write(CONVERSATION, "downloads/report.pdf", "the first one");
    serve("https://example.com/report.pdf");
    const out = await run({ urls: ["https://example.com/report.pdf"] });

    expect(out.files?.[0]?.filename).toBe("report-2.pdf");
    expect(
      new TextDecoder().decode(
        sandboxFs.read(CONVERSATION, "downloads/report.pdf") ??
          new Uint8Array(),
      ),
    ).toBe("the first one");
  });

  test("two URLs with the same basename in ONE call both survive", async () => {
    serve("https://a.example.com/report.pdf");
    serve("https://b.example.com/report.pdf");
    const out = await run({
      urls: [
        "https://a.example.com/report.pdf",
        "https://b.example.com/report.pdf",
      ],
    });
    expect(out.files?.map((f) => f.filename)).toEqual([
      "report.pdf",
      "report-2.pdf",
    ]);
  });
});

describe("downloadFile — refusals", () => {
  test("a partial batch returns the files that worked AND what did not", async () => {
    serve("https://example.com/ok.pdf");
    refuse("https://example.com/no.pdf", "HTTP 404", "DOWNLOAD_FAILED");
    const out = await run({
      urls: ["https://example.com/ok.pdf", "https://example.com/no.pdf"],
    });

    expect(out.files).toHaveLength(1);
    expect(out.failed).toHaveLength(1);
    expect(out.failed?.[0]?.url).toBe("https://example.com/no.pdf");
  });

  test("when nothing arrives the tool reports the reason, not an empty success", async () => {
    refuse("https://example.com/no.pdf", "HTTP 404", "DOWNLOAD_FAILED");
    const out = await run({ urls: ["https://example.com/no.pdf"] });
    expect(out.files).toBeUndefined();
    expect(out.error).toContain("404");
    expect(out.code).toBe("DOWNLOAD_FAILED");
  });

  test("a blocked target keeps its own code, so the model can tell why", async () => {
    refuse(
      "https://169.254.169.254/latest/meta-data",
      "Blocked target",
      "WEB_FETCH_BLOCKED_TARGET",
    );
    const out = await run({
      urls: ["https://169.254.169.254/latest/meta-data"],
    });
    expect(out.code).toBe("WEB_FETCH_BLOCKED_TARGET");
  });

  test("the per-call byte budget accumulates across URLs", async () => {
    // Each fetch is told what the call has already spent; without that, ten
    // files at the per-file ceiling would fill a 256 MiB tmpfs.
    serve("https://example.com/a.pdf");
    serve("https://example.com/b.pdf");
    await run({
      urls: ["https://example.com/a.pdf", "https://example.com/b.pdf"],
    });
    expect(fetched[0]?.spent).toBe(0);
    expect(fetched[1]?.spent).toBe(PDF_BYTES.byteLength);
  });

  test("a failed download spends nothing", async () => {
    refuse("https://example.com/no.pdf", "HTTP 500", "DOWNLOAD_FAILED");
    serve("https://example.com/ok.pdf");
    await run({
      urls: ["https://example.com/no.pdf", "https://example.com/ok.pdf"],
    });
    expect(fetched[1]?.spent).toBe(0);
  });
});
