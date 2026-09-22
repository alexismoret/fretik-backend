import {
  convertLegacyApprovalParks,
  MIN_PARK_AGE_MINUTES,
} from "../services/workflows/convert-legacy-approval-parks";

/**
 * One-shot: convert the approvals parked by the pre-2026-09-22 orchestrator
 * (which sat in `wait.forToken` and held its workflow's concurrency slot for
 * the whole human wait) to the resume-point scheme. The service holds the
 * reasoning and the SQL; this is the CLI over it.
 *
 * ORDER MATTERS AND IS NOT OPTIONAL. Run it AFTER the backend image (its
 * migrations add the columns this writes) AND AFTER `trigger deploy` — the
 * slots it frees let the queued backlog start, and that backlog must start on
 * the NEW orchestrator. Trigger.dev version-locks a run at START
 * (`versioning.mdx`), so a run released before the deploy would execute the
 * old code, call the deleted `/wait-token`, and die.
 *
 * Dry by default; `--apply` writes.
 */
const main = async (): Promise<void> => {
  const apply = process.argv.includes("--apply");
  const report = await convertLegacyApprovalParks({ apply });

  if (report.length === 0) {
    console.log(
      `No run is parked without a resume point (older than ${MIN_PARK_AGE_MINUTES.toString()} min). Nothing to convert.`,
    );
    return;
  }

  console.log(
    `${report.length.toString()} legacy park(s)${apply ? "" : " — DRY RUN, pass --apply to convert"}:\n`,
  );

  for (const row of report) {
    console.log(
      `  ${row.runId}  ${row.workflowName}\n` +
        `    parked since  ${row.pausedAt?.toISOString() ?? "unknown"}\n` +
        `    resume at     turn ${row.resumeFromTurnIndex.toString()}, ${Math.round(row.remainingMs / 1000).toString()}s of budget left\n` +
        `    cancel        ${row.triggerRunId ?? "(no trigger run recorded)"}`,
    );
    if (row.cancelError !== undefined) {
      console.warn(`    ! runs.cancel failed: ${row.cancelError}`);
    }
    if (apply) {
      console.log(
        row.converted === true
          ? "    ✓ converted"
          : "    ! skipped — converted concurrently",
      );
    }
  }

  if (!apply) return;

  const converted = report.filter((row) => row.converted === true).length;
  console.log(
    `\n${converted.toString()} converted, ${(report.length - converted).toString()} skipped.`,
  );
  if (converted > 0) {
    console.log(
      "Answering each approval now starts a fresh orchestrator, and the slots they held are free.\n" +
        "Verify: select count(*) from workflow_runs\n" +
        "        where status = 'needs_approval' and resume_from_turn_index is null;  -- expect 0",
    );
  }
};

await main();
process.exit(0);
