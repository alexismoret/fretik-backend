/**
 * Scope-filter integration tests for `hybridSearch` (S5).
 *
 * Validates the 3-arm scope predicate introduced in S5:
 *
 *     (team_id = $teamId OR team_id IS NULL)
 * AND (user_id IS NULL OR user_id = $userId)
 * AND (organization_id = $orgId OR organization_id IS NULL)
 *
 * Each test seeds rows with a known sourceId, runs `hybridSearch` with a
 * specific (teamId, organizationId, userId) tuple, and asserts which
 * sourceIds come back. The actual semantic ranking is irrelevant —
 * presence/absence is the contract.
 *
 * Real Postgres; the embedder is DOUBLED (`tests/lib/embeddings-double.ts`).
 * That double sums a deterministic vector per TOKEN precisely so the property
 * the seeding block below relies on — shared vocabulary scores above none —
 * survives without a network call.
 */
import db from "@fretik/shared/db";
import {
  aiVectors,
  team,
  type AiVectorMetadata,
  type AiVectorSourceType,
} from "@fretik/shared/db/schema";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { installEmbeddingDoubles } from "../../../lib/embeddings-double";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

await installEmbeddingDoubles();

const { embedBatch } = await import("../../../../src/lib/embeddings");
const { hybridSearch } =
  await import("../../../../src/services/search/hybrid-search");

interface SeedRowInput {
  sourceType: AiVectorSourceType;
  sourceId: string;
  teamId: string | null;
  organizationId: string | null;
  userId: string | null;
  content: string;
  embedding: number[];
  metadata: AiVectorMetadata;
  /** Who may find it, when not simply its team (`services/ai-vectors/acl`). */
  aclPrincipals?: string[] | null;
}

const insertSeedRow = async (input: SeedRowInput): Promise<void> => {
  await db.insert(aiVectors).values({
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    teamId: input.teamId,
    organizationId: input.organizationId,
    userId: input.userId,
    content: input.content,
    contextualPrefix: "[TEST]",
    chunkIndex: 0,
    totalChunks: 1,
    embedding: input.embedding,
    metadata: input.metadata,
    aclPrincipals: input.aclPrincipals ?? null,
  });
};

/**
 * Only the four source types this suite seeds.
 *
 * It used to take the whole `AiVectorSourceType` union and answer for five,
 * including an `extractions` kind the schema no longer has — and the document
 * case still carried the transport-era fields (`document_type`,
 * `transport_mode`, …) that left `DocumentVectorMetadata` long ago, while
 * missing the ones it gained. None of it was caught, because these files were
 * outside the typecheck. Narrowing the parameter makes the switch exhaustive
 * and a new seeded kind a compile error instead of a fall-through.
 */
type SeededSourceType = Extract<
  AiVectorSourceType,
  "context" | "documents" | "memories" | "skills"
>;

