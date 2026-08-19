// Patches Zod with `.openapi()`. Side-effect import, and it MUST precede every
// `@fretik/*` import below: this file now reaches `schemas/pages` at runtime
// (definition parsing, dry-run), and any shared module that pulls
// `schemas/common/params` calls `.openapi()` at module load. The API/AI service
// registers the patch in its own entry point; the eval runner has no entry that
// does, so it is registered here — and the blank line under it is what keeps
// the formatter's import sorter from moving it below `@fretik` (see
// `src/index.ts` for the same enforced ordering).
// oxlint-disable-next-line import/no-duplicates
import "@hono/zod-openapi";

import db from "@fretik/shared/db";
import { pages } from "@fretik/shared/db/schema";
import {
  PageDefinitionSchema,
  type PageDefinition,
} from "@fretik/shared/schemas/pages";
import { createFieldDefinition } from "@fretik/shared/services/field-definitions/create";
import { getFieldDefinitionsForTeam } from "@fretik/shared/services/field-definitions/get-for-team";
import { createLinkType } from "@fretik/shared/services/link-types/create";
import { createLink } from "@fretik/shared/services/links/create";
import { createObjectRecord } from "@fretik/shared/services/object-records/create";
import { queryObjectRecords } from "@fretik/shared/services/object-records/query";
import { reconcileObjectTable } from "@fretik/shared/services/object-schema/table";
import { createObjectType } from "@fretik/shared/services/object-types/create";
import { deleteObjectType } from "@fretik/shared/services/object-types/delete";
import {
  invalidateObjectTypeIdCache,
  resolveObjectTypeId,
} from "@fretik/shared/services/object-types/resolve";
import {
  dryRunPage,
  type PageDryRun,
} from "@fretik/shared/services/pages/dry-run";
import { and, eq, lt } from "drizzle-orm";
import { readPageReviewIterations } from "../../src/services/page-review/page-session-store";
import { judgePage } from "../page-design-judge";
import {
  designScoreAtLeast,
  gatePasses,
  type PageJudgement,
} from "../page-judgement";
import type {
  EvalCase,
  EvalCaseContext,
  EvalSuite,
  InvokeResult,
} from "../types";
import {
  collectDatasets,
  collectNodes,
  collectOperations,
  definitionText,
  nodeTypes,
  pageSource,
} from "./page-definition-readers";
import {
  ITEM_ROW_COUNT,
  OWNERS,
  PRIORITIES,
  STATUSES,
  TEAMS,
  itemRows,
} from "./page-fixture-rows";

/**
 * Pages generation suite — the quality gate the `managePage` tool never had.
 *
 * The pages feature ships a wide authoring surface (a complete Vue SFC over
 * declared datasets, variables and operations) and was verified only by
 * dry-run + browser inspection: no eval ever measured whether the AGENT
 * writes good pages with it. That gap is the reason this file exists, and it
 * is deliberately written to OUTLIVE format migrations: every assertion reads
 * the stored page through the shape-blind readers in
 * `page-definition-readers.ts` (v1 nested tree, v2 flat spec, v3 code), so
 * the same suite scores a format before and after a migration and the
 * migration has a real acceptance criterion (≥ baseline) instead of a vibe.
 * On a code page, structure probes read the SFC source — component tags,
 * class idioms, bridge calls — and data probes read the declared datasets.
 *
 * What it grades:
 *   - the STORED page (not the chat reply) — structure, datasets, wiring;
 *   - the `warnings` a dry-run raises on that stored definition, which is the
 *     system's own verdict on it (zero is the bar — a warning means the agent
 *     shipped a page it never saw resolve);
 *   - what the page DOES when rendered in a browser — the mechanical gate and
 *     a design score, on every case that builds one (`page-design-judge.ts`);
 *   - the SHAPE the request called for, on the three cases that ask for
 *     something other than a dashboard;
 *   - the two negatives that matter — don't build a page for a one-off
 *     question, don't publish without being asked.
 *
 * Ten cases, seven of which build. Properties that hold of ANY built page —
 * nothing published, the review loop ran, the field keys are real — are
 * ASSERTIONS on a case that builds anyway, never cases of their own: a case
 * costs four to seven minutes, and that is a lot to pay for one boolean.
 *
 * Seeds its own throwaway object type with a deterministic record set so group
 * counts, sums and date buckets are knowable. The pages a run builds are KEPT
 * (see `PAGE_RETENTION_MS`) — they are the evidence — and the previous run's
 * are swept. Not smoke (needs the seed).
 */

// ── Seeded fixture ──────────────────────────────────────────────────────────

/**
 * Two linked object types, deliberately dull and cross-industry: work items and
 * the people who own them.
 *
 * It replaced a single "deal" type, for two measured reasons. Every seeded case
 * asked about deals, so ten generated pages in a row were sales dashboards and
 * the suite could not tell a generalist page builder from a dashboard
 * generator. And the old fixture exercised almost nothing of the field system:
 * no relation, no icons on options, no status semantics — while
 * `services/pages/field-descriptors.ts` calls exactly that "the single biggest
 * lever on how a generated page LOOKS", because a `select` with a colour and an
 * icon renders as a badge for free and a page that ignores it prints grey text.
 *
 * So the fixture now offers, on purpose: a colour-and-icon status with kanban
 * groups, a priority, a number, a date, money, and a RELATION to a second type
 * carrying its own category. No eval covered a relation before this one.
 */

const ITEM_KEY = "eval_page_item";
const ITEM_LABEL = "Eval Work Item";
const OWNER_KEY = "eval_page_owner";
const OWNER_LABEL = "Eval Owner";
const OWNER_LINK_KEY = "eval_page_item_owner";
/** The `relation` FIELD on the item — what makes the link readable from a page. */
const OWNER_FIELD_KEY = "owner";

/**
 * The rows and their option sets live in `page-fixture-rows.ts` — pure data, no
 * imports, so the decorrelation property they exist for is unit-testable
 * without a database client.
 */

/** Drop both seeded types (cascades fields, records and links). Idempotent. */
const dropSeededTypes = async (ctx: EvalCaseContext): Promise<void> => {
  for (const key of [ITEM_KEY, OWNER_KEY]) {
    await invalidateObjectTypeIdCache({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      key,
    });
    const id = await resolveObjectTypeId({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      key,
    });
    if (id) await deleteObjectType({ id });
  }
};

const FIELD_KEYS = [
  "title",
  "status",
  "priority",
  "team",
  "effort",
  "budget",
  "due_at",
] as const;

/**
 * True when the fixture is already provisioned AND matches what the cases
 * assert — both types, right row count, right field set. Anything else (a
 * half-built type from an interrupted run, an edited `ITEM_ROWS`) reports false
 * and forces a rebuild, so the fixture can never silently drift from the
 * assertions.
 *
 * It also expires. Due dates are seeded relative to the day the fixture was
 * built, so a fixture left alone for a few months drifts entirely into the past
 * and "overdue" quietly becomes true of every row — the exact degeneracy the
 * relative dates were introduced to remove. One row still due in the future is
 * the cheapest proof that the spread is still a spread.
 */
const fixtureIsCurrent = async (ctx: EvalCaseContext): Promise<boolean> => {
  const scope = { organizationId: ctx.organizationId, teamId: ctx.teamId };
  const typeId = await resolveObjectTypeId({ ...scope, key: ITEM_KEY });
  const ownerTypeId = await resolveObjectTypeId({ ...scope, key: OWNER_KEY });
  if (!typeId || !ownerTypeId) return false;
  const rows = await queryObjectRecords({
    teamId: ctx.teamId,
    objectTypeId: typeId,
    limit: ITEM_ROW_COUNT + 1,
  });
  if (rows.length !== ITEM_ROW_COUNT) return false;
  const first = rows[0]?.data;
  if (!first) return false;
  // `FIELD_KEYS` are stored COLUMNS, so the relation is deliberately absent
  // from them — its values live in the links graph and never appear in `data`.
  // It gets its own check: a fixture seeded before the relation existed has the
  // right row count and the right columns, so nothing else here would notice.
  if (!FIELD_KEYS.every((k) => k in first)) return false;
  const fields = await getFieldDefinitionsForTeam({
    teamId: ctx.teamId,
    objectTypeId: typeId,
    objectTypeKey: ITEM_KEY,
  });
  if (!fields.some((f) => f.key === OWNER_FIELD_KEY && f.type === "relation"))
    return false;
  const today = new Date().toISOString().slice(0, 10);
  return rows.some((row) => {
    const due = row.data?.due_at;
    return typeof due === "string" && due > today;
  });
};

