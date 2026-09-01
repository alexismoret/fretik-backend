import {
  envVarForCapability,
  runModelSync,
} from "@fretik/shared/services/model-registry/sync/run";

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
 *
 * A `degraded` pass exits ZERO: everything was written, and the fleet is
 * serving. It is loud on stderr instead, because the failure it names is one
 * an operator fixes on the service rather than by re-running the script.
 */

const { status, stats } = await runModelSync();

console.info(`[run-model-sync] status: ${status}`);
console.info(`  models seen:          ${stats.modelsSeen.toString()}`);
console.info(`  rows updated:         ${stats.modelsUpdated.toString()}`);
console.info(`  candidates added:     ${stats.candidatesAdded.toString()}`);
console.info(`  policy failures:      ${stats.policyFailures.toString()}`);
console.info(`  quarantines released: ${stats.quarantinesReleased.toString()}`);
console.info(`  alerts raised:        ${stats.alerts.toString()}`);
// The measurement counters. `endpoints measured` against the endpoints whose
// source publishes percentiles is the ratio that says whether tonight's grades
// rest on anything — a run can update every row and measure nothing.
console.info(
  `  endpoints written:    ${stats.endpointsWritten.toString()} (${stats.endpointsWithThroughput.toString()} of ${stats.endpointsExpectingPercentiles.toString()} expecting percentiles carry throughput, ${stats.endpointsCarriedForward.toString()} carried forward)`,
);
console.info(
  `  rules not measured:   ${stats.rulesSkippedNotMeasured.toString()}`,
);
for (const error of stats.errors) {
  console.error(`  error: ${error}`);
}
if (stats.missingCapabilities.length > 0) {
  console.error(
    `  DEGRADED: graded without ${stats.missingCapabilities
      .map((capability) => `${capability} (${envVarForCapability(capability)})`)
      .join(", ")} — set these on the service that runs the sync.`,
  );
} else if (status === "degraded") {
  console.error(
    "  DEGRADED: every credential is present yet almost nothing was measured — a key that is rejected, revoked or rate-limited returns exactly what a missing one returns. Check the account.",
  );
}

process.exit(status === "failed" ? 1 : 0);
