import db from "@fretik/shared/db";
import { teamAiSettings } from "@fretik/shared/db/schema";
import { isModelFunctionKey } from "@fretik/shared/model-registry/functions";
import {
  PROMOTION_PRICE_CAPS,
  promotionEnablement,
} from "@fretik/shared/model-registry/policy";
import {
  getLiveRegistry,
  readAllLiveStateRows,
} from "@fretik/shared/services/model-registry/live";
import { z } from "zod";
import { getEffectiveProfile } from "../../lib/model-registry/effective";
import { selectableForFunction } from "../../lib/model-registry/functions";
import { ROLE_FALLBACK } from "../../lib/model-registry/resolve";
import { ROLE_BINDINGS } from "../../lib/model-registry/role-bindings";

/**
 * Everything the engine can contradict itself about, checked without touching
 * the network or a model.
 *
 * It exists because every one of these had already happened once. A row naming
 * a transport it has no id for, a display name outliving the model it named, a
 * team pointing a function at a model retired months ago: each was found by
 * hand, months apart, by someone who happened to look. Reading one table is
 * cheap enough to do on every deploy.
 *
 * Deliberately OFFLINE. An audit that needs a catalogue fetch is an audit that
 * gets skipped in CI and fails on a bad afternoon for the wrong reason.
 *
 * It lives in `@fretik/ai` rather than in `shared` because four of its five
 * inputs do — the role bindings, the fallback map, the synthesised profiles and
 * the per-function selectability all belong to this package, and `shared`
 * cannot import it.
 *
 * It warms live state through `getLiveRegistry()` and NEVER through
 * `warmModelRegistry()`, which also drops every memoised model instance. That
 * distinction is invisible in the CLI's cold process and would be a fleet-wide
 * cache flush on every hit of the HTTP route.
 *
 * `runModelAudit` never calls `process.exit`: the CLI wrapper decides the exit
 * code, which is what CI depends on. **An audit that finds problems is a
 * SUCCESSFUL audit** — answering 500 would be indistinguishable from a broken
 * endpoint.
 */

/**
 * One inconsistency, parameterised, plus the English sentence the terminal
 * prints verbatim.
 *
 * Same split the eligibility engine makes between `unmet` (structure, for a
 * client) and `failed` (English, for logs): the CLI keeps byte-identical
 * output, and a web surface translates the code with the numbers in hand.
 *
 * The schema is the definition and the type is inferred from it, because this
 * union crosses an HTTP boundary: a hand-written mirror would drift silently in
 * exactly the direction — a field the route drops — that nothing would catch.
 */
export const auditFindingSchema = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("no-id-for-transport"),
    detail: z.string(),
    profileKey: z.string(),
    transport: z.string(),
    available: z.array(z.string()),
  }),
  z.object({
    code: z.literal("aa-slug-never-matched"),
    detail: z.string(),
    profileKey: z.string(),
    aaSlug: z.string(),
  }),
  z.object({
    code: z.literal("pool-names-absent-upstreams"),
    detail: z.string(),
    profileKey: z.string(),
    transport: z.string(),
    absent: z.array(z.string()),
  }),
  z.object({
    code: z.literal("enabled-above-price-caps"),
    detail: z.string(),
    profileKey: z.string(),
    inputPerMTok: z.number(),
    outputPerMTok: z.number(),
    capInputPerMTok: z.number(),
    capOutputPerMTok: z.number(),
  }),
  z.object({
    code: z.literal("role-model-undescribable"),
    detail: z.string(),
    role: z.string(),
    profileKey: z.string(),
  }),
  z.object({
    code: z.literal("never-described-by-catalogue"),
    detail: z.string(),
    profileKey: z.string(),
  }),
  z.object({
    code: z.literal("fallback-is-own-primary"),
    detail: z.string(),
    role: z.string(),
    fallbackRole: z.string(),
    profileKey: z.string(),
  }),
  z.object({
    code: z.literal("team-key-under-unknown-function"),
    detail: z.string(),
    teamId: z.string(),
    functionKey: z.string(),
    profileKey: z.string(),
  }),
  z.object({
    code: z.literal("team-model-missing"),
    detail: z.string(),
    teamId: z.string(),
    functionKey: z.string(),
    profileKey: z.string(),
  }),
  z.object({
    code: z.literal("team-model-unusable"),
    detail: z.string(),
    teamId: z.string(),
    functionKey: z.string(),
    profileKey: z.string(),
  }),
]);

