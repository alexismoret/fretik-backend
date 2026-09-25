import db from "@fretik/shared/db";
import type {
  FieldDefinitionConfig,
  FieldDefinitionType,
} from "@fretik/shared/db/schema";
import {
  collectionRecords,
  NON_WRITABLE_FIELD_TYPES,
} from "@fretik/shared/db/schema";
import { createCollectionRecord } from "@fretik/shared/services/collection-records/create";
import {
  getCollectionRecord,
  listCollectionRecords,
} from "@fretik/shared/services/collection-records/retrieve";
import {
  qualifiedCollectionTable,
  SYS_COL,
} from "@fretik/shared/services/collection-schema/identifiers";
import { reconcileCollectionTable } from "@fretik/shared/services/collection-schema/table";
import { createCollection } from "@fretik/shared/services/collections/create";
import { deleteCollection } from "@fretik/shared/services/collections/delete";
import {
  invalidateCollectionIdCache,
  resolveCollectionId,
} from "@fretik/shared/services/collections/resolve";
import { invalidateFieldDefinitionsCache } from "@fretik/shared/services/field-definitions/cache";
import { createFieldDefinition } from "@fretik/shared/services/field-definitions/create";
import { getFieldDefinitionsForTeam } from "@fretik/shared/services/field-definitions/get-for-team";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Assertion, EvalCase, EvalCaseContext, EvalSuite } from "../types";

/**
 * Objects-autonomy suite (P8) — proves the agent manages the team's structured
 * records PROACTIVELY (act on a stated fact without being told to "create a
 * record"), PROPOSES structural changes instead of doing them silently, never
 * loses data on a partial update, AND — the load-bearing negative — leaves
 * objects alone on a turn that has nothing to do with them (the relevance gate).
 *
 * Cases grade on the tool TRAJECTORY (toolUsed / toolNotUsed) + a judge, since
 * the autonomy thesis is about WHICH surface fires WHEN. Mutating cases seed +
 * clean up idempotently on the shared eval team (system `company` for record
 * cases; a dedicated throwaway type for schema/update cases so cleanup is one
 * `deleteCollection`). Not smoke — needs the seeded eval ontology.
 */

const WRITE_TOOLS = [
  "manageRecord",
  "manageCollection",
  "manageField",
  "manageLink",
];

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Delete the team's records carrying these labels — across EVERY type, not just
 * `company`. The agent may file "a new client" under `client`, `company`, or any
 * fitting type, so a type-scoped cleanup would leak the record into the next run
 * (a leftover makes the agent rightly decline to duplicate, breaking the case).
 *
 * Match on the label AND on the full-text `search_vector`: a record whose type
 * has no `is_title` field lands with an EMPTY label but still carries the name
 * in a text column (hence in `search_vector`), so a label-only delete would miss
 * it and leak it forward. `search_vector` is built with the `simple` config.
 * Idempotent; used by both seed (clear leftovers up front) and cleanup.
 */
const cleanupLabels = async (
  ctx: EvalCaseContext,
  labels: string[],
): Promise<void> => {
  await db
    .delete(collectionRecords)
    .where(
      and(
        eq(collectionRecords.teamId, ctx.teamId),
        or(
          inArray(collectionRecords.label, labels),
          ...labels.map(
            (l) =>
              sql`${collectionRecords.searchVector} @@ plainto_tsquery('simple', ${l})`,
          ),
        ),
      ),
    );
};

/**
 * Retry a seed up to 3× on any throw. Type-creating seeds issue DDL
 * (CREATE/ALTER on `data.coll_…`) that can transiently race with the live AI
 * service's own object-table provisioning on the shared dev DB (a cross-process
 * race the per-run `--concurrency 1` can't serialize), surfacing as a one-off
 * "Collection not found". A short retry makes the seed deterministic.
 */
const retryingSeed =
  (fn: (ctx: EvalCaseContext) => Promise<void>) =>
  async (ctx: EvalCaseContext): Promise<void> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fn(ctx);
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 750));
      }
    }
    throw lastErr;
  };

/** Drop a throwaway seeded type (cascades its fields/records) — idempotent. */
const dropType = async (ctx: EvalCaseContext, key: string): Promise<void> => {
  // Bust the key→id cache FIRST: a prior cleanup may have left a stale id
  // cached, and resolving it would hand `deleteCollection` a dead id (→ 404).
  await invalidateCollectionIdCache({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    key,
  });
  const id = await resolveCollectionId({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    key,
  });
  if (id) await deleteCollection({ id });
};

// ── Case 1: explicit create ──────────────────────────────────────────────────

const ALPHA = "Eval Autonomy Alpha";

const explicitCreate: EvalCase = {
  id: "obj-explicit-create",
  description: "Explicit 'add a company' → manageRecord create.",
  prompt: `Add a new company to our records: "${ALPHA}".`,
  tags: ["objects", "autonomy"],
  seed: (ctx) => cleanupLabels(ctx, [ALPHA]),
  cleanup: (ctx) => cleanupLabels(ctx, [ALPHA]),
  budget: { expectedTools: ["manageRecord", "searchTools"] },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["manageRecord"] },
    {
      type: "judge",
      rubric: `Correct ONLY IF the assistant created a company record named "${ALPHA}" (via the manageRecord tool) and confirmed it back in plain language. Incorrect if it only described how to add one, asked a needless clarifying question, or created the wrong type.`,
    },
  ],
};

// ── Case 2: implicit create (autonomy) ───────────────────────────────────────

const BETA = "Eval Autonomy Beta";

const implicitCreate: EvalCase = {
  id: "obj-implicit-create",
  description:
    "A fact dropped in passing → proactively persist a record, unprompted.",
  prompt: `Quick update from a call I just had — ${BETA} is a new client of ours as of today.`,
  tags: ["objects", "autonomy", "implicit"],
  seed: (ctx) => cleanupLabels(ctx, [BETA]),
  cleanup: (ctx) => cleanupLabels(ctx, [BETA]),
  budget: { expectedTools: ["manageRecord", "searchTools", "askUserQuestion"] },
  assertions: [
    { type: "noError" },
    // The fact must be ACTED ON, not just acknowledged. On a team with several
    // client-like types, either persisting the record or asking which type to
    // file it under is correct autonomy — only ignoring it conversationally fails.
    {
      type: "toolUsed",
      tools: ["manageRecord", "askUserQuestion"],
      mode: "any",
    },
    {
      type: "judge",
      rubric: `The user did NOT explicitly ask to "create a record" — they stated a fact (a new client). Correct IF the assistant ACTED on it: either (a) proactively created/updated a record for "${BETA}" via manageRecord, or (b) — when the team has several client-like types and the right one is genuinely ambiguous — proposed creating it / asked which type to file it under. Incorrect ONLY if it merely acknowledged the message conversationally and persisted/proposed nothing.`,
    },
  ],
};

// ── Case 3: relevance gate (the load-bearing negative) ───────────────────────

const relevanceGate: EvalCase = {
  id: "obj-relevance-gate",
  description:
    "Unrelated general question → must NOT touch objects (no over-reach).",
  prompt:
    "In two short bullet points, what are the main trade-offs between asynchronous and synchronous communication for a distributed team?",
  tags: ["objects", "relevance-gate", "negative"],
  budget: { maxToolCalls: 1 },
  assertions: [
    { type: "noError" },
    { type: "toolNotUsed", tools: WRITE_TOOLS },
    {
      type: "judge",
      rubric:
        "Correct ONLY IF the assistant answered the general question directly (two bullet points on async vs sync trade-offs) and did NOT create, update, or propose any object/type/field. Touching the team's structured data here is over-reach and is incorrect.",
    },
  ],
};

// ── Case 4: propose schema, don't act silently ───────────────────────────────

const ACCOUNT_KEY = "eval_autonomy_account";

const proposeSchema: EvalCase = {
  id: "obj-propose-schema",
  description:
    "Vague 'start tracking X' → propose adding a field (or add it), not ignore.",
  prompt: `I'd like to start keeping track of each ${ACCOUNT_KEY} record's annual revenue.`,
  tags: ["objects", "autonomy", "schema"],
  seed: async (ctx) => {
    await dropType(ctx, ACCOUNT_KEY);
    const type = await createCollection({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      key: ACCOUNT_KEY,
      label: "Eval Autonomy Account",
    });
    await createFieldDefinition({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      collectionId: type.id,
      key: "name",
      label: "Name",
      type: "text",
      isTitle: true,
      displayOrder: 0,
    });
    await reconcileCollectionTable({ collectionId: type.id });
  },
  cleanup: (ctx) => dropType(ctx, ACCOUNT_KEY),
  assertions: [
    { type: "noError" },
    // Either path is acceptable autonomy: propose via askUserQuestion, or add
    // the field directly. Silently ignoring it is the failure.
    {
      type: "toolUsed",
      tools: ["askUserQuestion", "manageField", "manageCollection"],
      mode: "any",
    },
    {
      type: "judge",
      rubric: `Correct ONLY IF the assistant recognised this needs a new numeric/money "annual revenue" field on the ${ACCOUNT_KEY} type and either (a) proposed adding it (e.g. via askUserQuestion) or (b) added it via manageField. Incorrect if it ignored the structural intent, answered as if revenue were already a field, or created an unrelated record.`,
    },
  ],
};

