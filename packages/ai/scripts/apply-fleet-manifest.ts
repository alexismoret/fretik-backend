/**
 * Bring a registry to the fleet described by a manifest.
 *
 *     bun run models:apply -- fleet.json             # dry run — says what it WOULD do
 *     bun run models:apply -- fleet.json --apply     # writes
 *
 * Produced by `models:export` on an environment that already works. The two
 * together are how a fresh environment gets a fleet:
 *
 *     (working env) bun run models:export > fleet.json
 *     (new env)     bun run models:sync                 # in the jobs package
 *     (new env)     bun run models:apply -- fleet.json --apply
 *
 * This replaces a 22-key list that was PASTED INTO THIS FILE and dated in a
 * comment. That list could only describe the fleet on the day somebody typed
 * it — promoting a model, enabling one, or retiring one left it quietly wrong
 * — and worse, the script could only PROMOTE. A key the sync had not
 * discovered was reported as absent and skipped, which is precisely the case a
 * fresh environment is made of: `models:sync` derives its own keys from
 * catalogue ids, so a bound key like `deepseek-v4-flash` (whose catalogue id
 * yields `deepseek-deepseek-v4-flash-0731`) can never be discovered. The only
 * bootstrap left was copying rows between databases in SQL.
 *
 * So this now CREATES what is missing, from the ids the manifest carries,
 * under the key the manifest names. Everything else about the row — prices,
 * pool, endpoints, health — is re-derived here from the catalogues, because
 * those are measurements and belong to this environment rather than to the one
 * that exported.
 *
 * Idempotent: creating an existing key is a no-op, promoting a published row
 * is a no-op, and the enabled pass only writes rows whose state differs.
 */
import { assertOperatorTarget } from "@fretik/shared/lib/operator-guard";
import { isTransportId } from "@fretik/shared/model-registry/types";
import { addFromCatalogue } from "@fretik/shared/services/model-registry/add-from-catalogue";
import { readLiveStateRow } from "@fretik/shared/services/model-registry/live";
import {
  promoteModels,
  setModelsEnabled,
} from "@fretik/shared/services/model-registry/operations";
import process from "node:process";
import { z } from "zod";
import { boundProfileKeys } from "../src/lib/model-registry/bound-roles";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const path = args.find((arg) => !arg.startsWith("--"));

if (path === undefined) {
  console.error(
    "usage: bun run models:apply -- <manifest.json> [--apply]\n" +
      "produce one with `bun run models:export > fleet.json` on a working environment",
  );
  process.exit(2);
}

// Validated rather than trusted: this file comes off a disk and its entries
// decide which models a team can pick. A malformed one must say so here, not
// three passes later as an undefined key in a promote call.
const manifestSchema = z.object({
  exportedAt: z.string(),
  entries: z.array(
    z.object({
      profileKey: z.string().min(1),
      enabled: z.boolean(),
      modelIds: z.record(z.string(), z.string()),
      transport: z.string(),
    }),
  ),
});

const parsed = manifestSchema.safeParse(await Bun.file(path).json());
if (!parsed.success) {
  console.error(`${path} is not a fleet manifest: ${parsed.error.message}`);
  process.exit(2);
}
const manifest = parsed.data;

// After the manifest parses (a bad file should fail without a database) and
// before anything is written. `--apply` rewrites the whole routing table.
await assertOperatorTarget(Bun.argv);
console.info(
  `manifest ${path}: ${manifest.entries.length.toString()} published model(s), exported ${manifest.exportedAt}`,
);

// ---------------------------------------------------------------------------
// 1. Create what is missing
// ---------------------------------------------------------------------------
//
// Before anything else, because promotion cannot act on a row that is not
// there — and a bound key is exactly the row no sync will ever produce.

const created: string[] = [];
const uncreatable: { profileKey: string; reason: string }[] = [];

for (const entry of manifest.entries) {
  const existing = await readLiveStateRow(entry.profileKey);
  if (existing !== undefined) continue;

  // Any spelling will do — `addFromCatalogue` consults every catalogue and
  // matches on the id as any transport spells it.
  const modelId = Object.values(entry.modelIds).find(
    (id): id is string => typeof id === "string",
  );
  if (modelId === undefined) {
    uncreatable.push({
      profileKey: entry.profileKey,
      reason: "the manifest carries no model id for it",
    });
    continue;
  }
  if (!apply) {
    created.push(entry.profileKey);
    continue;
  }

  const outcome = await addFromCatalogue({
    modelId,
    profileKey: entry.profileKey,
    ...(isTransportId(entry.transport) ? { transport: entry.transport } : {}),
    now: new Date(),
  });
  if (outcome.kind === "added" || outcome.kind === "key-exists") {
    created.push(entry.profileKey);
  } else {
    uncreatable.push({ profileKey: entry.profileKey, reason: outcome.kind });
  }
}