/**
 * Provision both types, the link between them, and the rows — ONCE. Every case
 * in the suite shares one fixture, and the runner executes cases concurrently
 * (default 3), so a drop-and-recreate seed would tear the types out from under
 * a sibling case's turn. Hence: reuse when already correct, rebuild only when
 * it isn't.
 *
 * Retries the whole thing: the DDL on `data.obj_…` can transiently race the
 * live AI service's own table provisioning on the shared dev DB (the same
 * cross-process race `objects-autonomy.ts` documents).
 *
 * The fixture is deliberately NOT dropped on cleanup: it is static reference
 * data, rebuilding it per case would cost seconds × 10, and leaving it makes
 * reruns fast. Cases sweep only the pages of EARLIER runs.
 */
const seedItemsOnce = async (ctx: EvalCaseContext): Promise<void> => {
  const base = { organizationId: ctx.organizationId, teamId: ctx.teamId };
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (await fixtureIsCurrent(ctx)) return;
      await dropSeededTypes(ctx);

      // 1. The owners — created first, because the items link TO them.
      const owner = await createObjectType({
        ...base,
        key: OWNER_KEY,
        label: OWNER_LABEL,
      });
      await createFieldDefinition({
        ...base,
        objectTypeId: owner.id,
        key: "name",
        label: "Name",
        type: "text",
        isTitle: true,
        displayOrder: 0,
      });
      await createFieldDefinition({
        ...base,
        objectTypeId: owner.id,
        key: "capacity",
        label: "Capacity (days/week)",
        type: "number",
        displayOrder: 1,
      });
      await reconcileObjectTable({ objectTypeId: owner.id });

      const ownerIdByName = new Map<string, string>();
      for (const person of OWNERS) {
        const record = await createObjectRecord({
          ...base,
          objectTypeId: owner.id,
          data: { name: person.name, capacity: person.capacity },
        });
        ownerIdByName.set(person.name, record.id);
      }

      // 2. The work items.
      const item = await createObjectType({
        ...base,
        key: ITEM_KEY,
        label: ITEM_LABEL,
      });
      await createFieldDefinition({
        ...base,
        objectTypeId: item.id,
        key: "title",
        label: "Title",
        type: "text",
        isTitle: true,
        displayOrder: 0,
      });
      await createFieldDefinition({
        ...base,
        objectTypeId: item.id,
        key: "status",
        label: "Status",
        type: "select",
        config: { options: STATUSES },
        displayOrder: 1,
      });
      await createFieldDefinition({
        ...base,
        objectTypeId: item.id,
        key: "priority",
        label: "Priority",
        type: "select",
        config: { options: PRIORITIES },
        displayOrder: 2,
      });
      // The team sits on the ITEM, and only there. A page dataset reads the
      // columns of ONE type: `objects` has no join, and a bare link is a graph
      // edge that never surfaces in the rows. Pages CAN see a relation —
      // `services/pages/field-descriptors` resolves a relation chip's target
      // icon and colour — but that needs a `relation` FIELD, not the link type
      // seeded below, and wiring one is the open item. Until then this column
      // is what makes a per-team question answerable from a page at all.
      // Owners deliberately carry no team of their own: two teams on two types
      // would make "group by team" ambiguous, and tying one to the other would
      // put the correlation back that this fixture exists to avoid.
      await createFieldDefinition({
        ...base,
        objectTypeId: item.id,
        key: "team",
        label: "Team",
        type: "select",
        config: { options: TEAMS },
        displayOrder: 3,
      });
      await createFieldDefinition({
        ...base,
        objectTypeId: item.id,
        key: "effort",
        label: "Effort (days)",
        type: "number",
        displayOrder: 4,
      });
      await createFieldDefinition({
        ...base,
        objectTypeId: item.id,
        key: "budget",
        label: "Budget",
        type: "money",
        config: { defaultCurrencyCode: "EUR" },
        displayOrder: 5,
      });
      await createFieldDefinition({
        ...base,
        objectTypeId: item.id,
        key: "due_at",
        label: "Due date",
        type: "date",
        displayOrder: 6,
      });
      await reconcileObjectTable({ objectTypeId: item.id });

      // 3. The relation, and the rows that use it.
      const ownerLink = await createLinkType({
        ...base,
        key: OWNER_LINK_KEY,
        label: "Owner",
        fromObjectTypeId: item.id,
        toObjectTypeId: owner.id,
      });

      // The link type alone is invisible to a page: `objects` reads a type's
      // columns, and edges are not columns. What makes the relation READABLE is
      // a `relation` FIELD bound to that link type — its values then ride back
      // in `computed`, which `flattenRecordRow` already merges into the row, so
      // a page gets `owner: [{ id, label }]` and a descriptor carrying the
      // target type's colour. `linkTypeKey` reuses the link created above
      // rather than letting the binding mint a second one, so the 24 edges
      // seeded below are the field's own edges.
      await createFieldDefinition({
        ...base,
        objectTypeId: item.id,
        key: OWNER_FIELD_KEY,
        label: "Owner",
        type: "relation",
        config: {
          targetTypeKey: OWNER_KEY,
          cardinality: "one",
          linkTypeKey: OWNER_LINK_KEY,
        },
        displayOrder: 6,
      });

      for (const row of itemRows(Date.now())) {
        const { owner: ownerName, ...data } = row;
        const record = await createObjectRecord({
          ...base,
          objectTypeId: item.id,
          data,
        });
        const toRecordId =
          typeof ownerName === "string"
            ? ownerIdByName.get(ownerName)
            : undefined;
        if (!toRecordId) continue;
        await createLink({
          ...base,
          linkTypeId: ownerLink.id,
          fromRecordId: record.id,
          toRecordId,
        });
      }
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  throw lastErr;
};

/**
 * One rebuild for the whole run, and every other case waits for it.
 *
 * Retrying was not enough, and the run of 2026-08-17 is why: changing the
 * fixture's SHAPE makes `fixtureIsCurrent` false for every case at once, so
 * three of them entered the rebuild together and `dropSeededTypes` pulled the
 * types out from under the siblings mid-turn. **Two of the ten cases never
 * completed** — no red assertion, no error in the summary, just a run of eight.
 * The retry loop was tuned for "one case rebuilds while another reads", not for
 * "every case rebuilds because the definition moved".
 *
 * The runner executes cases concurrently inside ONE process, so an in-process
 * mutex is the whole fix; there is no second writer. The promise is cleared on
 * failure, otherwise one transient DDL race would poison every later case with
 * a memoised rejection.
 *
 * RULE: a shared fixture needs mutual exclusion, not retries — retries make
 * concurrent writers collide more politely, they do not stop them colliding.
 */
let seedInFlight: Promise<void> | null = null;

const seedItems = async (ctx: EvalCaseContext): Promise<void> => {
  seedInFlight ??= seedItemsOnce(ctx).catch((err: unknown) => {
    seedInFlight = null;
    throw err;
  });
  await seedInFlight;
};

// ── Page lookup + tool-output readers ───────────────────────────────────────

/**
 * The page the agent created during THIS turn. `managePage.create` stamps
 * `sourceConversationId` with the runtime conversation, and the harness gives
 * every case a disposable one — so this is an exact, collision-free handle.
 */
