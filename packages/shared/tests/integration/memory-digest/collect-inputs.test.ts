import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import db from "../../../src/db";
import { aiEpisodes, aiMemories } from "../../../src/db/schema";
import { DOCUMENT_COLLECTION_KEY } from "../../../src/services/collections/constants";
import { collectDigestInputs } from "../../../src/services/memory-digest/collect-inputs";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * What is allowed into the team digest.
 *
 * Integration because every claim here IS a `WHERE` clause, and the rule that
 * sorts this file is the house one: if an assertion still holds after the
 * predicate is deleted, it is not testing the query. Each test below therefore
 * seeds a row that DOES match everything except the clause under test, so the
 * clause is the only thing that can keep it out.
 *
 * The privacy pair is the reason this file exists at all. A digest is injected
 * into every turn of every member, so a user-scoped memory or episode that
 * leaks in here is read by teammates who were never meant to see it — and once
 * it has been through the generator it is prose, indistinguishable from a
 * shared fact. Nothing downstream can catch that.
 */

let ws: WorkspaceFixture;

const seedMemory = async (values: {
  path: string;
  content: string;
  scope: "team" | "user";
  userId?: string;
}): Promise<void> => {
  await db.insert(aiMemories).values({
    organizationId: ws.organizationId,
    teamId: ws.teamId,
    scope: values.scope,
    userId: values.userId ?? null,
    path: values.path,
    content: values.content,
    sizeBytes: Buffer.byteLength(values.content, "utf8"),
    createdByActor: "human",
    lastModifiedByActor: "human",
  });
};

const seedEpisode = async (values: {
  title: string;
  summary: string;
  kind: "conversation" | "record_activity" | "consolidated";
  userId?: string;
  occurredTo?: Date;
  state?: "active" | "demoted" | "superseded";
}): Promise<void> => {
  await db.insert(aiEpisodes).values({
    organizationId: ws.organizationId,
    teamId: ws.teamId,
    userId: values.userId ?? null,
    kind: values.kind,
    state: values.state ?? "active",
    title: values.title,
    summary: values.summary,
    occurredTo: values.occurredTo ?? new Date(),
    contentHash: `${values.title}:${values.summary}`,
  });
};

const daysAgo = (days: number): Date =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  ws = await createWorkspaceFixture();
});

afterAll(async () => {
  await ws.cleanup();
});

describe("memories reaching the digest", () => {
  test("a TEAM memory is collected and a USER memory is not", async () => {
    await seedMemory({
      path: "team-rule.md",
      content: "the team rule",
      scope: "team",
    });
    await seedMemory({
      path: "private-rule.md",
      content: "the private rule",
      scope: "user",
      userId: ws.userIds[0],
    });

    const inputs = await collectDigestInputs({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
    });
    const paths = inputs.conventions.map((c) => c.path);

    // Both rows are in the same team and organization, written the same
    // second; only the scope separates them.
    //
    // Verified by mutation, and the result is worth recording: deleting
    // `user_id IS NULL` from this query does NOT turn this test red, because
    // `scope = 'team'` already excludes user memories — `ai_memories` carries a
    // CHECK making `user_id` non-null exactly when `scope = 'user'`. So on THIS
    // table the user predicate is redundant defence, and `scope` is what does
    // the work. The predicate that is genuinely load-bearing lives on episodes,
    // which have no scope column; the episode test below goes red when it is
    // removed.
    expect(paths).toContain("team-rule.md");
    expect(paths).not.toContain("private-rule.md");
  });

  test("`learned/` memories are ordered ahead of hand-written ones", async () => {
    // Seeded LAST so recency would put it last if the ordering were by date
    // alone — which is what makes this test about the `learned/` clause.
    await seedMemory({
      path: "learned/how-we-work.md",
      content: "inferred from how the team works",
      scope: "team",
    });

    const inputs = await collectDigestInputs({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
    });
    expect(inputs.conventions[0]?.path).toBe("learned/how-we-work.md");
  });
});

