import { beforeAll, describe, expect, test } from "bun:test";
import type { ToolApprovalOperation } from "../../src/db/schema/approvals";
import type { ProviderManifest } from "../../src/external-apps/manifest-schema";
import { purgeExecutedPayloads } from "../../src/external-apps/purge-payloads";
import { setProviders } from "../../src/external-apps/registry";

/**
 * What survives on an approval row once the plan has run.
 *
 * `operations` keeps the executable args forever — approvals have no
 * `expires_at`, there is no retention worker, and the column is serialised
 * to the browser on every fetch. An upload therefore parks up to ~27 MB of
 * base64 in Postgres permanently. After execution those bytes are evidence,
 * not input, and a digest is evidence enough.
 *
 * The line this draws is the point of the test: `hashAsDigest` payload goes,
 * `excludeFromHash` prose STAYS — a message body is small and is the only
 * record of what a customer was actually sent.
 */

const manifest: ProviderManifest = {
  key: "purge-fixture",
  displayName: "Purge fixture",
  description: "Synthetic provider exercising payload purging.",
  nangoProviderConfigKey: "purge-fixture",
  icon: "i-lucide-flask-conical",
  transport: { kind: "custom-handler" },
  scopes: [],
  categories: ["storage"],
  types: {},
  actions: [
    {
      name: "upload",
      kind: "write",
      summary: "Upload files",
      handler: "upload",
      params: {
        files: {
          type: "array",
          items: {
            type: "object",
            fields: {
              remote_path: { type: "string" },
              content_base64: { type: "string", hashAsDigest: true },
            },
          },
        },
        on_conflict: { type: "string", optional: true },
      },
      returns: { void: true },
    },
    {
      name: "send",
      kind: "write",
      summary: "Send a message",
      handler: "send",
      params: {
        to: { type: "string" },
        body: { type: "string", excludeFromHash: true },
      },
      returns: { void: true },
    },
  ],
};

beforeAll(() => {
  setProviders({
    "purge-fixture": {
      manifest,
      handlers: { upload: async () => ({}), send: async () => ({}) },
      summaries: {
        upload: () => ({ titleKey: "default", fields: [] }),
        send: () => ({ titleKey: "default", fields: [] }),
      },
    },
  });
});

/** "hello" — 5 bytes, 8 base64 characters with one pad. */
const HELLO = "aGVsbG8=";

const uploadOp = (...payloads: string[]): ToolApprovalOperation => ({
  action: "purge-fixture.upload",
  args: {
    files: payloads.map((content_base64, i) => ({
      remote_path: `out/f${i.toString()}.csv`,
      content_base64,
    })),
    on_conflict: "replace",
  },
});

const firstFile = (
  ops: ToolApprovalOperation[] | null,
): Record<string, unknown> => {
  const files = ops?.[0]?.args.files;
  if (!Array.isArray(files)) throw new Error("expected a files array");
  const file: unknown = files[0];
  if (typeof file !== "object" || file === null) {
    throw new Error("expected a file object");
  }
  return { ...file };
};

describe("purgeExecutedPayloads", () => {
  test("replaces the bytes with their size and digest", () => {
    const file = firstFile(purgeExecutedPayloads([uploadOp(HELLO)]));
    expect(file.content_base64).toEqual({
      bytes: 5,
      sha256: expect.any(String),
    });
  });

  test("keeps everything the payload was attached to", () => {
    const purgedOps = purgeExecutedPayloads([uploadOp(HELLO)]);
    expect(firstFile(purgedOps).remote_path).toBe("out/f0.csv");
    expect(purgedOps?.[0]?.args.on_conflict).toBe("replace");
  });

  test("a 0-byte payload is reported as 0 bytes, not dropped", () => {
    const file = firstFile(purgeExecutedPayloads([uploadOp("")]));
    expect(file.content_base64).toEqual({
      bytes: 0,
      sha256: expect.any(String),
    });
  });

  test("different payloads keep different digests", () => {
    const a = firstFile(purgeExecutedPayloads([uploadOp(HELLO)]));
    const b = firstFile(purgeExecutedPayloads([uploadOp("Yg==")]));
    expect(a.content_base64).not.toEqual(b.content_base64);
  });

  test("an excludeFromHash body is left intact", () => {
    // Small, and the only record of what the customer received.
    const purgedOps = purgeExecutedPayloads([
      {
        action: "purge-fixture.send",
        args: { to: "a@b.c", body: "Your order shipped." },
      },
    ]);
    expect(purgedOps).toBeNull();
  });

  test("a plan with nothing purgeable reports no change", () => {
    // So the caller skips an UPDATE that would rewrite a column with itself.
    expect(
      purgeExecutedPayloads([
        { action: "purge-fixture.send", args: { to: "a@b.c", body: "hi" } },
      ]),
    ).toBeNull();
  });

  test("an unknown (MCP-sourced) action is left alone", () => {
    const op: ToolApprovalOperation = {
      action: "some-mcp.tool",
      args: { blob: "AAAA" },
    };
    expect(purgeExecutedPayloads([op])).toBeNull();
  });
});