const pageForConversation = async (
  ctx: EvalCaseContext,
): Promise<{
  id: string;
  name: string;
  definition: unknown;
  publicToken: string | null;
  /** `updatedAt > createdAt` is the mark of a page edited after it was
   * created — the artifact-side proof that a fix round actually happened. */
  createdAt: Date;
  updatedAt: Date;
} | null> => {
  if (!ctx.conversationId) return null;
  const rows = await db
    .select({
      id: pages.id,
      name: pages.name,
      definition: pages.definition,
      publicToken: pages.publicToken,
      createdAt: pages.createdAt,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(
      and(
        eq(pages.teamId, ctx.teamId),
        eq(pages.sourceConversationId, ctx.conversationId),
      ),
    )
    // Oldest first, so the answer is deterministic when a turn produced more
    // than one page: for the update case that is the SEEDED page (the one the
    // assertion is about), and for the create cases there is only ever one.
    .orderBy(pages.createdAt);
  return rows[0] ?? null;
};

/**
 * How long a page built by an eval survives its run.
 *
 * It used to be zero: every case deleted its own page the moment the
 * assertions were done. That is tidy and it destroys the evidence — the run of
 * 2026-08-16 produced one page whose filter was better than the assertion that
 * failed it, and there was nothing left to look at. Scores tell you a page was
 * worth 6.8; only the page tells you why.
 *
 * So a run's output is kept and the PREVIOUS runs' output is what gets swept.
 * Half a day covers "run it, then read it", and the eval team never grows
 * without bound.
 */
const PAGE_RETENTION_MS = 12 * 60 * 60 * 1000;

/**
 * Sweep pages left by EARLIER runs, keep this one's. Runs from a `cleanup`
 * hook, so it fires once per case — the delete is idempotent and cheap, and
 * putting it here means no separate maintenance step anyone can forget.
 */
const cleanupPages = async (ctx: EvalCaseContext): Promise<void> => {
  await db
    .delete(pages)
    .where(
      and(
        eq(pages.teamId, ctx.teamId),
        lt(pages.createdAt, new Date(Date.now() - PAGE_RETENTION_MS)),
      ),
    );
};

const managePageCalls = (result: InvokeResult): InvokeResult["toolCalls"] =>
  result.toolCalls.filter((c) => c.name === "managePage");

/**
 * True when the turn handed the page to the `buildPage` specialist.
 *
 * This changes what the harness can see, and it is the reason several
 * assertions below read the DATABASE rather than the tool trace. The eval
 * client reconstructs `toolCalls` from the PARENT turn's SSE stream; a
 * sub-agent's calls never appear on it. So under delegation `managePage` looks
 * unused, the final write looks absent, and a suite written against the trace
 * reports a run of model failures that are really harness blindness.
 *
 * Every fact that can be read off the stored page is read off the stored page.
 * That is not a workaround — it is what the suite's own docblock has always
 * claimed to do, and delegation is what forced the last few holdouts across.
 */
const delegated = (result: InvokeResult): boolean =>
  result.toolCalls.some((c) => c.name === "buildPage");

/**
 * The page-building tools, either of which is a legitimate way to answer.
 * `buildPage` delegates the whole thing; `managePage` is the small targeted
 * edit the routing table keeps on the main agent.
 */
const pageTools = ["managePage", "buildPage"];

/**
 * Dry-run the STORED definition — the same call `create`/`update` make, run
 * again on what actually got saved.
 *
 * This replaces reading `warnings` and `samples` off the last write, and it is
 * better than what it replaces even before delegation: a tool result reports
 * what the system said at write time, this reports what is true of the page
 * that exists. `assumeSanitized` is false on purpose — the stored definition
 * went through the sanitizer, so a warning it raises here is a genuine defect
 * in what was stored rather than a coercion already applied.
 */
const dryRunStored = async (
  ctx: EvalCaseContext,
): Promise<PageDryRun | null> => {
  const page = await pageForConversation(ctx);
  if (!page) return null;
  const parsed = PageDefinitionSchema.safeParse(page.definition);
  if (!parsed.success) return null;
  return dryRunPage({
    definition: parsed.data,
    teamId: ctx.teamId,
    userId: ctx.userId ?? null,
    // Already compiled by the write gate; recompiling costs ~220ms and can
    // only report what the write already refused to store.
    assumeCompiled: parsed.data.code.compiled !== undefined,
  });
};

// ── Shared assertion builders ───────────────────────────────────────────────

/** The saved page exists and is non-trivial. On a code page "nodes" are the
 * template's component-tag occurrences (see `collectNodes`), so a floor here
 * is a floor on how much the SFC actually assembles. */
const pageSaved = (minNodes: number): EvalCase["assertions"][number] => ({
  type: "custom",
  name: "page-saved",
  fn: async (_r, ctx) => {
    const page = await pageForConversation(ctx);
    if (!page) return "no page was saved for this conversation";
    const nodes = collectNodes(page.definition);
    if (nodes.length < minNodes)
      return `page has only ${nodes.length} nodes (expected ≥ ${minNodes}) — types: ${nodeTypes(page.definition).join(",")}`;
    return true;
  },
});

/**
 * The system's own verdict on what got stored. This is the single most
 * transferable quality number in the suite: it means the same thing before and
 * after the refonte, so it is the headline the migration must not regress.
 *
 * Read off the stored page rather than off the write that produced it — same
 * `dryRunPage` call, run on what survived.
 */
const noFinalWarnings: EvalCase["assertions"][number] = {
  type: "custom",
  name: "stored-page-clean",
  fn: async (_r, ctx) => {
    const dry = await dryRunStored(ctx);
    if (dry === null) return "no readable page was saved for this conversation";
    if (dry.warnings.length > 0)
      return `stored definition has warnings: ${dry.warnings.join(" | ")}`;
    return true;
  },
};

/** A page whose datasets return nothing is a page nobody can use. */
const datasetsReturnedRows: EvalCase["assertions"][number] = {
  type: "custom",
  name: "datasets-returned-rows",
  fn: async (_r, ctx) => {
    const dry = await dryRunStored(ctx);
    if (dry === null) return "no readable page was saved for this conversation";
    const counts = Object.values(dry.samples).map((s) => s.rowCount);
    if (counts.length === 0) return "the stored page declares no datasets";
    if (counts.every((n) => n === 0))
      return `every dataset came back empty (${counts.join(",")}) — field keys or filters are wrong`;
    return true;
  },
};

/** Datasets must be bound to the seeded type, not invented. */
const usesSeededType: EvalCase["assertions"][number] = {
  type: "custom",
  name: "datasets-bound-to-seeded-type",
  fn: async (_r, ctx) => {
    const page = await pageForConversation(ctx);
    if (!page) return "no page was saved";
    const datasets = collectDatasets(page.definition);
    if (datasets.length === 0) return "page has no datasets — nothing is live";
    const typeId = await resolveObjectTypeId({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      key: ITEM_KEY,
    });
    if (!typeId) return "seeded type vanished during the run";
    if (!definitionText(page.definition).includes(typeId))
      return "no dataset targets the seeded work-item type";
    return true;
  },
};

// ── The built page itself (Pages v4) ────────────────────────────────────────

/**
 * Every value and label a page about THIS fixture would naturally use. The
 * brief test below asks whether the design encodes this subject, and the
 * cheapest objective proxy is whether it names anything that only exists here.
 */
const FIXTURE_VOCABULARY = [
  ITEM_LABEL,
  "item",
  "task",
  "work",
  ...STATUSES.map((s) => s.value),
  ...STATUSES.map((s) => s.label),
  ...PRIORITIES.map((p) => p.label),
  ...TEAMS.map((t) => t.label),
  "status",
  "priority",
  "effort",
  "budget",
  "due",
  "owner",
];

const mentionsFixture = (text: string): boolean => {
  const hay = text.toLowerCase();
  return FIXTURE_VOCABULARY.some((word) => hay.includes(word.toLowerCase()));
};

/** Render the stored page once and hand the judgement to an assertion. */
const judgementFor = async (
  ctx: EvalCaseContext,
): Promise<PageJudgement | string> => {
  const page = await pageForConversation(ctx);
  if (!page) return "no page was saved for this conversation";
  const parsed = PageDefinitionSchema.safeParse(page.definition);
  if (!parsed.success) return "the stored definition does not parse";
  return judgePage({
    pageId: page.id,
    pageName: page.name,
    definition: parsed.data,
    ctx,
  });
};

/**
 * The measured half of the review, applied to whatever the turn stored. This
 * is the assertion the whole v4 chantier exists for: it is the only one that
 * would have caught the slideover that opened empty and the compose form that
 * rendered permanently inline, both of which shipped past a clean console.
 */
const rendersAndWorks: EvalCase["assertions"][number] = {
  type: "custom",
  name: "render-gate",
  fn: async (_r, ctx) => {
    const judgement = await judgementFor(ctx);
    return typeof judgement === "string" ? judgement : gatePasses(judgement);
  },
};

/**
 * Publishing mints a URL anyone can open with no account, over everything the
 * owning team can see. It is a property of ANY page the agent builds, not a
 * scenario of its own — it used to have a six-minute case to itself, which is
 * six minutes to observe a boolean.
 */
const notPublished: EvalCase["assertions"][number] = {
  type: "custom",
  name: "not-published",
  fn: async (_r, ctx) => {
    const page = await pageForConversation(ctx);
    return page?.publicToken
      ? "the page carries a public token — it was published without being asked"
      : true;
  },
};

/**
 * The loop RAN: somebody rendered the page and then changed it. Same argument
 * — true of any build, so it rides along instead of costing its own case.
 *
 * Both facts are read outside the tool trace on purpose. The review counter is
 * the Redis key the tool increments (per conversation + page), read without
 * moving it; the edit is `updatedAt > createdAt` on the row. A turn that hands
 * over an unreviewed page fails here, which is the number this whole chantier
 * exists to move.
 */
const reviewedThenFixed: EvalCase["assertions"][number] = {
  type: "custom",
  name: "reviewed-then-fixed",
  fn: async (_r, ctx) => {
    const page = await pageForConversation(ctx);
    if (!page) return "no page was saved";
    const reviews = await readPageReviewIterations(ctx.conversationId, page.id);
    if (reviews === 0)
      return "the page was never rendered for review — it was handed over without anyone looking at it";
    // A first review that finds nothing IS a legitimate stop, so one clean
    // pass with no edit is half credit rather than a failure — but it is not
    // the loop, and the score says so.
    if (page.updatedAt.getTime() <= page.createdAt.getTime())
      return {
        passed: true,
        score: 0.5,
        message: `reviewed ${reviews.toString()}× but never edited afterwards — either the first pass was clean or the findings were dropped`,
      };
    return {
      passed: true,
      score: 1,
      message: `reviewed ${reviews.toString()}× and edited after the first pass`,
    };
  },
};

/**
 * The judged half, graded.
 *
 * RAISED 5 → 6 on 2026-08-18, and the reason is that the old floor could not
 * do the one job a floor has. The rubric puts "renders correctly and decides
 * nothing" at 5 and `SHIP_SCORE` at 7.5, so a suite failing only below 5 marked
 * every generic page GREEN — the run stayed clean while the design average sat
 * at 6.4 for four phases. A measurement that tolerates the plateau it is
 * supposed to detect is not a measurement.
 *
 * 6 is the first rung that means something: above the "nothing decided" midpoint
 * and still well under ship, so it fails genuinely mediocre pages without
 * failing a build for the critic's ±0.5 run-to-run variance. It goes to 6.5
 * once the builder A/B lands — not before, because raising a floor and changing
 * the model in the same run would leave neither measured.
 */
const DESIGN_FLOOR = 6;

const designIsAtLeastCompetent: EvalCase["assertions"][number] = {
  type: "custom",
  name: "design-score",
  fn: async (_r, ctx) => {
    const judgement = await judgementFor(ctx);
    return typeof judgement === "string"
      ? judgement
      : designScoreAtLeast(judgement, DESIGN_FLOOR);
  },
};

// ── Cases ───────────────────────────────────────────────────────────────────

/**
 * The DETAILED spec, and the counterpart to `page-vague-request-expands`: a
 * request that names three things gets those three things, faithfully. It also
 * carries the properties that used to be cases of their own — the field keys
 * are real, nothing was published — because they are true of any built page
 * and a boolean does not deserve a six-minute build to observe it.
 */
const dashboard: EvalCase = {
  id: "page-dashboard-kpi-charts",
  description:
    "A detailed dashboard ask yields exactly what it named — live datasets, KPI stats, a chart — grounded in the real schema and not published.",
  prompt: `Build me a dashboard page for our "${ITEM_LABEL}" records: the total budget across all of them, how many there are in each status, and how the work falls due month by month.`,
  tags: ["pages", "generation"],
  seed: seedItems,
  cleanup: cleanupPages,
  budget: {
    maxToolCalls: 14,
    expectedTools: [
      "searchTools",
      "buildPage",
      "describeObjectType",
      "managePage",
    ],
  },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: pageTools },
    // Was 6 when heading and stat NODES counted. The tag scan only sees
    // component tags — KPI tiles written as styled divs are invisible to it —
    // so the floor drops to what a real dashboard cannot go below: the charts
    // plus their loading/empty states.
    pageSaved(4),
    usesSeededType,
    datasetsReturnedRows,
    noFinalWarnings,
    {
      type: "custom",
      name: "has-chart-and-stat",
      fn: async (_r, ctx) => {
        const page = await pageForConversation(ctx);
        if (!page) return "no page was saved";
        const source = pageSource(page.definition);
        // A code page has no chart NODE — Chart.js drawing on a <canvas> is
        // the one way this runtime charts.
        if (!/chart\.js|<canvas/i.test(source))
          return "no chart — the code neither imports chart.js nor draws on a <canvas>";
        // No stat node either: a KPI is a big rendered number, and the house
        // idiom for one is `text-3xl font-display tabular-nums`
        // (skills/building-pages). The class probe is a proxy for "a headline
        // figure is displayed prominently".
        if (!/text-3xl|tabular-nums/.test(source))
          return "no KPI figure — nothing renders a big number (text-3xl / tabular-nums)";
        return true;
      },
    },
    {
      // GROUNDING, folded in from the case that used to own it. "Month by
      // month" forces the date field, whose key (`due_at`) cannot be
      // guessed from its label ("Closed at") — so passing means the schema was
      // actually read rather than imagined.
      type: "custom",
      name: "grounded-on-real-date-field",
      fn: async (_r, ctx) => {
        const page = await pageForConversation(ctx);
        if (!page) return "no page was saved";
        return definitionText(page.definition).includes("due_at")
          ? true
          : "the definition never references the real field key `due_at` — the monthly view was built from a guessed key";
      },
    },
    notPublished,
    rendersAndWorks,
    designIsAtLeastCompetent,
    {
      type: "judge",
      rubric:
        "The assistant built a dashboard page and told the user it exists (a link or a clear confirmation). CORRECT if it reports the page and its content matches all three asks (total budget, count per status, monthly due dates) with numbers grounded in the tool outputs. PARTIAL if the page was built but one ask is missing or the reply is vague about what is on it. INCORRECT if no page was built, or the reply invents figures the tool outputs do not support.",
    },
  ],
};

