import { beforeEach, describe, expect, mock, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
// `schemas/ontology` reaches `common/params`, which calls `.openapi()` — the
// method only exists once `@hono/zod-openapi` has patched Zod. In a service
// that happens at boot; here it has to be imported for the side effect.
import "@hono/zod-openapi";
import type {
  PageCompiled,
  PageDefinition,
  PageRuntimeError,
} from "../../src/schemas/pages";

/**
 * Publishing, public access, and the dry run.
 *
 * Two things are pinned here. First the publish contract: what gets FROZEN
 * (the definition, compiled code included) versus what stays live (the data),
 * that a re-publish keeps the token so a shared link never breaks, and that
 * unpublishing clears the token so a revoked link is indistinguishable from
 * one that never existed.
 *
 * Second, `dryRunPage`'s output is CHARACTERISED rather than specified — these
 * assertions exist to make the next refactor's diff readable, so they record
 * what it does today, including that it sanitizes the definition itself.
 *
 * The db and redis are mocked at module level; the dynamic imports resolve
 * after, and `updates` reads back exactly what was written.
 */

interface FakePage {
  id: string;
  teamId: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  userId: string | null;
  definition: PageDefinition;
  publishedDefinition: PageDefinition | null;
  runtimeErrors: PageRuntimeError[];
  publicToken: string | null;
  publishedAt: Date | null;
  publishedByUserId: string | null;
  sourceConversationId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const compiled = (): PageCompiled => ({
  js: 'import { mountPage } from "#fretik/sdk";',
  css: ".p-4{padding:1rem}",
  runtimeVersion: "v1",
  sourceHash: "a".repeat(64),
  compiledAt: "2026-01-01T00:00:00.000Z",
});

/** A publishable page: real source AND a stored compile. */
const readyDefinition = (text = "Hello"): PageDefinition => ({
  version: 3,
  variables: [],
  datasets: [],
  operations: [],
  code: {
    source: `<template><h1>${text}</h1></template>`,
    compiled: compiled(),
  },
});

const fakePage = (overrides: Partial<FakePage> = {}): FakePage => ({
  id: "page-1",
  teamId: "team-1",
  name: "Sales",
  description: null,
  icon: null,
  color: null,
  userId: null,
  definition: readyDefinition(),
  publishedDefinition: null,
  runtimeErrors: [],
  publicToken: null,
  publishedAt: null,
  publishedByUserId: null,
  sourceConversationId: null,
  createdByUserId: "user-1",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...overrides,
});

/** The single row the mocked db holds; undefined means "no such page". */
let storedPage: FakePage | undefined;
/** Every `set()` payload that reached the update builder. */
const updates: Record<string, unknown>[] = [];
/** Cache prefixes dropped through `deleteKeysByPrefix`. */
const cacheDrops: string[] = [];

void mock.module("../../src/db", () => ({
  default: {
    query: {
      pages: {
        findFirst: (args: {
          where?: { id?: string; publicToken?: string };
        }) => {
          if (!storedPage) return Promise.resolve(undefined);
          const where = args.where ?? {};
          if (where.id !== undefined && where.id !== storedPage.id) {
            return Promise.resolve(undefined);
          }
          if (
            where.publicToken !== undefined &&
            where.publicToken !== storedPage.publicToken
          ) {
            return Promise.resolve(undefined);
          }
          return Promise.resolve(storedPage);
        },
      },
      collections: {
        findFirst: () => Promise.resolve(undefined),
        findMany: () => Promise.resolve([]),
      },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        if (storedPage) storedPage = { ...storedPage, ...values };
        return {
          where: () => ({
            returning: () => Promise.resolve(storedPage ? [storedPage] : []),
          }),
        };
      },
    }),
  },
}));

// `redis.ts` opens its connection at module load, so it is replaced whole —
// which means every export it has must be present here, not just the one under
// test. `selectOrCache` degrades to a straight call: no cache, no staleness.
void mock.module("../../src/lib/redis", () => ({
  redis: {},
  selectOrCache: <T>(fn: () => Promise<T>) => fn(),
  deleteKeysByPrefix: (prefix: string) => {
    cacheDrops.push(prefix);
    return Promise.resolve();
  },
}));