// ── Case 5: partial update is read-modify-write (no data loss) ───────────────

const CONTACT_KEY = "eval_autonomy_contact";
const DELTA = "Eval Autonomy Delta";
const NEW_PHONE = "+33611223344";

const partialUpdate: EvalCase = {
  id: "obj-partial-update-no-data-loss",
  description:
    "Update one field on a multi-field record → other fields must survive.",
  prompt: `Update the phone number of the ${CONTACT_KEY} "${DELTA}" to ${NEW_PHONE}.`,
  tags: ["objects", "autonomy", "data-loss"],
  seed: async (ctx) => {
    await dropType(ctx, CONTACT_KEY);
    const type = await createCollection({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      key: CONTACT_KEY,
      label: "Eval Autonomy Contact",
    });
    const fields: { key: string; type: "text"; isTitle?: boolean }[] = [
      { key: "name", type: "text", isTitle: true },
      { key: "phone", type: "text" },
      { key: "city", type: "text" },
    ];
    for (const [i, f] of fields.entries()) {
      await createFieldDefinition({
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        collectionId: type.id,
        key: f.key,
        label: f.key,
        type: f.type,
        isTitle: f.isTitle,
        displayOrder: i,
      });
    }
    await reconcileCollectionTable({ collectionId: type.id });
    await createCollectionRecord({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      collectionId: type.id,
      data: { name: DELTA, phone: "+33100000000", city: "Paris" },
    });
  },
  cleanup: (ctx) => dropType(ctx, CONTACT_KEY),
  budget: { expectedTools: ["manageRecord", "getRecord", "searchTools"] },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["manageRecord"] },
    {
      type: "custom",
      name: "city-field-survived",
      fn: async (_result, ctx) => {
        const typeId = await resolveCollectionId({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          key: CONTACT_KEY,
        });
        if (!typeId) return "contact type missing after run";
        const rows = await db
          .select({ id: collectionRecords.id })
          .from(collectionRecords)
          .where(
            and(
              eq(collectionRecords.teamId, ctx.teamId),
              eq(collectionRecords.collectionId, typeId),
              eq(collectionRecords.label, DELTA),
            ),
          );
        const id = rows[0]?.id;
        if (!id) return "contact record not found after run";
        const rec = await getCollectionRecord({
          id,
          teamId: ctx.teamId,
          organizationId: ctx.organizationId,
        });
        if (rec.data.phone !== NEW_PHONE)
          return `phone not updated: ${JSON.stringify(rec.data)}`;
        if (rec.data.city !== "Paris")
          return `city was cleared — partial update overwrote other fields (data loss): ${JSON.stringify(rec.data)}`;
        return true;
      },
    },
  ],
};

// ── Case 6: rich create — every coercion-sensitive field type, zero errors ───

const ACCOUNT_RICH_KEY = "eval_rich_account";
const RICH_NAME = "Northwind Trading";

/** Seed a type whose fields exercise every value-coercion path. */
const seedRichType = async (ctx: EvalCaseContext): Promise<void> => {
  await dropType(ctx, ACCOUNT_RICH_KEY);
  const type = await createCollection({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    key: ACCOUNT_RICH_KEY,
    label: "Eval Rich Account",
  });
  const fields: {
    key: string;
    type: FieldDefinitionType;
    isTitle?: boolean;
    config?: FieldDefinitionConfig;
  }[] = [
    { key: "name", type: "text", isTitle: true },
    { key: "website", type: "url" },
    { key: "headcount", type: "number" },
    { key: "signed_on", type: "date" },
    { key: "last_contact", type: "date", config: { hasTime: true } },
    {
      key: "annual_value",
      type: "money",
      config: { defaultCurrencyCode: "EUR" },
    },
    {
      key: "tier",
      type: "select",
      config: {
        options: [
          { value: "bronze", label: "Bronze" },
          { value: "silver", label: "Silver" },
          { value: "gold", label: "Gold" },
        ],
      },
    },
    { key: "active", type: "boolean" },
    { key: "phone", type: "phone" },
    { key: "priority", type: "rating", config: { ratingMax: 5 } },
    {
      key: "regions",
      type: "multi_select",
      config: {
        options: [
          { value: "emea", label: "EMEA" },
          { value: "amer", label: "AMER" },
          { value: "apac", label: "APAC" },
        ],
      },
    },
  ];
  for (const [i, f] of fields.entries()) {
    await createFieldDefinition({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      collectionId: type.id,
      key: f.key,
      label: f.key,
      type: f.type,
      isTitle: f.isTitle,
      config: f.config,
      displayOrder: i,
    });
  }
  await reconcileCollectionTable({ collectionId: type.id });
};