const filterableDirectory: EvalCase = {
  id: "page-filterable-directory",
  description:
    "A 'filterable by status' ask produces a control wired to state AND a dataset filter that reads it, and the row shows the person a relation points at.",
  // "who is on each one" names the need, never the field or the shape. The
  // owner is a RELATION — its values arrive as `[{ id, label }]` from the links
  // graph rather than as a column — so a page that prints the raw value shows
  // an object, and one that never reaches for it answers half the question.
  // Nothing in the suite exercised a relation before the fixture grew one.
  // "change the status right there" names the NEED, never the operation kind,
  // the field or the control. A page could not write a record at all until
  // 2026-08-17, which is why every earlier prompt stopped at reading.
  prompt: `Make me a page listing our "${ITEM_LABEL}" records in a table, with a control at the top so I can filter the list by status without editing the page. I also want to see who is on each one, and to change the status of a record right there instead of opening it elsewhere.`,
  tags: ["pages", "generation", "interactivity"],
  seed: seedItems,
  cleanup: cleanupPages,
  // The only build case whose `expectedTools` omitted `buildPage`, so the
  // CORRECT routing counted as an off-plan tool on top of the overage. And the
  // ceiling was the suite's tightest while the ask grew a write — 30 calls
  // against 12 on 2026-08-17. Both numbers measure ROUTING more than effort
  // (a delegated turn shows ~3 parent calls, an inline one 15-30), which is
  // why the budget is informational and never fails a case.
  budget: {
    maxToolCalls: 24,
    expectedTools: [
      "searchTools",
      "buildPage",
      "describeObjectType",
      "managePage",
    ],
  },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: pageTools },
    pageSaved(3),
    usesSeededType,
    {
      type: "custom",
      name: "relation-reaches-the-row",
      fn: async (_r, ctx) => {
        const page = await pageForConversation(ctx);
        if (!page) return "no page was saved";
        const source = pageSource(page.definition);
        if (!source.includes(OWNER_FIELD_KEY))
          return "the page never mentions the owner, though the request asked who is on each item";
        // A relation arrives as `[{ id, label }]`. Rendering the value itself
        // prints `[object Object]`, so reaching the label — by index, by map,
        // or through the field descriptor — is the whole difference between
        // answering and appearing to.
        if (!/\blabel\b/.test(source))
          return "the owner is read but never its `label` — a relation is [{ id, label }], so the raw value renders as [object Object]";
        return true;
      },
    },
    {
      type: "custom",
      name: "the-write-is-declared",
      fn: async (_r, ctx) => {
        const page = await pageForConversation(ctx);
        if (!page) return "no page was saved";
        // A control that changes a status is a PROMISE, and only the contract
        // can keep it: the code may render a select on every row and still
        // change nothing, which is indistinguishable from working until
        // somebody reloads. So this reads the definition, not the source.
        const write = collectOperations(page.definition).find(
          (operation) =>
            operation["kind"] === "record" || operation["kind"] === "bulk",
        );
        if (!write)
          return "the page declares no record operation, so nothing it draws can change a status — a control over a read-only page is a promise nothing keeps";
        const typeId = await resolveObjectTypeId({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          key: ITEM_KEY,
        });
        if (typeId && write["objectTypeId"] !== typeId)
          return `the write targets a different object type than the one the page lists`;
        const args = write["args"];
        if (
          args === null ||
          typeof args !== "object" ||
          Object.keys(args).length === 0
        )
          return "the operation names no args, and args IS the writable-field list — it would save and change nothing";
        return true;
      },
    },
    {
      type: "custom",
      name: "control-wired-to-state",
      fn: async (_r, ctx) => {
        const page = await pageForConversation(ctx);
        if (!page) return "no page was saved";
        const source = pageSource(page.definition);
        // No list of acceptable filter COMPONENTS here, deliberately. There
        // used to be one, and on 2026-08-16 it failed a page that answered
        // BETTER than the list allowed: a row of toggle chips, each carrying
        // its status's count and total, click to filter and click again to
        // clear — which is what `references/components.md` prescribes for four
        // values. Naming components in an assertion measures our own
        // suggestion, and marks a page wrong for improving on it. What the
        // case is actually about is below: the choice travels, and the data
        // reads it. A control that does neither is caught by the render gate.
        //
        // Wired means the choice TRAVELS: the code re-queries with variable
        // values (`fretik.data.query({ variables })`), and a dataset filter
        // reads the variable back as a { "var": … } reference. Either half
        // alone is an inert control.
        //
        // The failure this catches is SILENT and only appears at scale. On
        // 2026-08-17 a well-built page loaded one `limit: 100` window and
        // filtered it with a computed — flawless over the 24 seeded rows, and
        // wrong the day the type holds 150, because the control would then
        // narrow the first hundred instead of the records. The fixture size is
        // what hides it, which is exactly why the assertion cannot be relaxed
        // to "the display changes".
        if (
          !source.includes("fretik.data.query") ||
          !/\bvariables\b/.test(source)
        )
          return "the control filters rows already in the page, so it only ever narrows the window the page happens to have loaded — it must re-query, or it lies as soon as the records outgrow the limit";
        if (!definitionText(page.definition).includes('"var"'))
          return 'no dataset filter reads the variable — no { "var": … } reference in the definition';
        return true;
      },
    },
    noFinalWarnings,
    notPublished,
    rendersAndWorks,
    designIsAtLeastCompetent,
    {
      type: "judge",
      rubric:
        "The assistant delivered a page with a table of the records and an interactive way to narrow it by status. CORRECT if both are reported and the filter is described as something the viewer operates. PARTIAL if the table exists but the filtering is unclear or static. INCORRECT if no page was built or it ignores the filtering request.",
    },
  ],
};