export type AuditFinding = z.infer<typeof auditFindingSchema>;

/**
 * The heading each code groups under in the terminal.
 *
 * A lookup rather than a field on every finding: the label is a property of the
 * CHECK, so carrying it per finding would let two findings of one kind disagree
 * about what kind they are.
 */
export const AUDIT_CHECK_LABELS: Record<AuditFinding["code"], string> = {
  "no-id-for-transport": "no id for its own transport",
  "aa-slug-never-matched": "aaSlug set but never matched",
  "pool-names-absent-upstreams": "pool names upstreams no endpoint answers to",
  "enabled-above-price-caps": "enabled above the promotion caps",
  "role-model-undescribable":
    "an internal role points at a model the database cannot describe",
  "never-described-by-catalogue": "never described by a catalogue",
  "fallback-is-own-primary": "a fallback pointing at its own primary",
  "team-key-under-unknown-function": "a stored key under an unknown function",
  "team-model-missing":
    "a team points a function at a model that no longer exists",
  "team-model-unusable":
    "a team points a function at a model it can no longer use",
};

export const auditCountsSchema = z.object({
  liveRows: z.number(),
  published: z.number(),
  roleBindings: z.number(),
  teamSettingsRows: z.number(),
});

export interface ModelAuditReport {
  findings: AuditFinding[];
  counts: z.infer<typeof auditCountsSchema>;
  /** When the rows were read. The audit is a snapshot, not a subscription. */
  snapshotAt: Date;
}

