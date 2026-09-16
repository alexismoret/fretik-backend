import { beforeAll, describe, expect, test } from "bun:test";
import type { ToolApprovalOperation } from "../../src/db/schema/approvals";
import { computeLookupHash } from "../../src/external-apps/hash";
import type { ProviderManifest } from "../../src/external-apps/manifest-schema";
import { setProviders } from "../../src/external-apps/registry";

/**
 * What the plan's `lookupHash` does and does not discriminate on.
 *
 * The hash is the gate's cache key: two plans that hash alike are ONE
 * operation, and the second is answered from the first's stored result
 * without executing. So every field the hash ignores is a field two
 * different writes may silently share.
 *
 * `content_base64` was `excludeFromHash` until 2026-09-16, to stop a
 * regenerated file with a timestamp inside it from re-prompting. The cost
 * turned out to be worse than the benefit: an agent that re-sent the same
 * paths with CORRECTED bytes was told `ok` and nothing ran, leaving the old
 * file on the partner's server. `hashAsDigest` keeps the no-re-prompt
 * property and drops the collision.
 *
 * A synthetic provider rather than the real one: `@fretik/shared` must not
 * import `@fretik/providers`, and the behaviour under test is the flag, not
 * any particular manifest.
 */

const manifest: ProviderManifest = {
  key: "hash-fixture",
  displayName: "Hash fixture",
  description: "Synthetic provider exercising the lookup-hash flags.",
  nangoProviderConfigKey: "hash-fixture",
  icon: "i-lucide-flask-conical",
  transport: { kind: "custom-handler" },
  scopes: [],
  categories: ["storage"],
  types: {},
  actions: [
    {
      name: "upload",
      kind: "write",
      summary: "Upload a file",
      handler: "upload",
      params: {
        remote_path: { type: "string" },
        content_base64: { type: "string", hashAsDigest: true },
        note: { type: "string", optional: true, excludeFromHash: true },
      },
      returns: { void: true },
    },
  ],
};

beforeAll(() => {
  setProviders({
    "hash-fixture": {
      manifest,
      handlers: { upload: async () => ({}) },
      summaries: { upload: () => ({ titleKey: "default", fields: [] }) },
    },
  });
});

const plan = (args: Record<string, unknown>): ToolApprovalOperation[] => [
  { action: "hash-fixture.upload", args },
];

describe("computeLookupHash", () => {
  test("different bytes to the same path are different plans", () => {
    // The 2026-09-16 bug. With `excludeFromHash` these two hashed alike and
    // the second was replayed from the first's consumed row.
    const a = computeLookupHash(
      plan({ remote_path: "out/o.csv", content_base64: "YQ==" }),
    );
    const b = computeLookupHash(
      plan({ remote_path: "out/o.csv", content_base64: "Yg==" }),
    );
    expect(a).not.toBe(b);
  });

  test("a byte-identical re-send still matches its grant", () => {
    // The property `excludeFromHash` was there for: re-running the same code
    // must find the same approval instead of asking the user twice.
    const args = { remote_path: "out/o.csv", content_base64: "YQ==" };
    expect(computeLookupHash(plan(args))).toBe(
      computeLookupHash(plan({ ...args })),
    );
  });

  test("the digest does not leak the payload into the key", () => {
    const hash = computeLookupHash(
      plan({ remote_path: "out/o.csv", content_base64: "YQ==" }),
    );
    expect(hash).not.toContain("YQ==");
  });

  test("a different path is still a different plan", () => {
    const a = computeLookupHash(
      plan({ remote_path: "out/a.csv", content_base64: "YQ==" }),
    );
    const b = computeLookupHash(
      plan({ remote_path: "out/b.csv", content_base64: "YQ==" }),
    );
    expect(a).not.toBe(b);
  });

  test("an excludeFromHash field is still ignored", () => {
    const a = computeLookupHash(
      plan({ remote_path: "out/o.csv", content_base64: "YQ==", note: "one" }),
    );
    const b = computeLookupHash(
      plan({ remote_path: "out/o.csv", content_base64: "YQ==", note: "two" }),
    );
    expect(a).toBe(b);
  });

  test("operation order is part of the hash", () => {
    const one = plan({ remote_path: "a", content_base64: "YQ==" })[0];
    const two = plan({ remote_path: "b", content_base64: "Yg==" })[0];
    if (one === undefined || two === undefined) throw new Error("bad fixture");
    expect(computeLookupHash([one, two])).not.toBe(
      computeLookupHash([two, one]),
    );
  });
});