/**
 * The relevance gate. A page is a durable artifact; a one-off number is an
 * answer. Building a page here is the over-firing failure — the same shape as
 * `obj-relevance-gate` and `b2b-knowledge-no-tool`.
 */
const noPageForOneOffQuestion: EvalCase = {
  id: "page-not-for-one-off-question",
  description:
    "A single factual question is answered inline — no page is built for it.",
  prompt: `How many "${ITEM_LABEL}" records do we have in total? Just tell me the number.`,
  tags: ["pages", "reasoning", "relevance-gate"],
  seed: seedItems,
  cleanup: cleanupPages,
  budget: { maxToolCalls: 4 },
  assertions: [
    { type: "noError" },
    {
      type: "custom",
      name: "no-page-created",
      fn: async (_r, ctx) => {
        const page = await pageForConversation(ctx);
        return page
          ? `a page ("${page.name}") was built for a one-off question`
          : true;
      },
    },
    { type: "contains", value: "24" },
  ],
};

/**
 * Update safety. A definition section the agent resends replaces the stored
 * one WHOLE, so the failure mode is silent amputation: a one-string ask
 * answered with a cut-down SFC (instead of targeted `edits`, or a faithful
 * full resend) loses the rest of the page. Seeds a two-dataset code page and
 * asks for a change that touches one heading.
 */
const UPDATE_PAGE_NAME = "Eval Pipeline Overview";

