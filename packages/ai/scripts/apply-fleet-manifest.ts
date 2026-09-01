/**
 * Bring an empty registry to the fleet a working environment already serves.
 *
 *     bun run models:apply-manifest            # dry run — says what it WOULD do
 *     bun run models:apply-manifest -- --apply # writes
 *
 * `models:sync` discovers models and publishes NOTHING: every row it writes is
 * a `candidate`, invisible to teams. That is the right default for a running
 * fleet and the wrong one for a fresh one — on an environment whose
 * `model_live_state` was just created, the sync leaves teams with no model to
 * pick, and the gap lasts until somebody promotes by hand.
 *
 * So the manifest below is the dev fleet, captured on 2026-09-01: every
 * published key with the exact `enabled` state it carries there. Promotion
 * alone would ALMOST reproduce it — `promoteCandidates` applies the price cap
 * and would disable the same expensive ten on its own — but "almost" is not a
 * property to rely on when the difference is which models a team can pick: a
 * price that moved between two syncs would silently change the split. The
 * manifest states the intended end state and this script converges on it.
 *
 * ORDER MATTERS: run `models:sync` FIRST. This script promotes rows; it does
 * not create them. It reports what is missing rather than inventing it, since a
 * key the sync did not discover is a fact about the catalogues, not something a
 * script should paper over.
 *
 * Idempotent: promoting a published row is a no-op, and the enabled pass only
 * writes rows whose state differs.
 */
import { readLiveStateRow } from "@fretik/shared/services/model-registry/live";
import {
  promoteModels,
  setModelsEnabled,
} from "@fretik/shared/services/model-registry/operations";
import process from "node:process";
import { boundProfileKeys } from "../src/lib/model-registry/bound-roles";

/**
 * The dev fleet on 2026-09-01 — 22 published rows, 12 of them enabled.
 *
 * The ten disabled ones are disabled ON COST, which is a deliberate state and
 * not an oversight: they are published so an operator can see and enable them,
 * and left off so nobody's team picks a model at ten times the budget by
 * accident.
 */
const MANIFEST: readonly { profileKey: string; enabled: boolean }[] = [
  { profileKey: "claude-haiku-4.5", enabled: false },
  { profileKey: "claude-opus-5", enabled: false },
  { profileKey: "claude-sonnet-5", enabled: false },
  { profileKey: "deepseek-v4-flash", enabled: true },
  { profileKey: "deepseek-v4-pro", enabled: true },
  { profileKey: "gemini-3.1-flash-lite", enabled: true },
  { profileKey: "gemini-3.1-pro", enabled: false },
  { profileKey: "gemini-3.5-flash-lite", enabled: true },
  { profileKey: "gemini-3.7-flash", enabled: false },
  { profileKey: "glm-5.2", enabled: true },
  { profileKey: "gpt-5.4-nano", enabled: true },
  { profileKey: "gpt-5.6-luna", enabled: true },
  { profileKey: "gpt-5.6-sol", enabled: false },
  { profileKey: "gpt-5.6-terra", enabled: false },
  { profileKey: "gpt-oss-120b", enabled: true },
  { profileKey: "gpt-oss-20b", enabled: true },
  { profileKey: "grok-4.5", enabled: false },
  { profileKey: "inkling", enabled: false },
  { profileKey: "minimax-m3", enabled: true },
  { profileKey: "ministral-8b-2512", enabled: true },
  { profileKey: "mistral-medium-3.5", enabled: false },
  { profileKey: "mistral-small-2603", enabled: true },
];

const apply = process.argv.includes("--apply");

// ---------------------------------------------------------------------------
// 1. The roles the fleet cannot run without
// ---------------------------------------------------------------------------
//
// Checked FIRST and reported even in a dry run. A bound role resolves from any
// row whatever its status, so what breaks a turn is an ABSENT row, not an
// unpublished one — and that is exactly what an un-synced environment has.

const bound = boundProfileKeys();
const missingBound: string[] = [];
for (const key of bound) {
  const row = await readLiveStateRow(key);
  if (row === null || row === undefined) missingBound.push(key);
}

if (missingBound.length > 0) {
  console.error(
    `\n${missingBound.length.toString()} model(s) an internal role depends on have NO live row:`,
  );
  for (const key of missingBound) console.error(`  - ${key}`);
  console.error(
    "\nTurns using those roles will fail. Run `bun run models:sync` in the jobs\n" +
      "package first; if a key is still missing after a sync, add it explicitly\n" +
      "with `models:admin add <catalogue-model-id>` — the catalogues do not\n" +
      "carry it under the name the bindings expect.",
  );
  process.exit(1);
}
console.info(`✓ all ${bound.length.toString()} bound-role models have a row`);

// ---------------------------------------------------------------------------
// 2. What the manifest would change
// ---------------------------------------------------------------------------

const toPromote: string[] = [];
const toEnable: string[] = [];
const toDisable: string[] = [];
const absent: string[] = [];

for (const entry of MANIFEST) {
  const row = await readLiveStateRow(entry.profileKey);
  if (row === null || row === undefined) {
    absent.push(entry.profileKey);
    continue;
  }
  if (row.status !== "published") toPromote.push(entry.profileKey);
  if (row.enabled !== entry.enabled) {
    (entry.enabled ? toEnable : toDisable).push(entry.profileKey);
  }
}

console.info(`\nmanifest: ${MANIFEST.length.toString()} model(s)`);
console.info(`  to promote: ${toPromote.length.toString()}`);
console.info(`  to enable:  ${toEnable.length.toString()}`);
console.info(`  to disable: ${toDisable.length.toString()}`);
if (absent.length > 0) {
  console.warn(
    `  NOT DISCOVERED by the sync (skipped): ${absent.length.toString()} — ${absent.join(", ")}`,
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
// 3. Write
// ---------------------------------------------------------------------------
//
// `actor: cli` — this is an operator action and belongs in `model_admin_actions`
// like any other, with no user id because no session made it.

const actor = { kind: "cli" } as const;

if (toPromote.length > 0) {
  const entries = await promoteModels({ actor, profileKeys: toPromote });
  for (const entry of entries) {
    console.info(`  promote ${entry.profileKey}: ${entry.outcome.kind}`);
  }
}

// Enabled is set AFTER promotion and explicitly, because promotion decides it
// from the price cap. Where the manifest and the cap disagree, the manifest is
// the environment we are reproducing, and it wins.
if (toEnable.length > 0) {
  const entries = await setModelsEnabled({
    actor,
    profileKeys: toEnable,
    enabled: true,
  });
  for (const entry of entries) {
    console.info(`  enable ${entry.profileKey}: ${entry.outcome.kind}`);
  }
}

if (toDisable.length > 0) {
  const entries = await setModelsEnabled({
    actor,
    profileKeys: toDisable,
    enabled: false,
    reason: "cost",
  });
  for (const entry of entries) {
    console.info(`  disable ${entry.profileKey}: ${entry.outcome.kind}`);
  }
}

console.info("\nDone. Re-run without `--apply` to confirm the fleet matches.");
process.exit(0);