export const runModelAudit = async (): Promise<ModelAuditReport> => {
  // Warm the snapshot `getEffectiveProfile` reads. NOT `warmModelRegistry` —
  // see the module docstring.
  await getLiveRegistry();
  const rows = await readAllLiveStateRows();
  const findings: AuditFinding[] = [];

  for (const row of rows) {
    if (row.modelIds[row.transport] === undefined) {
      const available = Object.keys(row.modelIds);
      findings.push({
        code: "no-id-for-transport",
        profileKey: row.profileKey,
        transport: row.transport,
        available,
        detail: `${row.profileKey} routes through ${row.transport} and carries ids for ${available.join(", ") || "nothing"}. Every call fails.`,
      });
    }

    if (row.aaSlug !== null && row.aaMetrics === null) {
      findings.push({
        code: "aa-slug-never-matched",
        profileKey: row.profileKey,
        aaSlug: row.aaSlug,
        detail: `${row.profileKey} pins Artificial Analysis slug "${row.aaSlug}" and carries no grades — the slug is wrong, or AA dropped the record.`,
      });
    }

    const declared = row.providerPool[row.transport]?.only ?? [];
    const answering = new Set(row.endpointStats.map((stat) => stat.provider));
    const absent = declared.filter((provider) => !answering.has(provider));
    if (absent.length > 0) {
      findings.push({
        code: "pool-names-absent-upstreams",
        profileKey: row.profileKey,
        transport: row.transport,
        absent,
        detail: `${row.profileKey} (${row.transport}) pins [${absent.join(", ")}]; routing still works, on a set nobody vetted.`,
      });
    }

    if (row.status === "published" && row.pricing.inputPerMTok > 0) {
      const budget = promotionEnablement(row.pricing);
      if (row.enabled && !budget.enabled && row.boundRoles.length === 0) {
        findings.push({
          code: "enabled-above-price-caps",
          profileKey: row.profileKey,
          inputPerMTok: row.pricing.inputPerMTok,
          outputPerMTok: row.pricing.outputPerMTok,
          capInputPerMTok: PROMOTION_PRICE_CAPS.inputPerMTok,
          capOutputPerMTok: PROMOTION_PRICE_CAPS.outputPerMTok,
          detail: `${row.profileKey} costs $${row.pricing.inputPerMTok.toString()}/$${row.pricing.outputPerMTok.toString()} against caps $${PROMOTION_PRICE_CAPS.inputPerMTok.toString()}/$${PROMOTION_PRICE_CAPS.outputPerMTok.toString()} and no role needs it.`,
        });
      }
    }
  }

  // A model an internal role depends on, that the database cannot describe.
  //
  // The sharpest check here, and it only became possible when the curated
  // registry was deleted: while TypeScript could answer for a model, this state
  // was invisible — the fleet ran on code defaults and nobody knew the row was
  // missing. Now a role whose model has no row cannot serve a single turn.
  for (const binding of Object.values(ROLE_BINDINGS)) {
    if (getEffectiveProfile(binding.profileKey) !== undefined) continue;
    findings.push({
      code: "role-model-undescribable",
      role: binding.role,
      profileKey: binding.profileKey,
      detail: `${binding.role} → "${binding.profileKey}": no live row, or a row the sync has never described. Every turn on that role fails. Run \`bun run models:sync\`.`,
    });
  }

  // A published row the catalogue has never described. Its card falls back to a
  // capitalised key, which is legible but not the model's name — and it means
  // the sync has not seen this model since `dynamicProfile` started being
  // refreshed every pass, so its reasoning ladder is missing too.
  for (const row of rows) {
    if (row.status !== "published") continue;
    if (row.dynamicProfile !== null) continue;
    findings.push({
      code: "never-described-by-catalogue",
      profileKey: row.profileKey,
      detail: `${row.profileKey} has no catalogue description — its card shows a capitalised key and it can offer no thinking depth. Run the sync.`,
    });
  }

  // A fallback that resolves to its own primary is not redundancy, and it fails
  // exactly when redundancy was the point.
  for (const binding of Object.values(ROLE_BINDINGS)) {
    const fallback = ROLE_FALLBACK[binding.role];
    if (fallback === undefined) continue;
    const fallbackKey = ROLE_BINDINGS[fallback].profileKey;
    if (binding.profileKey === fallbackKey) {
      findings.push({
        code: "fallback-is-own-primary",
        role: binding.role,
        fallbackRole: fallback,
        profileKey: binding.profileKey,
        detail: `${binding.role} falls back to ${fallback}, and both resolve to "${binding.profileKey}".`,
      });
    }
  }

  // What teams actually stored. The one check that reads a row a PERSON wrote
  // rather than one the engine did: a model can be retired, cost-disabled or
  // driven to last-resort long after a team picked it, and the resolver
  // degrades in silence — correctly, since a turn must not fail — which is
  // exactly why nothing else would ever surface it.
  const teamRows = await db
    .select({
      teamId: teamAiSettings.teamId,
      keys: teamAiSettings.functionProfileKeys,
    })
    .from(teamAiSettings);
  for (const team of teamRows) {
    for (const [fn, key] of Object.entries(team.keys)) {
      if (!isModelFunctionKey(fn)) {
        findings.push({
          code: "team-key-under-unknown-function",
          teamId: team.teamId,
          functionKey: fn,
          profileKey: key,
          detail: `team ${team.teamId} stores "${key}" under "${fn}", which is not a model function — it can never be read.`,
        });
        continue;
      }
      const profile = getEffectiveProfile(key);
      if (!profile) {
        findings.push({
          code: "team-model-missing",
          teamId: team.teamId,
          functionKey: fn,
          profileKey: key,
          detail: `team ${team.teamId}: ${fn} → "${key}". Every turn silently serves the default instead.`,
        });
      } else if (!selectableForFunction(profile, fn)) {
        findings.push({
          code: "team-model-unusable",
          teamId: team.teamId,
          functionKey: fn,
          profileKey: key,
          detail: `team ${team.teamId}: ${fn} → "${key}". Still stored, never served.`,
        });
      }
    }
  }

  return {
    findings,
    counts: {
      liveRows: rows.length,
      published: rows.filter((row) => row.status === "published").length,
      roleBindings: Object.keys(ROLE_BINDINGS).length,
      teamSettingsRows: teamRows.length,
    },
    snapshotAt: new Date(),
  };
};