const updatePreservesRest: EvalCase = {
  id: "page-update-preserves-rest",
  description:
    "Changing one part of an existing page leaves its other content intact (no wholesale amputation).",
  // "the main title" was ambiguous — a page has BOTH a name and a heading in
  // its code, and the agent reasonably renamed the page instead. Naming the
  // current heading text removes the ambiguity so the case measures what it
  // is for: whether the rest of the code survives a targeted edit.
  prompt: `On the page called "${UPDATE_PAGE_NAME}", the heading at the top currently reads "Pipeline overview". Change that heading's text to "Pipeline 2026", and leave the rest of the page exactly as it is.`,
  tags: ["pages", "generation", "data-loss"],
  seed: async (ctx) => {
    await seedItems(ctx);
    const typeId = await resolveObjectTypeId({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      key: ITEM_KEY,
    });
    if (!typeId)
      throw new Error("eval seed: work-item type missing after seeding");
    if (!ctx.userId) throw new Error("eval seed: EVAL_USER_ID is required");
    // Inserted directly rather than through `createPage`: the fixture must be
    // byte-exact (the sanitizer would be free to coerce it), and importing the
    // service would pull `schemas/pages`, which only loads once something has
    // registered the zod-openapi extension — true inside the API/AI process,
    // not in the eval runner. The `pages` table types its jsonb column with a
    // TYPE-only import, so `db/schema` stays safe to import here. `compiled`
    // is deliberately absent — a direct insert never compiled, and the agent's
    // own update recompiles the edited source anyway.
    //
    // The SFC is house-style (skills/building-pages): a heading, a Chart.js
    // bar on a <canvas> fed by `by_status`, a UTable over `items` — the three
    // things the assertion checks survive the edit. "Pipeline overview"
    // appears EXACTLY once, so an exact-match `edits` call lands cleanly.
    const source = `<template>
  <div class="mx-auto max-w-screen-xl space-y-6 p-6">
    <div>
      <h1 class="text-2xl font-display tracking-tight">Pipeline overview</h1>
      <p class="text-sm text-muted">Every work item, and where each status stands.</p>
    </div>

    <UCard variant="soft">
      <p class="text-xs uppercase tracking-wide text-muted">Items per status</p>
      <USkeleton v-if="pending" class="mt-3 h-64 w-full" />
      <canvas v-show="!pending" ref="stageCanvas" class="mt-3 max-h-64 w-full" />
    </UCard>

    <UCard variant="soft">
      <p class="text-xs uppercase tracking-wide text-muted">All items</p>
      <USkeleton v-if="pending" class="mt-3 h-40 w-full" />
      <UEmpty v-else-if="rows.length === 0" icon="i-lucide-inbox" title="No items yet" />
      <UTable v-else :data="rows" class="mt-3" />
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Chart from 'chart.js/auto'
import { fretik, type DatasetResult } from '#fretik/sdk'

const pending = ref(true)
const datasets = ref<Record<string, DatasetResult>>({})
const stageCanvas = ref<HTMLCanvasElement | null>(null)
let chart: Chart | null = null

const rows = computed(() =>
  datasets.value.items?.status === 'ok'
    ? (datasets.value.items.rows as Record<string, unknown>[])
    : [],
)

onMounted(async () => {
  const result = await fretik.data.query()
  datasets.value = result.datasets
  pending.value = false
  const byStage = datasets.value.by_status
  if (byStage?.status === 'ok' && stageCanvas.value) {
    const stageRows = byStage.rows as { group: string; item_count: number }[]
    chart = new Chart(stageCanvas.value, {
      type: 'bar',
      data: {
        labels: stageRows.map((row) => row.group),
        datasets: [{ label: 'Items', data: stageRows.map((row) => row.item_count) }],
      },
    })
  }
})

onUnmounted(() => {
  chart?.destroy()
})
</script>
`;
    const definition: PageDefinition = {
      version: 3,
      variables: [],
      operations: [],
      datasets: [
        {
          id: "items",
          kind: "objects",
          objectTypeId: typeId,
          mode: "records",
          limit: 50,
        },
        {
          id: "by_status",
          kind: "objects",
          objectTypeId: typeId,
          mode: "aggregate",
          groupBy: "status",
          metrics: [{ name: "item_count", fn: "count", label: "Items" }],
        },
      ],
      code: { source },
    };
    await db.insert(pages).values({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      name: UPDATE_PAGE_NAME,
      description: "Seeded by the pages eval.",
      definition,
      sourceConversationId: ctx.conversationId,
      createdByUserId: ctx.userId,
    });
  },
  cleanup: cleanupPages,
  budget: {
    maxToolCalls: 10,
    expectedTools: ["searchTools", "managePage"],
  },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: pageTools },
    {
      type: "custom",
      name: "chart-and-table-survived",
      fn: async (_r, ctx) => {
        const page = await pageForConversation(ctx);
        if (!page) return "the seeded page disappeared";
        const source = pageSource(page.definition);
        if (!/Pipeline 2026/.test(source))
          return "the heading was not changed to 'Pipeline 2026'";
        if (!/chart\.js|<canvas/i.test(source))
          return "the chart was dropped by the update — no chart.js / <canvas> left in the code";
        if (!/<UTable|<table/i.test(source))
          return "the table was dropped by the update — no <UTable> left in the code";
        const datasets = collectDatasets(page.definition);
        if (datasets.length < 2)
          return `datasets lost: ${datasets.length} left of 2`;
        return true;
      },
    },
    noFinalWarnings,
  ],
};

/**
 * RECOVERY. Every other case measures the happy path; this one measures what
 * happens after a refusal — the property that has to hold on the weakest model
 * and the slowest provider, because the only context it gets is the error text.
 *
 * The user hands over a pageId that does not exist. `managePage` answers
 * `NOT_FOUND`, naming the id and pointing at `list`, and the whole case is
 * whether that is enough: the agent must re-find the real page and finish the
 * edit inside the same turn, without the loop guard having to intervene.
 */
const RECOVERY_PAGE_NAME = "Eval Recovery Board";
/** A well-formed uuid that no row carries — a stale id, not a malformed one. */
const STALE_PAGE_ID = "01933eb8-541f-7000-a9f4-e4eee80ff04e";

const recoversFromStalePageId: EvalCase = {
  id: "page-recovers-from-stale-id",
  description:
    "A refused write is recoverable from the error text alone: the agent re-finds the page and completes the edit.",
  prompt: `Open the page with id ${STALE_PAGE_ID} and change its heading to "Recovered board". If that id is wrong, find the right page yourself — it is called "${RECOVERY_PAGE_NAME}".`,
  tags: ["pages", "generation", "recovery"],
  seed: async (ctx) => {
    await seedItems(ctx);
    const typeId = await resolveObjectTypeId({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      key: ITEM_KEY,
    });
    if (!typeId)
      throw new Error("eval seed: work-item type missing after seeding");
    if (!ctx.userId) throw new Error("eval seed: EVAL_USER_ID is required");
    // Inserted directly for the same reason as the update case: the fixture
    // must be byte-exact, so the case measures recovery and not a coercion the
    // sanitizer (or compiler) would have made. "Board" appears exactly once in
    // the source, so the recovering edit has one clean anchor.
    const source = `<template>
  <div class="mx-auto max-w-screen-xl space-y-6 p-6">
    <h1 class="text-2xl font-display tracking-tight">Board</h1>

    <UCard variant="soft">
      <p class="text-xs uppercase tracking-wide text-muted">All items</p>
      <USkeleton v-if="pending" class="mt-3 h-40 w-full" />
      <UEmpty v-else-if="rows.length === 0" icon="i-lucide-inbox" title="No items yet" />
      <UTable v-else :data="rows" class="mt-3" />
    </UCard>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { fretik, type DatasetResult } from '#fretik/sdk'

const pending = ref(true)
const datasets = ref<Record<string, DatasetResult>>({})

const rows = computed(() =>
  datasets.value.items?.status === 'ok'
    ? (datasets.value.items.rows as Record<string, unknown>[])
    : [],
)

onMounted(async () => {
  const result = await fretik.data.query()
  datasets.value = result.datasets
  pending.value = false
})
</script>
`;
    const definition: PageDefinition = {
      version: 3,
      variables: [],
      operations: [],
      datasets: [
        {
          id: "items",
          kind: "objects",
          objectTypeId: typeId,
          mode: "records",
          limit: 50,
        },
      ],
      code: { source },
    };
    await db.insert(pages).values({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      name: RECOVERY_PAGE_NAME,
      description: "Seeded by the pages eval.",
      definition,
      sourceConversationId: ctx.conversationId,
      createdByUserId: ctx.userId,
    });
  },
  cleanup: cleanupPages,
  budget: {
    // Deliberately tight: the recovery is list → update. A model that needs
    // many more calls than that did not read the error, it searched.
    maxToolCalls: 10,
    expectedTools: ["searchTools", "managePage"],
  },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: pageTools },
    {
      type: "custom",
      name: "recovered-after-the-refusal",
      fn: async (result, ctx) => {
        // The case is only meaningful if the refusal actually happened — a run
        // where the agent skipped the stale id measures nothing, so say so
        // rather than passing on a technicality. The exception is a delegated
        // run: the refusal then happens inside the builder, off this stream,
        // and the recovery is still fully readable from the stored page below.
        const refused = managePageCalls(result).some((call) => {
          const output = call.output;
          if (typeof output !== "object" || output === null) return false;
          return Reflect.get(output, "code") === "NOT_FOUND";
        });
        if (!refused && !delegated(result))
          return "the stale id never produced a NOT_FOUND refusal";

        const page = await pageForConversation(ctx);
        if (!page) return "the seeded page disappeared";
        const source = pageSource(page.definition);
        if (!/Recovered board/.test(source))
          return "the agent never completed the edit after recovering";
        if (!/<UTable|<table/i.test(source))
          return "the table was dropped while recovering — no <UTable> left in the code";
        return true;
      },
    },
    noFinalWarnings,
  ],
};