const richCreate: EvalCase = {
  id: "obj-rich-create",
  description:
    "Create a record across many field types from natural-language values → every value coerces, zero tool errors.",
  // Values are deliberately phrased the way a user speaks (scheme-less site,
  // a label not a slug for the tier, plain-language regions, a date for a
  // datetime, an amount with a currency word) — coercion must absorb all of it.
  prompt: `Add an account to our records: ${RICH_NAME}. Website northwind.example, 320 people, signed on 2026-03-15, last contact on 2026-06-27, annual value 75000 euros, Gold tier, it's active, phone +33145678901, priority 4 out of 5, regions EMEA and APAC.`,
  tags: ["objects", "coercion", "data-quality"],
  seed: retryingSeed(seedRichType),
  cleanup: (ctx) => dropType(ctx, ACCOUNT_RICH_KEY),
  budget: {
    expectedTools: ["manageRecord", "describeCollection", "searchTools"],
  },
  assertions: [
    // The headline guarantee: not a single tool error on a rich create.
    { type: "noError" },
    { type: "toolUsed", tools: ["manageRecord"] },
    {
      type: "custom",
      name: "values-coerced-correctly",
      fn: async (_result, ctx) => {
        const typeId = await resolveCollectionId({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          key: ACCOUNT_RICH_KEY,
        });
        if (!typeId) return "rich type missing after run";
        const rows = await db
          .select({ id: collectionRecords.id })
          .from(collectionRecords)
          .where(
            and(
              eq(collectionRecords.teamId, ctx.teamId),
              eq(collectionRecords.collectionId, typeId),
              eq(collectionRecords.label, RICH_NAME),
            ),
          );
        const id = rows[0]?.id;
        if (!id) return "account record not found after run";
        const d = (
          await getCollectionRecord({
            id,
            teamId: ctx.teamId,
            organizationId: ctx.organizationId,
          })
        ).data;
        const fail = (m: string) => `${m} — got ${JSON.stringify(d)}`;
        // select: a human label ("Gold") must land on the option value.
        if (d.tier !== "gold") return fail("tier not coerced to 'gold'");
        // boolean from prose.
        if (d.active !== true) return fail("active not true");
        // date stays a calendar day.
        if (d.signed_on !== "2026-03-15") return fail("signed_on wrong");
        // datetime: stored on the right day. Read back from the timestamptz
        // column it renders in Postgres JSON form (`…+00:00`), not the input's
        // `…Z` — both are valid, so assert the calendar day only.
        if (
          typeof d.last_contact !== "string" ||
          !d.last_contact.startsWith("2026-06-27")
        )
          return fail("last_contact not on 2026-06-27");
        // multi_select: prose labels mapped to option values.
        const regions = Array.isArray(d.regions) ? d.regions : [];
        if (!regions.includes("emea") || !regions.includes("apac"))
          return fail("regions not coerced to [emea, apac]");
        // url: a scheme-less host gained https://.
        if (typeof d.website !== "string" || !/^https?:\/\//.test(d.website))
          return fail("website missing scheme");
        // rating: a plain number from "4 out of 5".
        if (Number(d.priority) !== 4) return fail("priority not coerced to 4");
        // number + money survived as their typed values.
        if (Number(d.headcount) !== 320) return fail("headcount wrong");
        const money = d.annual_value;
        if (
          typeof money !== "object" ||
          money === null ||
          (money as { amount?: number }).amount !== 75000
        )
          return fail("annual_value not parsed to money");
        return true;
      },
    },
  ],
};

// ── Case 7: bulk import — parse a long CSV and integrate every row ────────────

const LEAD_KEY = "eval_bulk_lead";

/** 22 rows of leads — enough to push the agent onto the bulk path, not a loop. */
const LEADS_CSV = `name,email,company,phone,signup_date,plan
Ada Lovelace,ada@analytical.io,Analytical Engines,+44 20 7946 0001,2025-01-04,Pro
Alan Turing,alan@enigma.uk,Enigma Labs,+44 20 7946 0002,2025-01-05,Enterprise
Grace Hopper,grace@cobol.mil,Cobol Systems,+1 202 555 0103,2025-01-06,Pro
Katherine Johnson,kj@orbit.space,Orbit Dynamics,+1 202 555 0104,2025-01-07,Free
Margaret Hamilton,mh@apollo.space,Apollo Guidance,+1 202 555 0105,2025-01-08,Enterprise
Dennis Ritchie,dmr@bell.labs,Bell Works,+1 908 555 0106,2025-01-09,Pro
Ken Thompson,ken@unix.org,Unix Foundry,+1 908 555 0107,2025-01-10,Pro
Barbara Liskov,liskov@types.edu,Type Theory Co,+1 617 555 0108,2025-01-11,Free
Donald Knuth,knuth@tex.org,TeX Press,+1 650 555 0109,2025-01-12,Enterprise
Edsger Dijkstra,ewd@graphs.nl,Shortest Path BV,+31 20 555 0110,2025-01-13,Pro
Tim Berners-Lee,tbl@web.org,Web Weavers,+44 20 7946 0011,2025-01-14,Enterprise
Vint Cerf,vint@tcp.ip,Packet Pioneers,+1 703 555 0112,2025-01-15,Pro
Radia Perlman,radia@spanning.tree,Bridge Networks,+1 781 555 0113,2025-01-16,Free
Leslie Lamport,lamport@latex.org,Consensus Inc,+1 415 555 0114,2025-01-17,Enterprise
Frances Allen,fran@optimize.ibm,Compiler Crafters,+1 914 555 0115,2025-01-18,Pro
John McCarthy,jmc@lisp.ai,Symbolic Minds,+1 650 555 0116,2025-01-19,Pro
Marvin Minsky,minsky@ai.mit,Perceptron Partners,+1 617 555 0117,2025-01-20,Free
Claude Shannon,shannon@entropy.bit,Signal & Noise,+1 201 555 0118,2025-01-21,Enterprise
Doug Engelbart,doug@mouse.dev,Augment Co,+1 650 555 0119,2025-01-22,Pro
Alan Kay,kay@smalltalk.dev,Dynabook Labs,+1 650 555 0120,2025-01-23,Enterprise
Bjarne Stroustrup,bjarne@plusplus.dev,Template Works,+45 33 555 0121,2025-01-24,Pro
Linus Torvalds,linus@kernel.org,Kernel Collective,+358 9 555 0122,2025-01-25,Free`;

const LEAD_ROWS = LEADS_CSV.trim().split("\n").length - 1;

const bulkCsvImport: EvalCase = {
  id: "obj-bulk-csv-import",
  description:
    "A non-technical user dumps a long CSV → parse it and integrate every row as a record, no errors.",
  // Deliberately casual and underspecified — the user just wants them "in the system".
  prompt: `hey so i just got back from a conference and grabbed a bunch of leads, can u stick them all into our system as ${LEAD_KEY} records so the team can follow up? heres the list:\n\n${LEADS_CSV}`,
  tags: ["objects", "bulk", "data-volume"],
  seed: retryingSeed(async (ctx) => {
    await dropType(ctx, LEAD_KEY);
    const type = await createCollection({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      key: LEAD_KEY,
      label: "Eval Bulk Lead",
    });
    const fields: {
      key: string;
      type: FieldDefinitionType;
      isTitle?: boolean;
      config?: FieldDefinitionConfig;
    }[] = [
      { key: "name", type: "text", isTitle: true },
      { key: "email", type: "email" },
      { key: "company", type: "text" },
      { key: "phone", type: "phone" },
      { key: "signup_date", type: "date" },
      {
        key: "plan",
        type: "select",
        config: {
          options: [
            { value: "free", label: "Free" },
            { value: "pro", label: "Pro" },
            { value: "enterprise", label: "Enterprise" },
          ],
        },
      },
    ];
    for (const [i, f] of fields.entries()) {
      await createFieldDefinition({
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        collectionId: type.id,
        key: f.key,
        label: f.key,
        type: f.type,
        isTitle: f.isTitle,
        config: f.config,
        displayOrder: i,
      });
    }
    await reconcileCollectionTable({ collectionId: type.id });
  }),
  cleanup: (ctx) => dropType(ctx, LEAD_KEY),
  budget: {
    expectedTools: [
      "manageRecord",
      "describeCollection",
      "searchTools",
      "python",
      "bash",
      "read",
    ],
  },
  assertions: [
    { type: "noError" },
    {
      type: "custom",
      name: "all-rows-integrated",
      fn: async (_result, ctx) => {
        const typeId = await resolveCollectionId({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          key: LEAD_KEY,
        });
        if (!typeId) return "lead type missing after run";
        const rows = await db
          .select({ id: collectionRecords.id })
          .from(collectionRecords)
          .where(
            and(
              eq(collectionRecords.teamId, ctx.teamId),
              eq(collectionRecords.collectionId, typeId),
            ),
          );
        if (rows.length < LEAD_ROWS)
          return `only ${rows.length}/${LEAD_ROWS} leads integrated`;
        // Spot-check one row: the select label coerced + the date kept.
        const ada = await db
          .select({ id: collectionRecords.id })
          .from(collectionRecords)
          .where(
            and(
              eq(collectionRecords.teamId, ctx.teamId),
              eq(collectionRecords.collectionId, typeId),
              eq(collectionRecords.label, "Ada Lovelace"),
            ),
          );
        const id = ada[0]?.id;
        if (!id) return "Ada Lovelace not found";
        const d = (
          await getCollectionRecord({
            id,
            teamId: ctx.teamId,
            organizationId: ctx.organizationId,
          })
        ).data;
        if (d.plan !== "pro")
          return `plan not coerced to option value: ${JSON.stringify(d)}`;
        if (d.signup_date !== "2025-01-04")
          return `signup_date wrong: ${JSON.stringify(d)}`;
        return true;
      },
    },
  ],
};

// ── Case 8: complex read — query records, hand back a CSV ─────────────────────

const SALE_KEY = "eval_report_sale";

const salesRow = (
  name: string,
  region: string,
  amount: number,
  closed: boolean,
) => ({ name, region, amount, closed });

const SALES = [
  salesRow("Orbit Telemetry", "emea", 12000, true),
  salesRow("Quantum Ledger", "emea", 4000, false),
  salesRow("Tidal Compute", "amer", 30000, true),
  salesRow("Harbor Analytics", "amer", 8000, true),
  salesRow("Summit Robotics", "apac", 15000, false),
  salesRow("Cobalt Storage", "apac", 22000, true),
  salesRow("Meridian Cloud", "emea", 9000, true),
  salesRow("Vertex Security", "amer", 17000, false),
  salesRow("Lumen Data", "apac", 6000, true),
  salesRow("Atlas Logistics", "emea", 25000, true),
  salesRow("Pulse Mobility", "amer", 5000, true),
  salesRow("Nimbus Mail", "apac", 11000, false),
];

const sqlToCsv: EvalCase = {
  id: "obj-sql-to-csv",
  description:
    "A vague 'give me a spreadsheet' → complex SQL over records, returned as CSV.",
  // Non-technical phrasing; the user wants closed deals, by region, as a file.
  prompt: `can u pull together all the ${SALE_KEY} deals we actually won (not the ones still open) and tell me the total amount per region? i'd love it as a little csv table i can paste into excel, biggest region first pls`,
  tags: ["objects", "sql", "export"],
  seed: retryingSeed(async (ctx) => {
    await dropType(ctx, SALE_KEY);
    const type = await createCollection({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      key: SALE_KEY,
      label: "Eval Report Sale",
    });
    const fields: {
      key: string;
      type: FieldDefinitionType;
      isTitle?: boolean;
      config?: FieldDefinitionConfig;
    }[] = [
      { key: "name", type: "text", isTitle: true },
      {
        key: "region",
        type: "select",
        config: {
          options: [
            { value: "emea", label: "EMEA" },
            { value: "amer", label: "AMER" },
            { value: "apac", label: "APAC" },
          ],
        },
      },
      { key: "amount", type: "number" },
      { key: "closed", type: "boolean" },
    ];
    for (const [i, f] of fields.entries()) {
      await createFieldDefinition({
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        collectionId: type.id,
        key: f.key,
        label: f.key,
        type: f.type,
        isTitle: f.isTitle,
        config: f.config,
        displayOrder: i,
      });
    }
    await reconcileCollectionTable({ collectionId: type.id });
    for (const s of SALES) {
      await createCollectionRecord({
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        collectionId: type.id,
        data: s,
      });
    }
  }),
  cleanup: (ctx) => dropType(ctx, SALE_KEY),
  budget: {
    expectedTools: [
      "querySql",
      "describeCollection",
      "searchTools",
      "python",
      "read",
    ],
  },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["querySql"] },
    {
      type: "judge",
      // Closed totals: EMEA 12000+9000+25000=46000, AMER 30000+8000+5000=43000,
      // APAC 22000+6000=28000 — EMEA first.
      rubric:
        "Correct ONLY IF the assistant queried the sales records (querySql over the type's data.coll_… table), restricted to WON/closed deals (excluding open ones), summed the amount per region, and returned the result as a CSV table the user could paste into a spreadsheet, ordered with the largest region total first (EMEA ≈ 46000, then AMER ≈ 43000, then APAC ≈ 28000). Incorrect if it included open deals, failed to aggregate by region, or did not present a CSV.",
    },
  ],
};