if (created.length > 0) {
  console.info(
    `\n${apply ? "created" : "would create"} ${created.length.toString()} row(s): ${created.join(", ")}`,
  );
}
if (uncreatable.length > 0) {
  console.warn(
    `\n${uncreatable.length.toString()} row(s) could NOT be created:`,
  );
  for (const entry of uncreatable) {
    console.warn(`  - ${entry.profileKey}: ${entry.reason}`);
  }
}

// ---------------------------------------------------------------------------
// 2. The roles the fleet cannot run without
// ---------------------------------------------------------------------------
//
// A bound role resolves from any row whatever its status, so what breaks a
// turn is an ABSENT row rather than an unpublished one. Checked after the
// creation pass, since that pass exists to fix exactly this.

const missingBound: string[] = [];
for (const key of boundProfileKeys()) {
  const row = await readLiveStateRow(key);
  if (row === null || row === undefined) missingBound.push(key);
}

if (missingBound.length > 0) {
  console.error(
    `\n${missingBound.length.toString()} model(s) an internal role depends on have NO live row:`,
  );
  for (const key of missingBound) console.error(`  - ${key}`);
  console.error(
    "\nTurns using those roles will fail. If the manifest lists them, the\n" +
      "creation pass above says why it could not add them; if it does not, the\n" +
      "manifest was exported from an environment missing them too.",
  );
  if (apply) process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. What the manifest would change
// ---------------------------------------------------------------------------

const toPromote: string[] = [];
const toEnable: string[] = [];
const toDisable: string[] = [];
const absent: string[] = [];

const diff = async (
  entry: z.infer<typeof manifestSchema>["entries"][number],
): Promise<void> => {
  const row = await readLiveStateRow(entry.profileKey);
  if (row === null || row === undefined) {
    absent.push(entry.profileKey);
    return;
  }
  if (row.status !== "published") toPromote.push(entry.profileKey);
  if (row.enabled !== entry.enabled) {
    (entry.enabled ? toEnable : toDisable).push(entry.profileKey);
  }
};
for (const entry of manifest.entries) await diff(entry);

console.info(`\n  to promote: ${toPromote.length.toString()}`);
console.info(`  to enable:  ${toEnable.length.toString()}`);
console.info(`  to disable: ${toDisable.length.toString()}`);
if (absent.length > 0) {
  console.warn(
    `  still absent (skipped): ${absent.length.toString()} — ${absent.join(", ")}`,
  );
}

if (toPromote.length + toEnable.length + toDisable.length === 0) {
  console.info("\nNothing to do — the fleet already matches the manifest.");
  process.exit(0);
}

if (!apply) {
  console.info("\nDry run. Re-run with `--apply` to write.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 4. Write
// ---------------------------------------------------------------------------
//
// `actor: cli` — an operator action, journalled in `model_admin_actions` like
// any other, with no user id because no session made it.

const actor = { kind: "cli" } as const;

if (toPromote.length > 0) {
  for (const entry of await promoteModels({ actor, profileKeys: toPromote })) {
    console.info(`  promote ${entry.profileKey}: ${entry.outcome.kind}`);
  }
}

// Enabled is set AFTER promotion and explicitly, because promotion decides it
// from the price cap. Where the manifest and the cap disagree, the manifest is
// the environment we are reproducing, and it wins.
if (toEnable.length > 0) {
  for (const entry of await setModelsEnabled({
    actor,
    profileKeys: toEnable,
    enabled: true,
  })) {
    console.info(`  enable ${entry.profileKey}: ${entry.outcome.kind}`);
  }
}

if (toDisable.length > 0) {
  for (const entry of await setModelsEnabled({
    actor,
    profileKeys: toDisable,
    enabled: false,
    reason: "cost",
  })) {
    console.info(`  disable ${entry.profileKey}: ${entry.outcome.kind}`);
  }
}

console.info("\nDone. Re-run without `--apply` to confirm the fleet matches.");
process.exit(0);