/**
 * EXPANSION. The whole reason the builder writes a brief: a user who does not
 * know what to ask for gets the tool they would have specified if they did.
 *
 * The prompt is deliberately as thin as a real one — a taste word and a verb,
 * no features, no layout, no columns. What is graded is the `brief` the page
 * stored, because that is where under-scoping becomes visible BEFORE the code:
 * a brief that commits to two features and a signature element the dataset
 * could not have produced is the failure this case exists to catch, and it is
 * the same question the skill makes the builder ask itself ("would this same
 * brief come out of a similar request over a completely different dataset?").
 */
const vagueRequestExpands: EvalCase = {
  id: "page-vague-request-expands",
  description:
    "A vague ask produces a written brief that commits to real features and encodes THIS dataset, not a template.",
  prompt: `We need something nice to keep an eye on our "${ITEM_LABEL}" records. Set it up for us.`,
  tags: ["pages", "generation", "expansion"],
  seed: seedItems,
  cleanup: cleanupPages,
  budget: {
    maxToolCalls: 14,
    expectedTools: [
      "searchTools",
      "buildPage",
      "describeObjectType",
      "managePage",
    ],
  },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: pageTools },
    pageSaved(3),
    usesSeededType,
    {
      type: "custom",
      name: "brief-is-written-and-specific",
      fn: async (_r, ctx) => {
        const page = await pageForConversation(ctx);
        if (!page) return "no page was saved";
        const parsed = PageDefinitionSchema.safeParse(page.definition);
        if (!parsed.success) return "the stored definition does not parse";
        const brief = parsed.data.brief;
        if (!brief)
          return "the page has no brief — the request was answered without ever writing down what it should be";
        if (brief.product.features.length < 2)
          return `the brief commits to ${brief.product.features.length.toString()} feature(s) — a vague ask that expands to one thing was not expanded`;
        // The template test, mechanically: a design that names nothing from
        // this dataset would come out identical for any other one.
        const design = `${brief.design.layout} ${brief.design.signature}`;
        if (!mentionsFixture(design))
          return `the design brief names nothing specific to this data — it would fit any dataset: "${design.slice(0, 200)}"`;
        return true;
      },
    },
    datasetsReturnedRows,
    noFinalWarnings,
    reviewedThenFixed,
    rendersAndWorks,
    designIsAtLeastCompetent,
    {
      type: "judge",
      rubric:
        "The assistant turned a vague request into a page and told the user what it built. CORRECT if it reports the page and names the concrete things on it (what can be seen, filtered or done), so the user learns what they got. PARTIAL if the page exists but the reply only says 'here is your dashboard' without saying what is on it. INCORRECT if no page was built, or the reply asks the user to specify everything instead of proposing something.",
    },
  ],
};

/**
 * The COMPLEX page: two dataset kinds on one screen, one queried from the
 * team's records and one written from figures the user typed into the message.
 *
 * Multi-source is where the v3 pages broke worst (the Client Mail audit), and
 * it is the shape a "replace the tool the team was using" page actually has.
 * The gate is the point of the case: more sources means more ways to render
 * something that looks finished and is not.
 */
const multiSourcePage: EvalCase = {
  id: "page-multi-source-gate",
  description:
    "A page combining the team's records with figures from the message renders, and survives the mechanical gate.",
  prompt: [
    `Build a page for our "${ITEM_LABEL}" records that puts them against the budget each team was given for the year.`,
    "",
    "The budgets are not in the system, here they are — Design: 40 000 €, Engineering: 25 000 €, Operations: 18 000 €.",
    // States the shape without naming the field: the team is a column on the
    // item, but saying so would hand over the schema probing the case exists to
    // watch.
    "Each item belongs to a team. I want to see, per team, what we have committed against what we were given, and be able to get to the items behind each one.",
  ].join("\n"),
  tags: ["pages", "generation", "multi-source"],
  seed: seedItems,
  cleanup: cleanupPages,
  budget: {
    maxToolCalls: 16,
    expectedTools: [
      "searchTools",
      "buildPage",
      "describeObjectType",
      "managePage",
    ],
  },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: pageTools },
    pageSaved(4),
    usesSeededType,
    {
      type: "custom",
      name: "two-sources-on-one-page",
      fn: async (_r, ctx) => {
        const page = await pageForConversation(ctx);
        if (!page) return "no page was saved";
        const datasets = collectDatasets(page.definition);
        const kinds = new Set(datasets.map((d) => String(d.kind)));
        if (!kinds.has("objects"))
          return `no dataset reads the team's records — kinds present: ${[...kinds].join(",") || "none"}`;
        // The budgets must live in the CONTRACT, not in the template. Which
        // shape they take is the agent's call — an `inline` dataset or a
        // variable both work, and demanding one of them named a technique
        // rather than a property (2026-08-16: a page that rendered correctly
        // and scored 7.4 was failed for putting them in a variable).
        //
        // What is NOT acceptable is three constants buried in the SFC: they
        // are then invisible to `dry_run`, and changing a target means editing
        // code. A page whose second source is hard-coded is not multi-source,
        // it is single-source with literals.
        const contract = JSON.stringify({
          datasets: datasets.filter((d) => d.kind !== "objects"),
          variables: Reflect.get(
            page.definition as Record<string, unknown>,
            "variables",
          ),
        });
        if (!/40\s?000|40000|25\s?000|25000/.test(contract))
          return `the budgets from the message are not in the data contract — only kinds ${[...kinds].join(",")}, and no variable carries them. Hard-coding them in the template makes them invisible to dry_run and uneditable without a code change.`;
        return true;
      },
    },
    datasetsReturnedRows,
    noFinalWarnings,
    rendersAndWorks,
    designIsAtLeastCompetent,
    {
      type: "judge",
      rubric:
        "The assistant built a page comparing the team's records against the per-team budgets given in the message, and reported it. CORRECT if it reports the page and the three budgets it used match the message (Design 40 000, Engineering 25 000, Operations 18 000). PARTIAL if the page was built but the reply is vague about the comparison, or one team is missing. INCORRECT if no page was built, or the reply states budgets the message did not contain.",
    },
  ],
};

// ── Page families other than the dashboard ──────────────────────────────────

/**
 * Every case above asks for a screen over the team's RECORDS, and nine of the
 * ten want a figure, a chart or a table. Measured across ten generated pages,
 * that is exactly what comes back: seventeen distinct components out of the
 * hundred-odd the runtime registers, no thread, no time axis, no roster.
 *
 * A suite that only ever asks for dashboards cannot tell a generalist page
 * builder from a dashboard generator, so these three ask for the other shapes
 * `references/design.md` names — a feed, a console, and something laid out on
 * time — and they deliberately do NOT assert which components answer. Naming
 * them would teach the test; the point is whether the builder reaches past its
 * defaults on its own, which is read off the gate, the score, and the source
 * afterwards.
 *
 * All three carry their data in the message. That is not a shortcut: it keeps
 * a varied suite free of a seed per theme, and it isolates the variable under
 * test (the SHAPE of the page) from schema probing, which the seeded cases
 * already cover.
 */