// ── Case 9: location field — address → geocoded FK, zero errors ───────────────

const PLACE_KEY = "eval_location_place";
const PLACE_NAME = "Eval North Office";
const PLACE_ADDRESS = "1600 Amphitheatre Parkway, Mountain View, CA";

const locationCreate: EvalCase = {
  id: "obj-location-create",
  description:
    "Create a record with a location field from a natural-language address → the address is stored (geocoded to a per-team locations row), other fields survive, zero tool errors.",
  // A location value is written as a plain address STRING; coercion wraps it and
  // the server geocodes it into the `locations` table (FK on the typed column).
  prompt: `Add a ${PLACE_KEY} to our records: "${PLACE_NAME}", located at ${PLACE_ADDRESS}. Add a note: main regional office.`,
  tags: ["objects", "location", "field-types"],
  seed: retryingSeed(async (ctx) => {
    await dropType(ctx, PLACE_KEY);
    const type = await createCollection({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      key: PLACE_KEY,
      label: "Eval Location Place",
    });
    const fields: {
      key: string;
      type: FieldDefinitionType;
      isTitle?: boolean;
    }[] = [
      { key: "name", type: "text", isTitle: true },
      { key: "location", type: "location" },
      { key: "note", type: "text" },
    ];
    for (const [i, f] of fields.entries()) {
      await createFieldDefinition({
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        collectionId: type.id,
        key: f.key,
        label: f.key,
        type: f.type,
        isTitle: f.isTitle,
        displayOrder: i,
      });
    }
    await reconcileCollectionTable({ collectionId: type.id });
  }),
  cleanup: (ctx) => dropType(ctx, PLACE_KEY),
  budget: {
    expectedTools: ["manageRecord", "describeCollection", "searchTools"],
  },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["manageRecord"] },
    {
      type: "custom",
      name: "location-address-stored-and-note-survived",
      // Coords depend on a live Mapbox call (best-effort), so assert only that
      // the address landed on the location field and the other field survived.
      fn: async (_result, ctx) => {
        const typeId = await resolveCollectionId({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          key: PLACE_KEY,
        });
        if (!typeId) return "place type missing after run";
        const rows = await db
          .select({ id: collectionRecords.id })
          .from(collectionRecords)
          .where(
            and(
              eq(collectionRecords.teamId, ctx.teamId),
              eq(collectionRecords.collectionId, typeId),
              eq(collectionRecords.label, PLACE_NAME),
            ),
          );
        const id = rows[0]?.id;
        if (!id) return "place record not found after run";
        const d = (
          await getCollectionRecord({
            id,
            teamId: ctx.teamId,
            organizationId: ctx.organizationId,
          })
        ).data;
        const loc = d.location;
        const address =
          typeof loc === "object" && loc !== null
            ? (loc as { address?: unknown }).address
            : undefined;
        if (typeof address !== "string" || address.length === 0)
          return `location address not stored: ${JSON.stringify(d)}`;
        if (typeof d.note !== "string" || d.note.length === 0)
          return `note not preserved alongside location: ${JSON.stringify(d)}`;
        return true;
      },
    },
  ],
};

// ── Cases 10-12: the computed column — pick it, don't pick it, don't write it ─

const FORMULA_KEY = "eval_formula_deal";
const F_ALPHA = "Eval Formula Alpha";
const F_BETA = "Eval Formula Beta";

/**
 * Two numeric fields and two records whose margins order DIFFERENTLY under a
 * numeric and a text comparison: 600 and 1200. Sorted as numbers, Beta leads;
 * sorted as text, "600" leads. A fixture where both orders agree would let a
 * column compared as text pass the sort assertion — the exact defect measured in
 * `field-filter.ts`, where `1500 > 500` came back false.
 */
const seedFormulaType = async (
  ctx: EvalCaseContext,
  withMargin: boolean,
): Promise<void> => {
  await dropType(ctx, FORMULA_KEY);
  const type = await createCollection({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    key: FORMULA_KEY,
    label: "Eval Formula Deal",
  });
  const fields: {
    key: string;
    type: FieldDefinitionType;
    isTitle?: boolean;
    config?: FieldDefinitionConfig;
  }[] = [
    { key: "name", type: "text", isTitle: true },
    { key: "revenue", type: "number" },
    { key: "cost", type: "number" },
  ];
  if (withMargin) {
    fields.push({
      key: "margin",
      type: "formula",
      config: { expression: "revenue - cost" },
    });
  }
  for (const [i, f] of fields.entries()) {
    await createFieldDefinition({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      collectionId: type.id,
      key: f.key,
      label: f.key,
      type: f.type,
      isTitle: f.isTitle,
      config: f.config,
      displayOrder: i,
    });
  }
  await reconcileCollectionTable({ collectionId: type.id });
  for (const row of [
    { name: F_ALPHA, revenue: 1000, cost: 400 },
    { name: F_BETA, revenue: 5000, cost: 3800 },
  ]) {
    await createCollectionRecord({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      collectionId: type.id,
      data: row,
    });
  }
};

/** The type's fields, minus the three the seed always creates. */
const addedFields = async (ctx: EvalCaseContext, seeded: string[]) => {
  const typeId = await resolveCollectionId({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    key: FORMULA_KEY,
  });
  if (!typeId) return undefined;
  const all = await getFieldDefinitionsForTeam({
    teamId: ctx.teamId,
    collectionId: typeId,
    includeDisabled: true,
  });
  return { typeId, added: all.filter((f) => !seeded.includes(f.key)) };
};

const formulaMargin: EvalCase = {
  id: "obj-formula-margin",
  description:
    "'A margin column I can sort on' → a computed formula field, not a stored column the team would have to maintain.",
  prompt: `On the ${FORMULA_KEY} type, add a margin column that is revenue minus cost. I want to be able to sort the table on it.`,
  tags: ["objects", "schema", "formula"],
  seed: retryingSeed((ctx) => seedFormulaType(ctx, false)),
  cleanup: (ctx) => dropType(ctx, FORMULA_KEY),
  budget: {
    expectedTools: ["manageField", "describeCollection", "searchTools"],
  },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["manageField"] },
    {
      type: "custom",
      name: "margin-is-a-computed-column-that-sorts",
      fn: async (_result, ctx) => {
        const found = await addedFields(ctx, ["name", "revenue", "cost"]);
        if (!found) return "formula type missing after run";
        const margin = found.added.find((f) => f.type === "formula");
        if (!margin) {
          const kinds = found.added.map((f) => `${f.key}:${f.type}`).join(", ");
          return `no formula field was created — added instead: ${kinds || "nothing"}`;
        }
        // The value must arrive as a NUMBER, not the string a `numeric` column
        // returns — the measured rollup trap the `double precision` choice
        // exists to avoid.
        const rows = await db
          .select({ id: collectionRecords.id })
          .from(collectionRecords)
          .where(
            and(
              eq(collectionRecords.teamId, ctx.teamId),
              eq(collectionRecords.collectionId, found.typeId),
              eq(collectionRecords.label, F_ALPHA),
            ),
          );
        const id = rows[0]?.id;
        if (!id) return "alpha record not found after run";
        const value = (
          await getCollectionRecord({
            id,
            teamId: ctx.teamId,
            organizationId: ctx.organizationId,
          })
        ).data[margin.key];
        if (value !== 600)
          return `margin computed as ${JSON.stringify(value)}, expected the number 600`;
        // What the user actually asked for: the SERVER orders on it. A column
        // compared as text would put 600 ahead of 1200.
        const listed = await listCollectionRecords({
          teamId: ctx.teamId,
          collectionId: found.typeId,
          sortBy: `field:${margin.key}`,
          sortDir: "desc",
          limit: 2,
        });
        const first = listed.data[0]?.label;
        if (first !== F_BETA)
          return `sorting on the formula put "${String(first)}" first — expected "${F_BETA}" (1200 before 600)`;
        return true;
      },
    },
    {
      type: "judge",
      rubric:
        "Correct ONLY IF the assistant added the margin column itself and presented it as computed/automatic. Incorrect if it told the user to maintain the value by hand, to compute it in a page or spreadsheet, or asked them to fill it in per record.",
    },
  ],
};

