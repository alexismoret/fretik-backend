import { runModelSync } from "@fretik/shared/services/model-registry/sync/run";

/**
 * Force-run the model sync INLINE (same code path as the 00:30 cron) — ops
 * verification, and the way to adopt a catalogue change without waiting a
 * night. NOT a dry run: it hits four public APIs and writes `model_live_state`,
 * `model_alerts` and a `model_sync_runs` row, exactly as the cron does.
 *
 *   bun run models:sync
 *
 * Exits non-zero when the pass reported `failed` — nothing was written and the
 * fleet is still routing on yesterday's catalogue, which a CI step or an
 * operator's `&&` must be able to see.
 */

const { status, stats } = await runModelSync();

console.info(`[run-model-sync] status: ${status}`);
console.info(`  models seen:          ${stats.modelsSeen.toString()}`);
console.info(`  rows updated:         ${stats.modelsUpdated.toString()}`);
console.info(`  candidates added:     ${stats.candidatesAdded.toString()}`);
console.info(`  policy failures:      ${stats.policyFailures.toString()}`);
console.info(`  quarantines released: ${stats.quarantinesReleased.toString()}`);
console.info(`  alerts raised:        ${stats.alerts.toString()}`);
for (const error of stats.errors) {
  console.error(`  error: ${error}`);
}

process.exit(status === "failed" ? 1 : 0);