describe("episodes reaching the digest", () => {
  test("a team-visible decision is collected, a private one is not", async () => {
    await seedEpisode({
      kind: "conversation",
      title: "team decision",
      summary: "we agreed on the thing",
    });
    await seedEpisode({
      kind: "conversation",
      title: "private decision",
      summary: "one member's own conversation",
      userId: ws.userIds[1],
    });

    const inputs = await collectDigestInputs({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
    });
    // This is the assertion the privacy boundary actually rests on. Episodes
    // have no `scope` column, so `user_id IS NULL` is the only thing keeping a
    // member's private conversation out of every teammate's prompt — verified
    // by deleting it, which turns exactly this test red.
    const titles = inputs.decisions.map((d) => d.title);
    expect(titles).toContain("team decision");
    expect(titles).not.toContain("private decision");
  });

  test("a superseded episode is not collected", async () => {
    // Same kind, same scope, same recency as the one above — `state` is the
    // only difference, and it is what keeps a contradicted decision out.
    await seedEpisode({
      kind: "conversation",
      title: "outdated decision",
      summary: "replaced by a later one",
      state: "superseded",
    });

    const inputs = await collectDigestInputs({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
    });
    expect(inputs.decisions.map((d) => d.title)).not.toContain(
      "outdated decision",
    );
  });

  test("a decision outside the window is not collected", async () => {
    await seedEpisode({
      kind: "conversation",
      title: "ancient decision",
      summary: "from another quarter",
      occurredTo: daysAgo(120),
    });

    const inputs = await collectDigestInputs({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
    });
    expect(inputs.decisions.map((d) => d.title)).not.toContain(
      "ancient decision",
    );
  });

  test("record activity lands in threads, not in decisions", async () => {
    await seedEpisode({
      kind: "record_activity",
      title: "an open thread",
      summary: "something still moving",
    });

    const inputs = await collectDigestInputs({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
    });
    expect(inputs.threads.map((t) => t.title)).toContain("an open thread");
    expect(inputs.decisions.map((d) => d.title)).not.toContain(
      "an open thread",
    );
  });
});