const formulaDiscrimination: EvalCase = {
  id: "obj-formula-not-for-entered-values",
  description:
    "The anti-case: a field people TYPE INTO must not become a computed column.",
  prompt: `On the ${FORMULA_KEY} type, add a notes field where we can jot down anything about a deal.`,
  tags: ["objects", "schema", "formula"],
  seed: retryingSeed((ctx) => seedFormulaType(ctx, false)),
  cleanup: (ctx) => dropType(ctx, FORMULA_KEY),
  budget: {
    expectedTools: ["manageField", "describeCollection", "searchTools"],
  },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["manageField"] },
    {
      type: "custom",
      name: "notes-is-writable",
      fn: async (_result, ctx) => {
        const found = await addedFields(ctx, ["name", "revenue", "cost"]);
        if (!found) return "formula type missing after run";
        const notes = found.added[0];
        if (!notes) return "no field was added";
        // A formula here would produce a column nobody can ever type into —
        // the field would look present and silently discard every write.
        if (NON_WRITABLE_FIELD_TYPES.has(notes.type))
          return `notes was created as '${notes.type}', which no one can write to`;
        return true;
      },
    },
  ],
};

const formulaReadOnly: EvalCase = {
  id: "obj-formula-is-read-only",
  description:
    "Writing to a computed column: the value must not change, and the assistant must not claim it did.",
  prompt: `Set the margin of "${F_ALPHA}" in ${FORMULA_KEY} to 9999.`,
  tags: ["objects", "formula", "data-quality"],
  seed: retryingSeed((ctx) => seedFormulaType(ctx, true)),
  cleanup: (ctx) => dropType(ctx, FORMULA_KEY),
  assertions: [
    { type: "noError" },
    {
      type: "custom",
      name: "margin-was-not-written",
      fn: async (_result, ctx) => {
        const typeId = await resolveCollectionId({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          key: FORMULA_KEY,
        });
        if (!typeId) return "formula type missing after run";
        const rows = await db
          .select({ id: collectionRecords.id })
          .from(collectionRecords)
          .where(
            and(
              eq(collectionRecords.teamId, ctx.teamId),
              eq(collectionRecords.collectionId, typeId),
              eq(collectionRecords.label, F_ALPHA),
            ),
          );
        const id = rows[0]?.id;
        if (!id) return "alpha record not found after run";
        const d = (
          await getCollectionRecord({
            id,
            teamId: ctx.teamId,
            organizationId: ctx.organizationId,
          })
        ).data;
        if (d.margin !== 600)
          return `margin is ${JSON.stringify(d.margin)} — the computed column was corrupted`;
        if (d.revenue !== 1000 || d.cost !== 400)
          return `the inputs were rewritten to force the number: ${JSON.stringify(d)}`;
        return true;
      },
    },
    // The write is STRIPPED rather than refused (the same silent contract as
    // relation/rollup), so nothing in the tool result tells the assistant it
    // failed. What it CAN do is read the schema first — `describeCollection`
    // names margin as a formula. Reporting a success that never happened is
    // the user-facing harm this case measures.
    {
      type: "judge",
      rubric:
        "Correct ONLY IF the assistant recognised that margin is a computed / read-only column and said its value cannot be set directly — ideally offering to change revenue or cost instead. Incorrect if it stated or implied that the margin is now 9999.",
    },
  ],
};

// ── A collection an app fills ───────────────────────────────────────────────
//
// Four things the agent has to know about a synced collection, none of which it
// can work out from the rows: the figures have an AGE, the columns are not its
// to write, a stale one is refreshed rather than apologised for, and a table
// the team keeps in another system is a sync rather than a workflow or a CSV.
//
// The source's `last_success_at` is set by hand, because three of these cases
// turn on how OLD the data is and a run that stamped itself would make that age
// depend on when the suite happened to execute.
//
// THE APP ANSWERS, and getting there took three wrong fixtures. The first
// invented a provider key (`eval-orders`) the registry had never heard of: no
// manifest, so no description, no action catalogue and no `skills/<key>/SKILL.md`
// in the sandbox, and `resolveSyncAction` refused every operation. The second
// pointed at a real provider with no Nango binding, so the executor refused with
// an INVARIANT message that reads like a bug. The third gave it a binding Nango
// does not hold, so every call came back 404. Each refusal reached the agent as
// a DIFFERENT kind of failure, it improvised differently against each, and five
// of the nine cases changed verdict between runs (2026-09-20).
//
// A fixture that cannot answer cannot test what an agent does with an answer.
// So the connections below point at `eval-fixture`, a `testOnly` provider whose
// handlers serve fixed rows from memory: the suite exercises the real
// catalogue, the real SKILL, the real walker, the real governor and the real
// diff, reaches no network, and stays hermetic. Its rows are chosen to line up
// with what is seeded here — see `providers/src/eval-fixture/data.ts`.
//
// Two CONNECTIONS of that one provider, not two providers: `obj-sync-second-app`
// needs two apps on one collection, and two connections is what a team actually
// has. The display names are what the rubrics quote and what cleanup keys on.

const SYNC_KEY = "eval_sync_orders";
const SYNC_APP = "Eval Orders App";
const SYNC_AGE_HOURS = 30;

/**
 * The app that OWNS the collection's rows.
 *
 * `list_orders` is paginated and declares `incremental`, and `get_order` reads
 * one record — the pair `obj-sync-columns-by-list` and `obj-sync-second-app`
 * need the agent to choose between. A provider offering only a list would
 * decide that choice for it.
 */
const SYNC_PROVIDER = "eval-fixture";
const SYNC_OPERATION = "list_orders";

/**
 * Every case below carries this, and it is on ALL of them rather than on the
 * two that once ran away — because the one that ran away next was neither.
 *
 * Measured 2026-09-20 over the nine: a healthy trajectory here is 1, 4, 6, 7,
 * 8, 16, 22 or 30 calls. In the same run `obj-sync-workflow-reads-collection`
 * issued **1 394**, of which 1 382 were refused unexecuted by the per-step call
 * cap — and scored `correctness: 1.000`, because its answer was right and
 * nothing in the suite looked at the trajectory. A judge grades the destination;
 * this grades the road, and a suite that grades only the destination will call
 * a turn healthy right up until it times out.
 *
 * Forty is far above every healthy trajectory measured and far below a runaway,
 * so it can only catch the pathology it is named for. It is an EVAL lever, not
 * a product one: nothing about the model's output ceiling changes.
 */
const SYNC_CALL_CAP: Assertion = { type: "toolCallsUnder", max: 40 };

/**
 * The credential-less connection every sync case hangs off, inserted in ONE
 * place.
 *
 * It was three copies of a raw INSERT, and all three were missing
 * `created_by_user_id` — a NOT NULL column with an FK to `user`. So every seed
 * here threw, the harness logged "Skipping item", and SEVEN curated cases had
 * been scoring nothing at all rather than failing. A seed that throws is
 * invisible in a way a red case is not, which is exactly why it went unnoticed.
 *
 * `EVAL_USER_ID` is the author: it is already required for the run (it is what
 * `X-Context-User-Id` carries), so demanding it here adds no new precondition —
 * it just names the one that was silently unmet.
 *
 * THE NANGO REF IS NOT DECORATION, even though nothing reads it here. A
 * manifest connection is Nango-backed by construction, and `runRead` calls
 * `requireNangoRef` BEFORE it reaches the transport switch — so a row without
 * the pair is refused with an INVARIANT message ("has no Nango binding") that
 * reads to the agent like a bug rather than like an app. Measured 2026-09-20,
 * that one sentence cost three of the nine cases: `obj-sync-columns-by-list`
 * retried `manageSync` twelve times into the step cap and answered nothing at
 * all, `obj-sync-page-wants-synced` fell back to asking the user for an export,
 * and `obj-sync-refresh-when-stale` reported an "integration error" although its
 * refresh had been queued successfully two calls earlier — the agent believed
 * the loudest error it had seen.
 *
 * Past that guard the provider is `testOnly`, so `callCustomHandler` never asks
 * Nango for anything and the values below are never sent anywhere.
 */