const { publishPage, unpublishPage } =
  await import("../../src/services/pages/publish");
const { resolvePageAccess } =
  await import("../../src/services/pages/resolve-page-access");
const { dryRunPage } = await import("../../src/services/pages/dry-run");
const { pageOwnerWriteError, pageVisibilityWhere } =
  await import("../../src/services/pages/visibility");

beforeEach(() => {
  updates.length = 0;
  cacheDrops.length = 0;
  storedPage = fakePage();
  process.env.APP_URL = "https://app.example.com";
});

describe("publishPage — frozen definition, live data", () => {
  test("snapshots the current definition and mints a token", async () => {
    const page = await publishPage({
      pageId: "page-1",
      teamId: "team-1",
      publishedByUserId: "user-1",
    });

    const written = updates[0];
    expect(written?.publishedDefinition).toEqual(storedPage?.definition);
    expect(typeof written?.publicToken).toBe("string");
    expect(written?.publishedByUserId).toBe("user-1");
    expect(page.publicUrl).toBe(
      `https://app.example.com/p/${String(written?.publicToken)}`,
    );
  });

  test("re-publishing keeps the token so a shared link never breaks", async () => {
    storedPage = fakePage({ publicToken: "token-abc" });
    await publishPage({
      pageId: "page-1",
      teamId: "team-1",
      publishedByUserId: "user-1",
    });
    expect(updates[0]?.publicToken).toBe("token-abc");
  });

  test("a later edit does not reach the published snapshot", async () => {
    storedPage = fakePage({ publicToken: "token-abc" });
    await publishPage({
      pageId: "page-1",
      teamId: "team-1",
      publishedByUserId: "user-1",
    });
    const frozen = updates[0]?.publishedDefinition;

    // The working definition moves on; the snapshot must not follow.
    storedPage = {
      ...fakePage({ publicToken: "token-abc" }),
      definition: readyDefinition("Edited"),
    };

    expect(JSON.stringify(frozen)).toContain("Hello");
    expect(JSON.stringify(frozen)).not.toContain("Edited");
  });

  test("a page with no code is refused, and its message names the fault", async () => {
    storedPage = fakePage({
      definition: {
        version: 3,
        variables: [],
        datasets: [],
        operations: [],
        code: { source: "" },
      },
    });
    const failure = await publishPage({
      pageId: "page-1",
      teamId: "team-1",
      publishedByUserId: "user-1",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HTTPException);
    expect(failure instanceof HTTPException && failure.status).toBe(400);
    // The gate's own wording is what an agent has to act on — pin it here so a
    // refactor that swallows it fails loudly.
    expect(failure instanceof HTTPException && failure.message).toContain(
      "no code to publish",
    );
    expect(updates).toEqual([]);
  });

  test("code that never compiled cleanly is refused the same way", async () => {
    storedPage = fakePage({
      definition: {
        version: 3,
        variables: [],
        datasets: [],
        operations: [],
        code: { source: "<template><h1>Hello</h1></template>" },
      },
    });
    const failure = await publishPage({
      pageId: "page-1",
      teamId: "team-1",
      publishedByUserId: "user-1",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HTTPException);
    expect(failure instanceof HTTPException && failure.status).toBe(400);
    expect(failure instanceof HTTPException && failure.message).toContain(
      "never compiled",
    );
    expect(updates).toEqual([]);
  });

  test("an unknown page id is a 404, not a silent no-op", async () => {
    storedPage = undefined;
    const failure = await publishPage({
      pageId: "page-missing",
      teamId: "team-1",
      publishedByUserId: "user-1",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HTTPException);
    expect(failure instanceof HTTPException && failure.status).toBe(404);
    expect(updates).toEqual([]);
  });

  test("publishing drops the public cache so the link goes live at once", async () => {
    storedPage = fakePage({ publicToken: "token-abc" });
    await publishPage({
      pageId: "page-1",
      teamId: "team-1",
      publishedByUserId: "user-1",
    });
    expect(cacheDrops).toEqual(["page:pub:token-abc:"]);
  });
});

describe("visibility — who may see and own a page", () => {
  test("no requester means system trust: every page in the team", () => {
    expect(pageVisibilityWhere()).toEqual({});
  });

  test("an org admin sees everything, for governance", () => {
    expect(pageVisibilityWhere({ userId: "user-2", isAdmin: true })).toEqual(
      {},
    );
  });

  test("a member sees team-shared pages and their own, and no others", () => {
    expect(pageVisibilityWhere({ userId: "user-2", isAdmin: false })).toEqual({
      OR: [{ userId: { isNull: true } }, { userId: "user-2" }],
    });
  });

  test("a page may be team-shared or private to the writer, never to someone else", () => {
    expect(pageOwnerWriteError(null, "user-1")).toBeNull();
    expect(pageOwnerWriteError(undefined, "user-1")).toBeNull();
    expect(pageOwnerWriteError("user-1", "user-1")).toBeNull();
    expect(pageOwnerWriteError("user-2", "user-1")).toContain(
      "can't be scoped to another user",
    );
  });
});

describe("unpublishPage — a revoked link is indistinguishable from none", () => {
  test("clears the token and the snapshot together", async () => {
    storedPage = fakePage({
      publicToken: "token-abc",
      publishedDefinition: readyDefinition(),
      publishedAt: new Date("2026-02-01"),
      publishedByUserId: "user-1",
    });
    const page = await unpublishPage({ pageId: "page-1", teamId: "team-1" });

    expect(updates[0]).toEqual({
      publicToken: null,
      publishedDefinition: null,
      publishedAt: null,
      publishedByUserId: null,
    });
    expect(page.publicUrl).toBeNull();
    expect(cacheDrops).toEqual(["page:pub:token-abc:"]);
  });

  test("unpublishing a page that was never published still succeeds", async () => {
    await unpublishPage({ pageId: "page-1", teamId: "team-1" });
    expect(updates[0]?.publicToken).toBeNull();
    expect(cacheDrops).toEqual([]);
  });
});

describe("resolvePageAccess — the anonymous door", () => {
  test("serves the FROZEN definition, never the working one", async () => {
    storedPage = fakePage({
      publicToken: "token-abc",
      publishedDefinition: readyDefinition("Published"),
      definition: readyDefinition("Draft"),
    });

    const result = await resolvePageAccess({ token: "token-abc" });
    expect(result.access).toBe("ready");
    expect(
      result.access === "ready" ? JSON.stringify(result.definition) : "",
    ).toContain("Published");
    expect(
      result.access === "ready" ? JSON.stringify(result.definition) : "",
    ).not.toContain("Draft");
  });

  test("an unknown token is not_found", async () => {
    storedPage = fakePage({ publicToken: "token-abc" });
    expect(await resolvePageAccess({ token: "token-other" })).toEqual({
      access: "not_found",
    });
  });

  test("a page with a token but no snapshot is not_found, never a blank page", async () => {
    storedPage = fakePage({
      publicToken: "token-abc",
      publishedDefinition: null,
    });
    expect(await resolvePageAccess({ token: "token-abc" })).toEqual({
      access: "not_found",
    });
  });
});

describe("dryRunPage — characterisation of today's output", () => {
  const withDatasets = (
    datasets: PageDefinition["datasets"],
    source = "<template><div>ok</div></template>",
  ): PageDefinition => ({
    version: 3,
    variables: [],
    datasets,
    operations: [],
    code: { source },
  });

  test("reports row count and one clipped sample row", async () => {
    const long = "x".repeat(200);
    const result = await dryRunPage({
      definition: withDatasets([
        { id: "sales", kind: "inline", rows: [{ note: long, amount: 10 }] },
      ]),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });

    expect(result.samples.sales?.rowCount).toBe(1);
    const sample = result.samples.sales?.sample;
    const note =
      typeof sample === "object" && sample !== null && !Array.isArray(sample)
        ? sample.note
        : undefined;
    expect(typeof note === "string" && note.length).toBe(161);
    expect(typeof note === "string" && note.endsWith("…")).toBe(true);
  });

  test("a grouped dataset reports its distinct group values", async () => {
    const result = await dryRunPage({
      definition: withDatasets([
        {
          id: "byStage",
          kind: "inline",
          groupBy: "stage",
          rows: [
            { group: "won", n: 3 },
            { group: "lost", n: 1 },
            { group: "won", n: 2 },
          ],
        },
      ]),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });
    expect(result.samples.byStage?.groupCount).toBe(2);
    expect(result.samples.byStage?.groupValues).toEqual(["won", "lost"]);
  });

  test("an empty dataset is a warning that names the likely cause", async () => {
    const result = await dryRunPage({
      definition: withDatasets([{ id: "sales", kind: "inline", rows: [] }]),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });
    expect(result.warnings).toContain(
      'dataset "sales" returned no rows — check its filters, or the collection may be empty.',
    );
  });

  test("a failing dataset is reported with its own message", async () => {
    const result = await dryRunPage({
      definition: withDatasets([
        // No `collectionId`: the objects source refuses it by message rather
        // than throwing, which is the degradation this pins.
        { id: "broken", kind: "collections" },
      ]),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });
    expect(
      result.warnings.some((w) => w.startsWith('dataset "broken" failed:')),
    ).toBe(true);
  });

  test("an unreadable collection degrades to its own forbidden warning", async () => {
    // The mocked db knows no collections, so any objects dataset resolves
    // forbidden — one dataset's grant costs its block, not the page.
    const result = await dryRunPage({
      definition: withDatasets([
        {
          id: "records",
          kind: "collections",
          collectionId: "00000000-0000-4000-8000-000000000000",
        },
      ]),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });
    expect(result.samples.records).toEqual({
      status: "forbidden",
      rowCount: 0,
    });
    expect(result.warnings).toContain(
      'dataset "records": this team cannot read that collection.',
    );
  });

  test("empty code is a warning, not a refusal — a dry run persists nothing", async () => {
    const result = await dryRunPage({
      definition: withDatasets([], ""),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });
    expect(
      result.warnings.some((w) => w.includes("code.source is empty")),
    ).toBe(true);
  });

  test("without assumeCompiled, compile errors land in warnings", async () => {
    // No <template> is a STRUCTURAL failure — caught before the Tailwind
    // subprocess, so this stays a fast unit test of the wiring.
    const result = await dryRunPage({
      definition: withDatasets(
        [],
        '<script setup lang="ts">const a = 1</script>',
      ),
      teamId: "team-1",
      userId: null,
    });
    const found = result.warnings.find((w) => w.startsWith("code [structure]"));
    expect(found).toBeDefined();
    expect(found).toContain("<template>");
  });

  test("assumeCompiled skips the compile pass — the write just paid for it", async () => {
    const result = await dryRunPage({
      definition: withDatasets(
        [],
        '<script setup lang="ts">const a = 1</script>',
      ),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });
    expect(result.warnings.some((w) => w.startsWith("code ["))).toBe(false);
  });

  test("dryRunPage sanitizes the definition itself — its warnings include the static pass", async () => {
    const result = await dryRunPage({
      definition: withDatasets([
        {
          id: "derived",
          kind: "collections",
          mode: "aggregate",
          collectionId: "018f0000-0000-7000-8000-000000000000",
          metrics: [{ name: "spend", fn: "sum" }],
        },
      ]),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });
    expect(
      result.warnings.some(
        (w) => w.includes('dataset "derived"') && w.includes("needs a `key`"),
      ),
    ).toBe(true);
  });

  test("assumeSanitized skips the static pass — the caller already ran it", async () => {
    const definition = withDatasets([
      {
        id: "derived",
        kind: "collections",
        mode: "aggregate",
        collectionId: "018f0000-0000-7000-8000-000000000000",
        metrics: [{ name: "spend", fn: "sum" }],
      },
    ]);
    // Same definition, both ways: the static finding is the difference.
    const fresh = await dryRunPage({
      definition,
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });
    const preSanitized = await dryRunPage({
      definition,
      teamId: "team-1",
      userId: null,
      assumeSanitized: true,
      assumeCompiled: true,
    });

    expect(fresh.warnings.some((w) => w.includes("needs a `key`"))).toBe(true);
    expect(preSanitized.warnings.some((w) => w.includes("needs a `key`"))).toBe(
      false,
    );
    // The DATA phase still runs either way — that is the half a caller cannot
    // have done for itself.
    expect(preSanitized.samples).toEqual(fresh.samples);
  });
});