describe("entities reaching the digest", () => {
  test("a linked record is collected and its document mirror is not", async () => {
    const people = await ws.createCollection({ key: `people_${Date.now()}` });
    const docs = await ws.createCollection({ key: DOCUMENT_COLLECTION_KEY });

    const person = await ws.createRecord({
      collectionId: people.id,
      label: "Acme Corp",
    });
    const other = await ws.createRecord({
      collectionId: people.id,
      label: "Globex",
    });
    const mirror = await ws.createRecord({
      collectionId: docs.id,
      label: "contract.pdf",
    });

    const linkType = await ws.createLinkType({
      key: "supplies",
      fromCollectionId: people.id,
    });
    await ws.createLink({
      linkTypeId: linkType.id,
      fromRecordId: person.id,
      toRecordId: other.id,
    });
    // The mirror gets MORE links than the entity — the exact situation that put
    // filenames in every slot on real data, and the one this predicate exists
    // for. Without the `key <> document_record` clause it outranks Acme Corp.
    await ws.createLink({
      linkTypeId: linkType.id,
      fromRecordId: mirror.id,
      toRecordId: person.id,
    });
    await ws.createLink({
      linkTypeId: linkType.id,
      fromRecordId: mirror.id,
      toRecordId: other.id,
    });

    const inputs = await collectDigestInputs({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
    });
    const labels = inputs.entities.map((e) => e.label);
    expect(labels).toContain("Acme Corp");
    expect(labels).not.toContain("contract.pdf");
  });

  test("two link types sharing a label render one line", async () => {
    // How the duplicate actually arises, which is NOT two identical edges —
    // `links_active_uniq` already forbids those. A link type's KEY is unique,
    // its LABEL is not, so two types can render the same words. Observed on
    // real data as "Clients → FLECHARD SAS" twice on one entity, which spends
    // a third of its three-line budget saying one thing.
    const orgs = await ws.createCollection({ key: `orgs_${Date.now()}` });
    const a = await ws.createRecord({ collectionId: orgs.id, label: "Alpha" });
    const b = await ws.createRecord({ collectionId: orgs.id, label: "Beta" });
    const first = await ws.createLinkType({
      key: "clients",
      fromCollectionId: orgs.id,
      label: "Clients",
    });
    const second = await ws.createLinkType({
      key: "clients_legacy",
      fromCollectionId: orgs.id,
      label: "Clients",
    });
    await ws.createLink({
      linkTypeId: first.id,
      fromRecordId: a.id,
      toRecordId: b.id,
    });
    await ws.createLink({
      linkTypeId: second.id,
      fromRecordId: a.id,
      toRecordId: b.id,
    });

    const inputs = await collectDigestInputs({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
    });
    const alpha = inputs.entities.find((e) => e.label === "Alpha");
    expect(alpha).toBeDefined();
    // Two identical edges would otherwise spend a third of this entity's
    // three-line budget saying the same thing twice.
    expect(new Set(alpha?.links ?? []).size).toBe((alpha?.links ?? []).length);
  });

  test("an inbound edge renders as inbound, not as its own inverse", async () => {
    // The defect this exists for, caught on the first real digest: one edge
    // "Nordwind supplies Horizon" was rendered identically on BOTH endpoints,
    // so Horizon's line read "supplies → Nordwind" and the model wrote "Horizon
    // supplies Nordwind" — a false statement, in a section served on every
    // turn, carrying a marker that resolves and so passes every gate after it.
    const orgs = await ws.createCollection({ key: `dir_${Date.now()}` });
    const supplier = await ws.createRecord({
      collectionId: orgs.id,
      label: "Vendor A",
    });
    const project = await ws.createRecord({
      collectionId: orgs.id,
      label: "Project B",
    });
    const supplies = await ws.createLinkType({
      key: `supplies_${Date.now()}`,
      fromCollectionId: orgs.id,
      label: "supplies",
    });
    await ws.createLink({
      linkTypeId: supplies.id,
      fromRecordId: supplier.id,
      toRecordId: project.id,
    });

    const inputs = await collectDigestInputs({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
    });
    const subject = inputs.entities.find((e) => e.label === "Vendor A");
    const object = inputs.entities.find((e) => e.label === "Project B");
    expect(subject?.links).toEqual(["supplies → Project B"]);
    expect(object?.links).toEqual(["supplies ← Vendor A"]);
  });

  test("an inbound edge uses the inverse label when the type has one", async () => {
    // With an inverse label the relation already reads in the right direction,
    // so it keeps the forward arrow rather than stacking two negations.
    const orgs = await ws.createCollection({ key: `inv_${Date.now()}` });
    const supplier = await ws.createRecord({
      collectionId: orgs.id,
      label: "Vendor C",
    });
    const project = await ws.createRecord({
      collectionId: orgs.id,
      label: "Project D",
    });
    const supplies = await ws.createLinkType({
      key: `supplies_inv_${Date.now()}`,
      fromCollectionId: orgs.id,
      label: "supplies",
      inverseLabel: "supplied by",
    });
    await ws.createLink({
      linkTypeId: supplies.id,
      fromRecordId: supplier.id,
      toRecordId: project.id,
    });

    const inputs = await collectDigestInputs({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
    });
    const object = inputs.entities.find((e) => e.label === "Project D");
    expect(object?.links).toEqual(["supplied by → Vendor C"]);
  });
});

describe("the fingerprint", () => {
  test("is stable when nothing changed", async () => {
    const scope = { organizationId: ws.organizationId, teamId: ws.teamId };
    const a = await collectDigestInputs(scope);
    const b = await collectDigestInputs(scope);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  test("changes when an input's content changes", async () => {
    const scope = { organizationId: ws.organizationId, teamId: ws.teamId };
    // Seeds its own row rather than reusing another test's: bun randomises
    // order within a file, so a test that depends on an earlier one fails for
    // a reason unrelated to what it claims.
    const path = `fingerprint-${Date.now()}.md`;
    await seedMemory({ path, content: "first wording", scope: "team" });
    const before = await collectDigestInputs(scope);

    // `updated_at` is what the fingerprint reads, and `$onUpdateFn` stamps it
    // on any `.set()` — so an edit that changes no row COUNT still has to
    // change the hash, or the generator skips a team that did change.
    const updated = await db
      .update(aiMemories)
      .set({ content: "second wording" })
      .where(
        sql`${aiMemories.teamId} = ${ws.teamId}
                 AND ${aiMemories.path} = ${path}`,
      )
      .returning({ id: aiMemories.id });
    expect(updated).toHaveLength(1);

    const after = await collectDigestInputs(scope);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});