const insertEvalConnection = async (
  ctx: EvalCaseContext,
  providerKey: string,
  displayName: string,
): Promise<string> => {
  if (ctx.userId === undefined) {
    throw new Error("EVAL_USER_ID is required to seed a sync connection");
  }
  // Unique per seed, because `uniq_eac_nango` is a unique index on the pair and
  // several of these connections coexist within one run.
  const nangoConnectionId = `eval-${crypto.randomUUID()}`;
  const inserted = await db.execute(sql`
    INSERT INTO external_app_connections
      (organization_id, team_id, provider_key, display_name, status,
       created_by_user_id, nango_connection_id, nango_provider_config_key)
    VALUES (${ctx.organizationId}::uuid, ${ctx.teamId}::uuid,
            ${providerKey}, ${displayName}, 'active', ${ctx.userId}::uuid,
            ${nangoConnectionId}, ${providerKey})
    RETURNING id`);
  const id = Reflect.get(inserted.rows[0] ?? {}, "id");
  if (typeof id !== "string") throw new Error("no eval connection");
  return id;
};

const seedSyncedType = async (ctx: EvalCaseContext): Promise<void> => {
  await dropType(ctx, SYNC_KEY);
  await db.execute(sql`
    DELETE FROM external_app_connections
     WHERE team_id = ${ctx.teamId}::uuid AND display_name = ${SYNC_APP}`);

  const type = await createCollection({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    key: SYNC_KEY,
    label: "Eval Synced Order",
    description: "Orders pulled from the team's order system.",
  });
  const fields: {
    key: string;
    type: FieldDefinitionType;
    isTitle?: boolean;
  }[] = [
    { key: "reference", type: "text", isTitle: true },
    { key: "amount", type: "number" },
  ];
  for (const [i, f] of fields.entries()) {
    await createFieldDefinition({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      collectionId: type.id,
      key: f.key,
      label: f.key,
      type: f.type,
      isTitle: f.isTitle,
      displayOrder: i,
    });
  }
  await reconcileCollectionTable({ collectionId: type.id });

  const connectionId = await insertEvalConnection(ctx, SYNC_PROVIDER, SYNC_APP);

  // `last_success_at` is written by hand: a run that really called an app
  // would make the age — the thing three of these cases turn on — depend on
  // when the suite happened to run.
  const source = await db.execute(sql`
    INSERT INTO collection_sync_sources
      (organization_id, team_id, collection_id, kind, connection_id,
       provider_key, operation, args, external_id_path, field_mapping,
       schedule, last_success_at, last_run_at)
    VALUES (${ctx.organizationId}::uuid, ${ctx.teamId}::uuid, ${type.id}::uuid,
            'table', ${connectionId}::uuid, ${SYNC_PROVIDER}, ${SYNC_OPERATION},
            '{}'::jsonb, 'id',
            '[{"path":"reference","fieldKey":"reference"},{"path":"amount","fieldKey":"amount"}]'::jsonb,
            '{"mode":"interval","everyMinutes":60}'::jsonb,
            now() - interval '${sql.raw(String(SYNC_AGE_HOURS))} hours',
            now() - interval '${sql.raw(String(SYNC_AGE_HOURS))} hours')
    RETURNING id`);
  const sourceId = Reflect.get(source.rows[0] ?? {}, "id");
  if (typeof sourceId !== "string") throw new Error("no eval sync source");

  // The rows go in BEFORE the columns become the source's, and the order is
  // the whole seed. A synced column refuses every write — that is the rule
  // `obj-sync-column-refused` exists to check — so stamping first makes
  // `createCollectionRecord` reject this very seed with the guard's own
  // sentence. It used to survive on a stale field-definitions cache: the raw
  // UPDATE below does not invalidate anything, so a warm process still saw
  // UNSTAMPED definitions and wrote happily. Cold, it throws, and the harness
  // logs "Skipping item" — which is how these cases scored nothing while
  // looking fine.
  for (const row of [
    { externalId: "ord_1001", reference: "EV-1001", amount: 1200 },
    { externalId: "ord_1002", reference: "EV-1002", amount: 800 },
  ]) {
    const record = await createCollectionRecord({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      collectionId: type.id,
      data: { reference: row.reference, amount: row.amount },
    });
    // The app's OWN id for this order, plus the source that owns the row.
    //
    // `loadTableSyncIndexFor` matches on `sync_source_id AND external_id` — the
    // reference is never looked at — so without both stamps these rows are
    // invisible to the walk: a refresh CREATES `EV-1001` a second time instead
    // of updating this one, and the collection ends the turn holding every
    // order twice. Measured 2026-09-20 on `obj-sync-refresh-when-stale`, where
    // the agent reported the duplicates correctly and the case was scored a
    // failure for it.
    //
    // Stamped by hand because `createCollectionRecord` takes no `externalId`
    // (only `bulkCreateCollectionRecords` does), and the seed needs THIS path:
    // it is the one that runs the write guard, which is what makes the ordering
    // below load-bearing.
    await db.execute(sql`
      UPDATE collection_records
         SET external_id = ${row.externalId}, sync_source_id = ${sourceId}::uuid
       WHERE id = ${record.id}::uuid`);
  }

  // NOW the columns become the source's. Without the stamp the field is an
  // ordinary local one and every case here measures nothing.
  await db.execute(sql`
    UPDATE field_definitions SET sync_source_id = ${sourceId}::uuid
     WHERE collection_id = ${type.id}::uuid AND key IN ('reference', 'amount')`);

  // The ROWS are backdated to the same instant as the run that supposedly
  // wrote them. Left at `now()`, the fixture contradicts itself — the source
  // says "last refreshed 30 hours ago" while every row says "updated three
  // seconds ago" — and the agent believed the rows, answered "the figures are
  // from a few minutes ago", and failed a case about saying how stale they
  // are. It was right to believe them: in a real synced collection the two
  // timestamps agree, because the run is what wrote the rows.
  //
  // BOTH tables, and that is the whole point: the registry row carries one
  // pair of timestamps and the per-collection extension table carries its own.
  // `querySql` — which is how the agent actually checks freshness — reads the
  // EXTENSION table, so backdating only the registry left the contradiction
  // exactly where the agent looks.
  const backdate = sql.raw(
    `now() - interval '${String(SYNC_AGE_HOURS)} hours'`,
  );
  await db.execute(sql`
    UPDATE collection_records
       SET created_at = ${backdate}, updated_at = ${backdate}
     WHERE collection_id = ${type.id}::uuid`);
  await db.execute(sql`
    UPDATE ${sql.raw(qualifiedCollectionTable(type.id))}
       SET ${sql.raw(SYS_COL.createdAt)} = ${backdate},
           ${sql.raw(SYS_COL.updatedAt)} = ${backdate}
     WHERE ${sql.raw(SYS_COL.team)} = ${ctx.teamId}::uuid`);

  // A raw UPDATE invalidates no cache, and the AI SERVICE is a separate
  // process holding its own. The cache is Redis-backed, so this reaches it —
  // and without it the service answers from definitions written a moment
  // before the stamp, i.e. a collection nothing is syncing.
  await invalidateFieldDefinitionsCache({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
  });
};

const dropSyncedType = async (ctx: EvalCaseContext): Promise<void> => {
  await dropType(ctx, SYNC_KEY);
  await db.execute(sql`
    DELETE FROM external_app_connections
     WHERE team_id = ${ctx.teamId}::uuid AND display_name = ${SYNC_APP}`);
};

const syncAgeQuoted: EvalCase = {
  id: "obj-sync-age-quoted",
  description:
    "A figure read from a synced collection is quoted WITH its age — the block carries it, so silence is a choice.",
  prompt: `Quel est le montant total des commandes dans ${SYNC_KEY} ?`,
  tags: ["objects", "sync"],
  seed: retryingSeed(seedSyncedType),
  cleanup: dropSyncedType,
  assertions: [
    { type: "noError" },
    SYNC_CALL_CAP,
    {
      type: "judge",
      rubric:
        "Correct ONLY IF the answer gives the total (2000) AND says the figures are not live — that they come from a connected app and date from a previous refresh (a day or so ago / yesterday / an explicit date). Partial if the total is right but nothing is said about freshness. Incorrect if it presents the number as the current state of the order system.",
    },
  ],
};