const threadPage: EvalCase = {
  id: "page-thread-shape",
  description:
    "A conversation to read and reply to becomes a thread — a feed-shaped page, not a table of messages.",
  prompt: [
    "Here is the recent exchange with one of our clients. Build me a page to follow it and answer from there.",
    "",
    "Mon 09:12 — them: Hi, the March invoice does not match the quote. Can you check?",
    "Mon 11:40 — us: Looking into it now, I will come back to you today.",
    "Mon 17:05 — us: You are right, a line was billed twice. Credit note on its way.",
    "Tue 08:22 — them: Thanks. Can you also send the updated contract while you are at it?",
    "Tue 09:01 — us: Sent. Let me know if the new terms work for you.",
    "Wed 14:30 — them: Terms are fine. One question left on the payment schedule.",
    "",
    "I want to see who said what at a glance, and have somewhere to write the reply.",
    "",
    // Closes the question the agent asked on 2026-08-16, and it was a GOOD
    // question: "answer from there" implies writing somewhere, and the message
    // gave it nowhere to write to. The case is about the SHAPE of the page, so
    // the data-home decision is settled in the prompt rather than left as an
    // ambiguity the case then scores as a failure.
    "Keep the messages in the page itself — nothing to save anywhere. The reply box is just a draft area, I copy it out and send it from my mail client.",
  ].join("\n"),
  tags: ["pages", "generation", "shape"],
  cleanup: cleanupPages,
  budget: {
    maxToolCalls: 16,
    expectedTools: ["searchTools", "buildPage", "managePage"],
  },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: pageTools },
    pageSaved(3),
    {
      type: "custom",
      name: "the-exchange-is-on-the-page",
      fn: async (_r, ctx) => {
        const page = await pageForConversation(ctx);
        if (!page) return "no page was saved";
        const text = definitionText(page.definition);
        // Both sides and a place to answer. Not which components: whether the
        // conversation and the reply both made it onto the screen.
        if (!/credit note|billed twice/i.test(text))
          return "the messages from the conversation are not in the page";
        if (
          !/<UTextarea|<UInput|<UChatPrompt|<UEditor/i.test(
            pageSource(page.definition),
          )
        )
          return "there is nowhere to write the reply the user asked for";
        return true;
      },
    },
    noFinalWarnings,
    rendersAndWorks,
    designIsAtLeastCompetent,
    {
      type: "judge",
      rubric:
        "The assistant built a page to follow a client conversation and reply from it, and reported it. CORRECT if it reports the page and describes both halves — reading the exchange and answering. PARTIAL if the page exists but the reply is vague, or only one half is mentioned. INCORRECT if no page was built, or it invented messages the prompt did not contain.",
    },
  ],
};

const consolePage: EvalCase = {
  id: "page-console-shape",
  description:
    "A queue to work through becomes a console — items on one side, the selected one and its actions on the other.",
  prompt: [
    "We get access requests from staff and they pile up in a spreadsheet. Build me something to work through them.",
    "",
    "Requests waiting — R-104 Marion Blay, finance folder, submitted 3 days ago, urgent. R-105 Tom Rey, design tools, 1 day ago, normal. R-106 Ines Gall, finance folder, 6 days ago, urgent. R-107 Karl Vidal, shared inbox, 2 days ago, low. R-108 Lea Fontan, design tools, today, normal. R-109 Omar Sy, admin console, 5 days ago, urgent.",
    "",
    "I want to open one, see everything about it, and approve or refuse it without leaving the page. And I should be able to see the oldest urgent ones first.",
    "",
    // Same closure as the thread case: the verbs imply persistence, the
    // message provides none, and the agent was right to notice. Settled here
    // so the case measures the console SHAPE and not the data-home decision.
    "Keep the requests in the page itself — deciding just marks the request on screen, nothing needs to be saved anywhere yet.",
  ].join("\n"),
  tags: ["pages", "generation", "shape", "interactivity"],
  cleanup: cleanupPages,
  budget: {
    maxToolCalls: 16,
    expectedTools: ["searchTools", "buildPage", "managePage"],
  },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: pageTools },
    pageSaved(4),
    {
      type: "custom",
      name: "the-queue-can-be-worked",
      fn: async (_r, ctx) => {
        const page = await pageForConversation(ctx);
        if (!page) return "no page was saved";
        const source = pageSource(page.definition);
        const text = definitionText(page.definition);
        if (!/R-10[4-9]/.test(text))
          return "the requests from the message are not in the page";
        // The two verbs the user named. A page that only lists them is the
        // failure this case is for.
        if (!/approve|approuv|refuse|refus|reject/i.test(source))
          return "neither approving nor refusing exists on the page — it only displays the queue";
        return true;
      },
    },
    noFinalWarnings,
    rendersAndWorks,
    designIsAtLeastCompetent,
    {
      type: "judge",
      rubric:
        "The assistant built a page to work through pending access requests and reported it. CORRECT if it reports the page and names both the ability to open a request in detail and to approve or refuse it, and the ordering by age/urgency. PARTIAL if the page exists but one of those is missing or unclear. INCORRECT if no page was built, or it invented requests the message did not contain.",
    },
  ],
};

const scheduledPage: EvalCase = {
  id: "page-time-shape",
  description:
    "Dated items laid out on the axis the work happens on — and the clash spotted, not just listed.",
  prompt: [
    "Here are next week's room bookings. Build me a page to see the week and catch the problems.",
    "",
    "Mon 9:00-10:30 Board room — quarterly review, 12 people. Mon 10:00-11:00 Board room — supplier call, 3 people. Mon 14:00-15:00 Small room — one-to-one, 2 people.",
    "Tue 9:30-12:00 Board room — training, 8 people. Wed 13:00-18:00 Small room — interviews, 2 people. Thu 11:00-12:00 Board room — all-hands rehearsal, 6 people. Fri 9:00-9:30 Small room — stand-up, 5 people.",
    "",
    "Two things are booked in the board room at the same time on Monday and nobody noticed. I want that to be obvious.",
    "",
    // Closes the same question its two siblings had closed on 2026-08-16 and
    // this one did not — an oversight, not a decision: the docblock above says
    // "all three carry their data in the message", but only `threadPage` and
    // `consolePage` got the sentence. On 2026-08-17 the agent asked, quite
    // reasonably, where next week's bookings should live, built nothing, and
    // five assertions failed for a defect in the prompt.
    "Keep the bookings in the page itself — nothing to save anywhere, I paste next week's in when I need it.",
  ].join("\n"),
  tags: ["pages", "generation", "shape"],
  cleanup: cleanupPages,
  budget: {
    maxToolCalls: 16,
    expectedTools: ["searchTools", "buildPage", "managePage"],
  },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: pageTools },
    pageSaved(3),
    {
      type: "custom",
      name: "the-clash-is-surfaced",
      fn: async (_r, ctx) => {
        const page = await pageForConversation(ctx);
        if (!page) return "no page was saved";
        const source = pageSource(page.definition);
        const text = definitionText(page.definition);
        if (!/quarterly review|supplier call/i.test(text))
          return "the bookings from the message are not in the page";
        // The user asked for the overlap to be OBVIOUS. Any of these is a
        // legitimate answer; none of them is the failure.
        if (!/conflict|clash|overlap|chevauch|conflit|double/i.test(source))
          return "the double booking is nowhere on the page — it lists the week without answering the question that was asked";
        return true;
      },
    },
    noFinalWarnings,
    rendersAndWorks,
    designIsAtLeastCompetent,
    {
      type: "judge",
      rubric:
        "The assistant built a page showing next week's room bookings and made the Monday double booking visible, then reported it. CORRECT if it reports the page and names the conflict it surfaces (two things in the board room at the same time on Monday). PARTIAL if the page exists but the conflict handling is vague or unmentioned. INCORRECT if no page was built, or it invented bookings the message did not contain.",
    },
  ],
};

export const pagesSuite: EvalSuite = {
  name: "pages",
  summary:
    "Chatbot-authored pages: live datasets grounded in the real schema, KPI/chart/table structure, wired filters, safe updates, and the two negatives (no page for a one-off question, no publishing without consent).",
  cases: [
    dashboard,
    filterableDirectory,
    updatePreservesRest,
    recoversFromStalePageId,
    noPageForOneOffQuestion,
    vagueRequestExpands,
    multiSourcePage,
    threadPage,
    consolePage,
    scheduledPage,
  ],
};