const buildMetadata = (sourceType: SeededSourceType): AiVectorMetadata => {
  switch (sourceType) {
    case "documents":
      return {
        file_name: "test.pdf",
        file_type: "application/pdf",
        page_count: 1,
        document_language: "en",
        document_summary: null,
        entities: [],
        custom_fields: {},
        scope: "team",
        path: "test.pdf",
        size_bytes: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    case "memories":
      return {
        scope: "team",
        path: "test.md",
        size_bytes: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    case "skills":
      return {
        skill_name: "test",
        skill_file: "SKILL.md",
        skill_description: "test skill",
        content_hash: "0".repeat(64),
        version_indexed_at: new Date().toISOString(),
      };
    case "context":
      return {
        scope: "team",
        filename: "test.pdf",
        mime_type: "application/pdf",
        size_bytes: 0,
        profile_id: randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
  }
};

const QUERY = "freight rates and carrier shipping information";

describe("hybridSearch scope filter (S5)", () => {
  let fx: MemoryTestFixture;
  let teamBId: string;
  let queryEmbedding: number[];

  // Each row gets its own sourceId so tests can assert by membership.
  const ids = {
    docTeamA: randomUUID(),
    docTeamB: randomUUID(),
    memoryTeamA: randomUUID(),
    memoryUserA: randomUUID(),
    memoryUserB: randomUUID(),
    skillGlobal: randomUUID(),
    contextTeamA: randomUUID(),
    contextUserA: randomUUID(),
    contextUserB: randomUUID(),
  } as const;

  beforeAll(async () => {
    fx = await createMemoryTestFixture();

    // Second team in the same org so we can verify tenant isolation
    // without leaking through `organization_id`.
    const [tb] = await db
      .insert(team)
      .values({
        name: `team-b-isolation-${randomUUID().slice(0, 8)}`,
        organizationId: fx.organizationId,
        createdAt: new Date(),
      })
      .returning({ id: team.id });
    if (!tb) throw new Error("fixture: failed to insert team B");
    teamBId = tb.id;

    const [userA, userB] = fx.userIds;

    // One batch: 1 query + 9 row contents = 10 inputs. Content texts share
    // vocabulary with the query so each row gets a meaningful semantic score
    // (presence/absence is what matters, not ranking — but completely
    // off-topic seeds risk falling out of the top-150 cut entirely). The
    // double preserves exactly that, which is why it hashes per token rather
    // than per string.
    const seedContents = [
      QUERY, // [0] — query embedding target
      "DHL freight rates spring 2026 ANR-MRS lane", // [1] doc team A
      "FedEx air freight tariffs 2026 Europe-US", // [2] doc team B
      "internal note: prefer DHL for door-to-door 48h", // [3] memory team A
      "userA preference: send carrier updates by email", // [4] memory user A
      "userB preference: notify shipment events via slack", // [5] memory user B
      "xlsx skill: generate carrier rate Excel sheets", // [6] skill global
      "team carrier directory and shipping contracts 2026", // [7] context team A
      "userA personal shipping bookmarks and templates", // [8] context user A
      "userB personal carrier preferences saved", // [9] context user B
    ];
    const vectors = await embedBatch(seedContents);
    if (vectors.length !== seedContents.length) {
      throw new Error(
        `expected ${seedContents.length} embeddings, got ${vectors.length}`,
      );
    }
    queryEmbedding = vectors[0]!;

    // Seed all 9 rows. Each line maps a (scope shape, source kind) to a
    // sourceId in `ids` for assertion. Comments next to each row map to
    // the truth-table line in the plan.
    const seeds: Array<Omit<SeedRowInput, "embedding"> & { vIdx: number }> = [
      {
        // tenant — doc team A: (A, X, NULL)
        sourceType: "documents",
        sourceId: ids.docTeamA,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        userId: null,
        content: seedContents[1]!,
        metadata: buildMetadata("documents"),
        vIdx: 1,
      },
      {
        // tenant other — doc team B: (B, X, NULL)
        sourceType: "documents",
        sourceId: ids.docTeamB,
        teamId: teamBId,
        organizationId: fx.organizationId,
        userId: null,
        content: seedContents[2]!,
        metadata: buildMetadata("documents"),
        vIdx: 2,
      },
      {
        // memory team A: (A, X, NULL)
        sourceType: "memories",
        sourceId: ids.memoryTeamA,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        userId: null,
        content: seedContents[3]!,
        metadata: buildMetadata("memories"),
        vIdx: 3,
      },
      {
        // memory user A: (A, X, A)
        sourceType: "memories",
        sourceId: ids.memoryUserA,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        userId: userA,
        content: seedContents[4]!,
        metadata: buildMetadata("memories"),
        vIdx: 4,
      },
      {
        // memory user B: (A, X, B)
        sourceType: "memories",
        sourceId: ids.memoryUserB,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        userId: userB,
        content: seedContents[5]!,
        metadata: buildMetadata("memories"),
        vIdx: 5,
      },
      {
        // skill global: (NULL, NULL, NULL)
        sourceType: "skills",
        sourceId: ids.skillGlobal,
        teamId: null,
        organizationId: null,
        userId: null,
        content: seedContents[6]!,
        metadata: buildMetadata("skills"),
        vIdx: 6,
      },
      {
        // context team A: (A, X, NULL)
        sourceType: "context",
        sourceId: ids.contextTeamA,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        userId: null,
        content: seedContents[7]!,
        metadata: buildMetadata("context"),
        vIdx: 7,
      },
      {
        // context user A: (NULL, X, A)
        sourceType: "context",
        sourceId: ids.contextUserA,
        teamId: null,
        organizationId: fx.organizationId,
        userId: userA,
        content: seedContents[8]!,
        metadata: buildMetadata("context"),
        vIdx: 8,
      },
      {
        // context user B: (NULL, X, B)
        sourceType: "context",
        sourceId: ids.contextUserB,
        teamId: null,
        organizationId: fx.organizationId,
        userId: userB,
        content: seedContents[9]!,
        metadata: buildMetadata("context"),
        vIdx: 9,
      },
    ];

    for (const seed of seeds) {
      // oxlint-disable-next-line no-await-in-loop
      await insertSeedRow({
        sourceType: seed.sourceType,
        sourceId: seed.sourceId,
        teamId: seed.teamId,
        organizationId: seed.organizationId,
        userId: seed.userId,
        content: seed.content,
        embedding: vectors[seed.vIdx]!,
        metadata: seed.metadata,
      });
    }
  }, 60_000);

  afterAll(async () => {
    // Skill rows have team_id=NULL so the org cascade in fx.cleanup()
    // doesn't reach them. Clean explicitly first.
    await db.delete(aiVectors).where(eq(aiVectors.sourceId, ids.skillGlobal));
    // Context user-scope rows are cascaded via `organization_id` FK.
    // Team-scoped rows are cascaded via `team_id` → team → org.
    // Team B + its docTeamB row also fall through the org cascade.
    await fx.cleanup();
  });

  const sourceIdsIn = (
    rows: Awaited<ReturnType<typeof hybridSearch>>,
  ): Set<string> => new Set(rows.map((r) => r.sourceId));

  test("tenant isolation: team A query never sees team B docs", async () => {
    const [userA] = fx.userIds;
    const rows = await hybridSearch({
      query: QUERY,
      queryEmbedding,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: userA,
    });
    const found = sourceIdsIn(rows);
    expect(found.has(ids.docTeamA)).toBe(true);
    expect(found.has(ids.docTeamB)).toBe(false);
  }, 60_000);

  test("user isolation: user A query never sees user B's memories", async () => {
    const [userA] = fx.userIds;
    const rows = await hybridSearch({
      query: QUERY,
      queryEmbedding,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: userA,
    });
    const found = sourceIdsIn(rows);
    expect(found.has(ids.memoryTeamA)).toBe(true);
    expect(found.has(ids.memoryUserA)).toBe(true);
    expect(found.has(ids.memoryUserB)).toBe(false);
  }, 60_000);

  test("global skills: visible to any team query", async () => {
    const [userA] = fx.userIds;
    const rows = await hybridSearch({
      query: QUERY,
      queryEmbedding,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: userA,
    });
    expect(sourceIdsIn(rows).has(ids.skillGlobal)).toBe(true);
  }, 60_000);

  test("context user-scope: cross-team but per-user (team_id NULL, org set)", async () => {
    const [userA, userB] = fx.userIds;

    // user A in team A sees their own user-scope context
    const aRows = await hybridSearch({
      query: QUERY,
      queryEmbedding,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: userA,
    });
    const aFound = sourceIdsIn(aRows);
    expect(aFound.has(ids.contextTeamA)).toBe(true);
    expect(aFound.has(ids.contextUserA)).toBe(true);
    expect(aFound.has(ids.contextUserB)).toBe(false);

    // user B in team A sees their own (different) user-scope context
    const bRows = await hybridSearch({
      query: QUERY,
      queryEmbedding,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: userB,
    });
    const bFound = sourceIdsIn(bRows);
    expect(bFound.has(ids.contextTeamA)).toBe(true);
    expect(bFound.has(ids.contextUserA)).toBe(false);
    expect(bFound.has(ids.contextUserB)).toBe(true);
  }, 60_000);

  test("filters.sourceTypes narrows the candidate pool", async () => {
    const [userA] = fx.userIds;
    const rows = await hybridSearch({
      query: QUERY,
      queryEmbedding,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: userA,
      filters: { sourceTypes: ["skills"] },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.sourceType).toBe("skills");
    }
    expect(sourceIdsIn(rows).has(ids.skillGlobal)).toBe(true);
    expect(sourceIdsIn(rows).has(ids.docTeamA)).toBe(false);
    expect(sourceIdsIn(rows).has(ids.memoryTeamA)).toBe(false);
  }, 60_000);

  test("userId undefined (system flow): user-scope rows stay invisible", async () => {
    const rows = await hybridSearch({
      query: QUERY,
      queryEmbedding,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      // no userId — collapse to team-only
    });
    const found = sourceIdsIn(rows);
    // Team / global rows still come through.
    expect(found.has(ids.docTeamA)).toBe(true);
    expect(found.has(ids.memoryTeamA)).toBe(true);
    expect(found.has(ids.contextTeamA)).toBe(true);
    expect(found.has(ids.skillGlobal)).toBe(true);
    // User-scope rows must NOT leak.
    expect(found.has(ids.memoryUserA)).toBe(false);
    expect(found.has(ids.memoryUserB)).toBe(false);
    expect(found.has(ids.contextUserA)).toBe(false);
    expect(found.has(ids.contextUserB)).toBe(false);
  }, 60_000);
});

/**
 * Rows with an audience of their own: a restricted or shared document keeps
 * `acl_principals`, and search keeps it for the searcher, their ACTIVE team
 * or the organization — whatever team the row belongs to, and never on its
 * team alone.
 */
describe("hybridSearch: rows with their own audience", () => {
  let fx: MemoryTestFixture;
  let teamBId: string;
  let queryEmbedding: number[];

  const ids = {
    restrictedToA: randomUUID(),
    sharedWithTeamB: randomUUID(),
    sharedWithOrg: randomUUID(),
    restrictedToNobody: randomUUID(),
  } as const;

  beforeAll(async () => {
    fx = await createMemoryTestFixture();
    const [tb] = await db
      .insert(team)
      .values({
        name: `team-b-acl-${randomUUID().slice(0, 8)}`,
        organizationId: fx.organizationId,
        createdAt: new Date(),
      })
      .returning({ id: team.id });
    if (!tb) throw new Error("fixture: failed to insert team B");
    teamBId = tb.id;
    const [userA] = fx.userIds;

    const contents = [
      QUERY,
      "carrier rates restricted to their owner",
      "shipping contracts shared with another team",
      "freight information shared with the whole organization",
      "carrier notes nobody can open any more",
    ];
    const vectors = await embedBatch(contents);
    queryEmbedding = vectors[0]!;

    const seeds: Array<Omit<SeedRowInput, "embedding"> & { vIdx: number }> = [
      {
        // Team A's, restricted: its owner only.
        sourceType: "documents",
        sourceId: ids.restrictedToA,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        userId: null,
        content: contents[1]!,
        metadata: buildMetadata("documents"),
        aclPrincipals: [userA],
        vIdx: 1,
      },
      {
        // Team A's, restricted, shared with team B.
        sourceType: "documents",
        sourceId: ids.sharedWithTeamB,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        userId: null,
        content: contents[2]!,
        metadata: buildMetadata("documents"),
        aclPrincipals: [userA, teamBId],
        vIdx: 2,
      },
      {
        // Team B's, open, shared with everyone.
        sourceType: "documents",
        sourceId: ids.sharedWithOrg,
        teamId: teamBId,
        organizationId: fx.organizationId,
        userId: null,
        content: contents[3]!,
        metadata: buildMetadata("documents"),
        aclPrincipals: [fx.organizationId, teamBId],
        vIdx: 3,
      },
      {
        // Restricted, with its owner gone and nothing shared.
        sourceType: "documents",
        sourceId: ids.restrictedToNobody,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        userId: null,
        content: contents[4]!,
        metadata: buildMetadata("documents"),
        aclPrincipals: [],
        vIdx: 4,
      },
    ];
    for (const seed of seeds) {
      // oxlint-disable-next-line no-await-in-loop
      await insertSeedRow({ ...seed, embedding: vectors[seed.vIdx]! });
    }
  }, 60_000);

  afterAll(async () => {
    await fx.cleanup();
  });

  const search = async (teamId: string, userId: string | undefined) =>
    new Set(
      (
        await hybridSearch({
          query: QUERY,
          queryEmbedding,
          teamId,
          organizationId: fx.organizationId,
          userId,
        })
      ).map((row) => row.sourceId),
    );

  test("the owner finds what is restricted to them", async () => {
    const [userA] = fx.userIds;
    const found = await search(fx.teamId, userA);
    expect(found.has(ids.restrictedToA)).toBe(true);
    expect(found.has(ids.sharedWithTeamB)).toBe(true);
    expect(found.has(ids.sharedWithOrg)).toBe(true);
    expect(found.has(ids.restrictedToNobody)).toBe(false);
  }, 60_000);

  test("a teammate does not find it: its team is not in its audience", async () => {
    const [, userB] = fx.userIds;
    const found = await search(fx.teamId, userB);
    expect(found.has(ids.restrictedToA)).toBe(false);
    expect(found.has(ids.sharedWithTeamB)).toBe(false);
    expect(found.has(ids.restrictedToNobody)).toBe(false);
    // Shared with everyone, from another team.
    expect(found.has(ids.sharedWithOrg)).toBe(true);
  }, 60_000);

  test("the team it is shared with finds it, working in that team", async () => {
    const [, userB] = fx.userIds;
    const found = await search(teamBId, userB);
    expect(found.has(ids.sharedWithTeamB)).toBe(true);
    expect(found.has(ids.restrictedToA)).toBe(false);
  }, 60_000);

  test("a search for nobody in particular keeps only the team's and everyone's", async () => {
    const found = await search(fx.teamId, undefined);
    expect(found.has(ids.sharedWithOrg)).toBe(true);
    expect(found.has(ids.restrictedToA)).toBe(false);
    expect(found.has(ids.sharedWithTeamB)).toBe(false);
  }, 60_000);
});

/**
 * A project chat's search: what names the project (or the searcher) as its
 * audience, and the searcher's own rows — never what is simply its team's.
 * Its reader may come from another team; the team's own knowledge is its
 * people's.
 */
describe("hybridSearch: within one project", () => {
  let fx: MemoryTestFixture;
  let queryEmbedding: number[];
  const projectId = randomUUID();
  const otherProjectId = randomUUID();

  const ids = {
    projectDoc: randomUUID(),
    projectNote: randomUUID(),
    otherProjectDoc: randomUUID(),
    teamDoc: randomUUID(),
    teamNote: randomUUID(),
    ownNote: randomUUID(),
    sharedWithReader: randomUUID(),
  } as const;

  beforeAll(async () => {
    fx = await createMemoryTestFixture();
    const [userA] = fx.userIds;
    const contents = [
      QUERY,
      "carrier rates kept in the project",
      "freight notes the project keeps for its chats",
      "shipping contracts of another project",
      "carrier directory of the whole team",
      "team convention: freight quotes need two carriers",
      "my own shipping shortcuts for carrier rates",
      "freight information shared with the reader directly",
    ];
    const vectors = await embedBatch(contents);
    queryEmbedding = vectors[0]!;

    const row = (
      sourceType: SeededSourceType,
      sourceId: string,
      vIdx: number,
      audience: { userId?: string; aclPrincipals?: string[] },
    ): Omit<SeedRowInput, "embedding"> & { vIdx: number } => ({
      sourceType,
      sourceId,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      userId: audience.userId ?? null,
      content: contents[vIdx]!,
      metadata: buildMetadata(sourceType),
      aclPrincipals: audience.aclPrincipals ?? null,
      vIdx,
    });
    const seeds = [
      row("documents", ids.projectDoc, 1, { aclPrincipals: [projectId] }),
      row("memories", ids.projectNote, 2, { aclPrincipals: [projectId] }),
      row("documents", ids.otherProjectDoc, 3, {
        aclPrincipals: [otherProjectId],
      }),
      row("documents", ids.teamDoc, 4, {}),
      row("memories", ids.teamNote, 5, {}),
      row("memories", ids.ownNote, 6, { userId: userA }),
      row("documents", ids.sharedWithReader, 7, { aclPrincipals: [userA] }),
    ];
    for (const seed of seeds) {
      // oxlint-disable-next-line no-await-in-loop
      await insertSeedRow({ ...seed, embedding: vectors[seed.vIdx]! });
    }
  }, 60_000);

  afterAll(async () => {
    await fx.cleanup();
  });

  test("finds the project's and the reader's own, nothing of the team's", async () => {
    const [userA] = fx.userIds;
    const found = new Set(
      (
        await hybridSearch({
          query: QUERY,
          queryEmbedding,
          teamId: fx.teamId,
          organizationId: fx.organizationId,
          userId: userA,
          withinProject: projectId,
        })
      ).map((row) => row.sourceId),
    );
    expect(found.has(ids.projectDoc)).toBe(true);
    expect(found.has(ids.projectNote)).toBe(true);
    expect(found.has(ids.ownNote)).toBe(true);
    expect(found.has(ids.sharedWithReader)).toBe(true);
    expect(found.has(ids.teamDoc)).toBe(false);
    expect(found.has(ids.teamNote)).toBe(false);
    expect(found.has(ids.otherProjectDoc)).toBe(false);
  }, 60_000);

  test("from the team, a project's people find it beside the team's", async () => {
    const [userA] = fx.userIds;
    const found = new Set(
      (
        await hybridSearch({
          query: QUERY,
          queryEmbedding,
          teamId: fx.teamId,
          organizationId: fx.organizationId,
          userId: userA,
          projectIds: [projectId],
        })
      ).map((row) => row.sourceId),
    );
    expect(found.has(ids.projectDoc)).toBe(true);
    expect(found.has(ids.projectNote)).toBe(true);
    expect(found.has(ids.teamDoc)).toBe(true);
    expect(found.has(ids.teamNote)).toBe(true);
    expect(found.has(ids.otherProjectDoc)).toBe(false);
  }, 60_000);
});