const syncColumnRefused: EvalCase = {
  id: "obj-sync-column-refused",
  description:
    "A synced column is not the assistant's to write: it explains where the value comes from instead of editing it.",
  prompt: `Change le montant de la commande EV-1001 dans ${SYNC_KEY} à 9999.`,
  tags: ["objects", "sync", "data-quality"],
  seed: retryingSeed(seedSyncedType),
  cleanup: dropSyncedType,
  assertions: [
    { type: "noError" },
    SYNC_CALL_CAP,
    {
      type: "custom",
      name: "amount-unchanged",
      fn: async (_result, ctx) => {
        const typeId = await resolveCollectionId({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          key: SYNC_KEY,
        });
        if (!typeId) return "synced type missing after run";
        const rows = await db
          .select({ id: collectionRecords.id })
          .from(collectionRecords)
          .where(
            and(
              eq(collectionRecords.teamId, ctx.teamId),
              eq(collectionRecords.collectionId, typeId),
              eq(collectionRecords.label, "EV-1001"),
            ),
          );
        const id = rows[0]?.id;
        if (!id) return "EV-1001 not found after run";
        const data = (
          await getCollectionRecord({
            id,
            teamId: ctx.teamId,
            organizationId: ctx.organizationId,
          })
        ).data;
        if (data.amount !== 1200) {
          return `amount is ${JSON.stringify(data.amount)} — a synced column was overwritten`;
        }
        return true;
      },
    },
    {
      type: "judge",
      rubric: `Correct ONLY IF the assistant said this column is filled by a connected app (${SYNC_APP} / the order system) and cannot be edited here — ideally saying the change has to be made in that app. Incorrect if it claimed the amount is now 9999, or offered no explanation of why it could not.`,
    },
  ],
};

const syncRefreshWhenStale: EvalCase = {
  id: "obj-sync-refresh-when-stale",
  description:
    "Told the figures look old, the assistant refreshes the source rather than apologising.",
  prompt: `Les montants dans ${SYNC_KEY} ont l'air de dater. Tu peux les remettre à jour ?`,
  tags: ["objects", "sync"],
  seed: retryingSeed(seedSyncedType),
  cleanup: dropSyncedType,
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["manageSync"] },
    SYNC_CALL_CAP,
    {
      type: "judge",
      // The rubric used to demand "said it runs in the background" and to fail
      // any answer that quoted figures. It cost this case both repeats on
      // 2026-09-20, against an answer that was RIGHT: the refresh really had
      // landed — the jobs worker picks the BullMQ job up in seconds — and the
      // assistant had re-read the collection before quoting anything. A rubric
      // that forbids the true answer measures the fixture's timing, not the
      // assistant. What it must still catch is the claim made WITHOUT looking.
      rubric:
        "Correct ONLY IF the assistant refreshed the source from the connected app, and was honest about the state it reports: either that the refresh runs in the background and the figures will land shortly, or that it has landed — the latter ONLY IF the assistant re-read the collection after refreshing (a query or a read whose results it quotes). Incorrect if it said the data cannot be refreshed, if it only apologised for the age without refreshing, or if it announced new figures it never went back to read.",
    },
  ],
};

const syncProposeFromApp: EvalCase = {
  id: "obj-sync-propose-from-app",
  description:
    "A table the team keeps in another system is a sync source — not a workflow, and not a CSV export.",
  prompt:
    "Toutes nos commandes sont dans notre logiciel de commandes. On aimerait pouvoir les filtrer et les recouper avec nos clients ici. C'est possible ?",
  tags: ["objects", "sync", "proactivity"],
  seed: retryingSeed(seedSyncedType),
  cleanup: dropSyncedType,
  assertions: [
    { type: "noError" },
    SYNC_CALL_CAP,
    { type: "toolUsed", tools: ["manageSync", "askUserQuestion"], mode: "any" },
    {
      type: "judge",
      rubric:
        "Correct ONLY IF the assistant proposed filling a collection from the connected app on a schedule (and asked what to map / how often, or showed a preview). Incorrect if it proposed a workflow to copy the data, asked for a CSV export, or said the data would have to be re-typed by hand.",
    },
  ],
};

// ── Live read, synced collection, or workflow ───────────────────────────────
//
// The decision the platform guide settles for data another system holds: a
// dashboard the team filters and joins goes over a collection the app fills,
// not over the app itself; a scheduled deliverable is a workflow that READS
// that collection rather than a second copy of it; and a person who cannot edit
// a synced column gets the arrangement explained in their own words. None of
// the four cases above asks the agent to CHOOSE between the three.

/** The connection alone — for the case that must decide to build the source. */
const seedConnectionOnly = async (ctx: EvalCaseContext): Promise<void> => {
  await dropSyncedType(ctx);
  await insertEvalConnection(ctx, SYNC_PROVIDER, SYNC_APP);
};

/**
 * The collection already fed by one app, plus a SECOND app to fill a column.
 *
 * A second CONNECTION of the same provider, which is what a team actually has
 * when two of its systems are the same product — and what matters to the case
 * is that they are two apps to the agent, with two display names and two
 * `connectionId`s. `list_invoices` is the surface it needs: every invoice
 * carries `order_reference`, the same value `list_orders` wrote into the
 * collection's `reference` column, so the second source keys on something the
 * first one already filled. That chain is the case's whole point.
 */
const SYNC_APP_2 = "Eval Billing App";
const SYNC_PROVIDER_2 = SYNC_PROVIDER;

const seedTwoApps = async (ctx: EvalCaseContext): Promise<void> => {
  await seedSyncedType(ctx);
  await db.execute(sql`
    DELETE FROM external_app_connections
     WHERE team_id = ${ctx.teamId}::uuid AND display_name = ${SYNC_APP_2}`);
  await insertEvalConnection(ctx, SYNC_PROVIDER_2, SYNC_APP_2);
};

const dropTwoApps = async (ctx: EvalCaseContext): Promise<void> => {
  await dropSyncedType(ctx);
  await db.execute(sql`
    DELETE FROM external_app_connections
     WHERE team_id = ${ctx.teamId}::uuid AND display_name = ${SYNC_APP_2}`);
};

const syncPageWantsSynced: EvalCase = {
  id: "obj-sync-page-wants-synced",
  description:
    "A dashboard over an app's table the team filters and joins → the collection the app fills comes first, not a page reading the app live.",
  prompt:
    "Je veux un tableau de bord de nos commandes — elles sont dans notre logiciel de commandes : les filtrer par client, le total par mois, et les recouper avec nos clients ici. Tu peux me faire ça ?",
  tags: ["objects", "sync", "pages", "platform"],
  seed: retryingSeed(seedConnectionOnly),
  cleanup: dropSyncedType,
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["manageSync", "askUserQuestion"], mode: "any" },
    SYNC_CALL_CAP,
    {
      type: "judge",
      rubric:
        "Correct ONLY IF the assistant's plan brings the orders into a collection the connected app fills on a schedule (proposed, previewed or created) and puts the dashboard over THAT collection. Incorrect if it builds or proposes a page that reads the app live on every open as the way to filter and join, proposes a workflow that copies the data, or asks for an export.",
    },
  ],
};

/**
 * A collection the TEAM types, with a column an app could key on — the setup
 * a `columns` source exists for.
 *
 * `code` is deliberately a `text` column the team fills by hand: the point of
 * the case is that the app's list is matched against something already here,
 * not that a second table is created beside this one.
 *
 * This is where the unreadable-app defect was caught first, and the fix here is
 * the one every other seed above now follows: the agent looked for the app's
 * read actions, found a provider the registry has never heard of, and correctly
 * reported that it could not read the app at all rather than inventing a
 * mapping. A fixture that cannot be read cannot test WHICH action to read with.
 *
 * `list_customers` / `get_customer` publish both halves of that choice for the
 * same entity, so picking the list over the per-record read is a decision the
 * agent can actually make — and the customers it returns carry the same `code`
 * values seeded below, so a walk really does match them.
 */
const MATCH_KEY = "eval_sync_clients";
const MATCH_APP = "Eval Contacts App";

