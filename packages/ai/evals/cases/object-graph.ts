import db from "@fretik/shared/db";
import { objectRecords } from "@fretik/shared/db/schema";
import { createFieldDefinition } from "@fretik/shared/services/field-definitions/create";
import { createLinkType } from "@fretik/shared/services/link-types/create";
import { createLink } from "@fretik/shared/services/links/create";
import { createObjectRecord } from "@fretik/shared/services/object-records/create";
import { createObjectType } from "@fretik/shared/services/object-types/create";
import { deleteObjectType } from "@fretik/shared/services/object-types/delete";
import { resolveObjectTypeId } from "@fretik/shared/services/object-types/resolve";
import {
  syncRecordView,
  syncTypedView,
} from "@fretik/shared/services/object-types/sync-typed-view";
import { and, eq, inArray } from "drizzle-orm";
import type { EvalCase, EvalCaseContext, EvalSuite } from "../types";

/**
 * Object-graph (AI query path) eval — the Phase 3 "killer query".
 *
 * Verifies the model answers a structured, cross-record question by querying
 * the TYPED VIEWS and joining `links` (not raw JSONB), RLS-scoped to the team.
 * Industry-agnostic on purpose (per the @fretik/ai positioning): a generic
 * `pricing` type linked to a `company` via a `vendor` relation — the same query
 * SHAPE as the transport "lowest price to Shanghai via which carrier", with no
 * domain vocabulary baked into the committed test data.
 *
 * Seed builds a deterministic dataset with two distractors (wrong destination,
 * wrong year); cleanup drops the type (cascading its records/fields/links) and
 * the seeded vendor records. Both are idempotent so reruns on the shared eval
 * team stay clean.
 */

const PRICING_KEY = "pricing";
const VENDOR_LINK_KEY = "vendor";
const DEST = "Eval City";
const VENDORS = ["Eval Vendor Alpha", "Eval Vendor Beta", "Eval Vendor Gamma"];

/** Drop the seeded type (cascades fields/records/links) + the vendor records. */
const cleanupGraph = async (ctx: EvalCaseContext): Promise<void> => {
  const pricingId = await resolveObjectTypeId({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    key: PRICING_KEY,
  });
  if (pricingId) await deleteObjectType({ id: pricingId });

  const companyId = await resolveObjectTypeId({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    key: "company",
  });
  if (companyId) {
    await db
      .delete(objectRecords)
      .where(
        and(
          eq(objectRecords.teamId, ctx.teamId),
          eq(objectRecords.objectTypeId, companyId),
          inArray(objectRecords.label, VENDORS),
        ),
      );
  }
};

const seedGraph = async (ctx: EvalCaseContext): Promise<void> => {
  const base = { organizationId: ctx.organizationId, teamId: ctx.teamId };

  // Idempotent: clear any leftovers from a prior interrupted run first.
  await cleanupGraph(ctx);

  const companyId = await resolveObjectTypeId({ ...base, key: "company" });
  if (!companyId) throw new Error("eval seed: 'company' system type missing");

  // 1. The `pricing` type + its typed columns (each create re-syncs the view).
  const pricing = await createObjectType({
    ...base,
    key: PRICING_KEY,
    label: "Pricing",
  });
  const fields: { key: string; type: "number" | "text" }[] = [
    { key: "amount", type: "number" },
    { key: "currency", type: "text" },
    { key: "destination", type: "text" },
    { key: "year", type: "number" },
  ];
  for (const [i, f] of fields.entries()) {
    await createFieldDefinition({
      ...base,
      objectTypeId: pricing.id,
      key: f.key,
      label: f.key,
      type: f.type,
      displayInFilters: true,
      displayOrder: i,
    });
  }

  // Ensure the company view + the generic v_record exist (defensive — normally
  // created at team creation / by the backfill script).
  await syncTypedView({ objectTypeId: companyId, teamId: ctx.teamId });
  await syncRecordView();

  // 2. The pricing → company `vendor` relation.
  const vendorLink = await createLinkType({
    ...base,
    key: VENDOR_LINK_KEY,
    label: "Vendor",
    fromObjectTypeId: pricing.id,
    toObjectTypeId: companyId,
  });

  // 3. Vendor records.
  const companyByName = new Map<string, string>();
  for (const name of VENDORS) {
    const rec = await createObjectRecord({
      ...base,
      objectTypeId: companyId,
      data: { name },
    });
    companyByName.set(name, rec.id);
  }

  // 4. Pricing records + their vendor links. The answer: lowest to Eval City in
  //    2025 is 980 via "Eval Vendor Beta". Distractors: 800 is a different
  //    destination; 700 is a different year.
  const rows: {
    amount: number;
    destination: string;
    year: number;
    vendor: string;
  }[] = [
    {
      amount: 1200,
      destination: DEST,
      year: 2025,
      vendor: "Eval Vendor Alpha",
    },
    { amount: 980, destination: DEST, year: 2025, vendor: "Eval Vendor Beta" },
    {
      amount: 1500,
      destination: DEST,
      year: 2025,
      vendor: "Eval Vendor Gamma",
    },
    {
      amount: 800,
      destination: "Other City",
      year: 2025,
      vendor: "Eval Vendor Alpha",
    },
    { amount: 700, destination: DEST, year: 2024, vendor: "Eval Vendor Gamma" },
  ];
  for (const row of rows) {
    const priceRec = await createObjectRecord({
      ...base,
      objectTypeId: pricing.id,
      data: {
        amount: row.amount,
        currency: "USD",
        destination: row.destination,
        year: row.year,
      },
    });
    const toId = companyByName.get(row.vendor);
    if (!toId) continue;
    await createLink({
      ...base,
      linkTypeId: vendorLink.id,
      fromRecordId: priceRec.id,
      toRecordId: toId,
    });
  }
};

const killerQuery: EvalCase = {
  id: "graph-killer-query",
  description:
    "Lowest-price-to-destination via which vendor — typed views + links join, RLS-scoped.",
  prompt:
    "What was the lowest price to Eval City in 2025, and via which vendor? Give the amount and the vendor name.",
  tags: ["object-graph", "sql", "typed-views"],
  seed: seedGraph,
  cleanup: cleanupGraph,
  budget: { expectedTools: ["querySql"] },
  assertions: [
    { type: "noError" },
    { type: "toolUsed", tools: ["querySql"] },
    {
      type: "judge",
      rubric:
        "Correct ONLY IF the answer states the lowest price to Eval City in 2025 is 980 (USD) AND names the vendor as 'Eval Vendor Beta'. The 800 figure (different destination) and the 700 figure (year 2024) are distractors — reporting either as the answer is incorrect.",
    },
  ],
};

export const objectGraphSuite: EvalSuite = {
  name: "object-graph",
  summary:
    "AI query path over the dynamic-data graph — the typed-view + links killer query.",
  cases: [killerQuery],
};