const seedMatchableType = async (ctx: EvalCaseContext): Promise<void> => {
  await dropType(ctx, MATCH_KEY);
  await db.execute(sql`
    DELETE FROM external_app_connections
     WHERE team_id = ${ctx.teamId}::uuid AND display_name = ${MATCH_APP}`);
  await insertEvalConnection(ctx, SYNC_PROVIDER, MATCH_APP);

  const type = await createCollection({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    key: MATCH_KEY,
    label: "Eval Client",
    description: "Clients the team keeps by hand.",
  });
  const fields: {
    key: string;
    type: FieldDefinitionType;
    isTitle?: boolean;
  }[] = [
    { key: "name", type: "text", isTitle: true },
    { key: "code", type: "text" },
  ];
  for (const [i, f] of fields.entries()) {
    await createFieldDefinition({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      collectionId: type.id,
      key: f.key,
      label: f.key,
      type: f.type,
      isTitle: f.isTitle,
      displayOrder: i,
    });
  }
  await reconcileCollectionTable({ collectionId: type.id });

  // Rows the team typed — without them the case asks for something that would
  // do nothing, and the agent said so: a `columns` source fills columns of
  // records that ALREADY EXIST, so against an empty collection it matches
  // nothing whatever key it is given. The first run failed here rather than on
  // the doctrine, which is the fixture's fault, not the agent's.
  for (const row of [
    { name: "Eval Client Nord", code: "CL-001" },
    { name: "Eval Client Sud", code: "CL-002" },
    { name: "Eval Client Est", code: "CL-003" },
  ]) {
    await createCollectionRecord({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      collectionId: type.id,
      data: row,
    });
  }
};

const dropMatchableType = async (ctx: EvalCaseContext): Promise<void> => {
  await dropType(ctx, MATCH_KEY);
  await db.execute(sql`
    DELETE FROM external_app_connections
     WHERE team_id = ${ctx.teamId}::uuid AND display_name = ${MATCH_APP}`);
};

/**
 * The cheap read, on a collection the team already owns.
 *
 * The failure this guards is the one the whole chantier is about: asking the
 * app once per record when it has a list to walk. Second failure guarded: a
 * new collection beside the team's own, which throws away the rows they typed.
 */
const syncColumnsByList: EvalCase = {
  id: "obj-sync-columns-by-list",
  description:
    "An app fills columns of a collection the team keeps → a columns source matched on an existing column, read by walking the app's list, not one call per record and not a second collection.",
  prompt: `Dans ${MATCH_KEY}, je voudrais que les coordonnées de chaque client viennent de « ${MATCH_APP} » — il tient la liste de tous nos contacts. C'est faisable ?`,
  tags: ["objects", "sync", "platform"],
  seed: retryingSeed(seedMatchableType),
  cleanup: dropMatchableType,
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["manageSync", "askUserQuestion"], mode: "any" },
    // Setting one of these up is a handful of calls — this case answers in
    // nine when the app is readable.
    SYNC_CALL_CAP,
    {
      type: "judge",
      rubric: `Correct ONLY IF the assistant's plan adds the new column(s) to the EXISTING ${MATCH_KEY} collection, filled by the connected app, and recognises each of the app's rows by matching it against a column already on those records (the client code). Incorrect if it creates a SECOND collection for the app's clients, if it proposes asking the app once per client / per row / per record when the app has a list, or if it asks the user to choose between reading the app's list and querying it row by row — that is decided by which action the app offers, not by the user.`,
    },
  ],
};

/**
 * Several apps on one collection. Structurally allowed from the start (field
 * ownership is per COLUMN), and the thing an agent gets wrong by assuming one
 * app owns a table.
 */
const syncSecondApp: EvalCase = {
  id: "obj-sync-second-app",
  description:
    "A collection an app already fills gains a column from a SECOND app → another source on the same collection, not a second collection and not a refusal.",
  prompt: `${SYNC_KEY} vient déjà de notre logiciel de commandes. Je voudrais aussi voir le statut de paiement, qui est dans notre outil de facturation. On peut avoir les deux dans le même tableau ?`,
  tags: ["objects", "sync", "platform"],
  seed: retryingSeed(seedTwoApps),
  cleanup: dropTwoApps,
  assertions: [
    { type: "noError" },
    // THE case this assertion was written for: measured 2026-09-20 it passed
    // the judge while issuing 1 430 tool calls, 1 388 of them `bash`, over
    // eleven minutes. Green on the answer, pathological in the trajectory, and
    // the suite said nothing. It answers in sixteen now that the app is
    // readable — the runaway was the fixture, not the model.
    SYNC_CALL_CAP,
    {
      type: "judge",
      rubric: `Correct ONLY IF the assistant says yes and plans a SECOND source on the SAME ${SYNC_KEY} collection, owning only the payment-status column, recognising rows by a value the collection already carries (e.g. the order reference). Incorrect if it says a collection can only be fed by one app, proposes a separate collection for the billing data with a relation as the ONLY way, or proposes copying the data with a workflow.`,
    },
  ],
};

const syncExplainPlainly: EvalCase = {
  id: "obj-sync-explain-plainly",
  description:
    "A user who cannot edit a synced column and doubts the figures gets it explained in their words: the app fills it, corrected there, refreshed on a cadence, currently behind.",
  prompt: `Dans le tableau ${SYNC_KEY}, je n'arrive pas à modifier le montant d'une commande, et je ne sais pas si les chiffres sont à jour. Tu peux m'expliquer ?`,
  tags: ["objects", "sync", "platform", "language"],
  seed: retryingSeed(seedSyncedType),
  cleanup: dropSyncedType,
  assertions: [
    { type: "noError" },
    { type: "toolNotUsed", tools: ["manageRecord"] },
    SYNC_CALL_CAP,
    {
      type: "judge",
      rubric: `Correct ONLY IF the assistant, in plain language with no tool or internal names, (a) explains that these columns are filled by the connected app "${SYNC_APP}" and that a value is corrected in that app, not here, AND (b) says how fresh the figures are — last refreshed about 30 hours ago on an hourly schedule, so they are behind — and offers to refresh them (or does). Incorrect if it says the figures are current, offers to change the amount here, or answers in technical vocabulary.`,
    },
  ],
};

// `workflows` carries no conversation id, so the draft this case creates is
// found by the seed's own timestamp — no other case in the suite creates one.
let workflowCaseSeededAt: Date | null = null;

const seedForWorkflowCase = async (ctx: EvalCaseContext): Promise<void> => {
  await seedSyncedType(ctx);
  workflowCaseSeededAt = new Date();
};

const cleanupWorkflowCase = async (ctx: EvalCaseContext): Promise<void> => {
  if (workflowCaseSeededAt !== null) {
    const since = workflowCaseSeededAt.toISOString();
    await db.execute(sql`
      DELETE FROM workflow_runs
       WHERE workflow_id IN (
         SELECT id FROM workflows
          WHERE team_id = ${ctx.teamId}::uuid
            AND created_at >= ${since}::timestamptz)`);
    await db.execute(sql`
      DELETE FROM workflows
       WHERE team_id = ${ctx.teamId}::uuid
         AND created_at >= ${since}::timestamptz`);
    workflowCaseSeededAt = null;
  }
  await dropSyncedType(ctx);
};

const syncWorkflowReadsCollection: EvalCase = {
  id: "obj-sync-workflow-reads-collection",
  description:
    "A scheduled deliverable over an app's orders is a workflow that reads the collection the app already fills — not a second sync source, not a playbook that re-fetches the app.",
  prompt:
    "Chaque matin à 8h, prépare-moi un fichier Excel des commandes de plus de 1000 € de notre logiciel de commandes.",
  tags: ["objects", "sync", "workflows", "platform"],
  seed: retryingSeed(seedForWorkflowCase),
  cleanup: cleanupWorkflowCase,
  assertions: [
    { type: "noError" },
    {
      type: "toolUsed",
      tools: ["manageWorkflow", "askUserQuestion"],
      mode: "any",
    },
    SYNC_CALL_CAP,
    {
      type: "judge",
      rubric: `Correct ONLY IF the assistant set up (or proposed, with a concrete plan) a scheduled workflow whose runs take the orders from the existing "${SYNC_KEY}" collection the app already fills — refreshing it first is fine. Incorrect if it created or proposed another sync source, wrote a playbook that fetches the app's whole order list itself on every run, or told the user to export a file by hand.`,
    },
  ],
};

export const collectionsAutonomySuite: EvalSuite = {
  name: "collections-autonomy",
  summary:
    "Autonomous object management — proactive create, propose-don't-act on schema, no-data-loss updates, the relevance gate, tolerant value coercion (incl. rating + location), bulk CSV import, SQL→CSV export, the computed-column decision (formula vs stored vs never-written), the four things a collection an app fills demands (quote its age, never write it, refresh it, propose it), and the choice between reading an app live, syncing it, and automating over it.",
  cases: [
    explicitCreate,
    implicitCreate,
    relevanceGate,
    proposeSchema,
    partialUpdate,
    richCreate,
    bulkCsvImport,
    sqlToCsv,
    locationCreate,
    formulaMargin,
    formulaDiscrimination,
    formulaReadOnly,
    syncAgeQuoted,
    syncColumnRefused,
    syncRefreshWhenStale,
    syncProposeFromApp,
    syncPageWantsSynced,
    syncColumnsByList,
    syncSecondApp,
    syncExplainPlainly,
    syncWorkflowReadsCollection,
  ],
};
