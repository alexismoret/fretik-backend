import { listDreamingTeams } from "@fretik/shared/services/episodes/dreaming-candidates";
import { runDreamingTeam } from "../workers/dreaming";

/**
 * Force-run the dreaming pass INLINE (same code path as the nightly cron's
 * per-team jobs, minus the queue) — ops verification and post-incident
 * catch-up. The distill safety net still enqueues onto memory-distill, so
 * the jobs process must be running for that part to complete.
 *
 *   bun run dreaming:run                          # every team active in 24h
 *   bun run dreaming:run -- --team <id> --org <id>  # one team
 */

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};

const teamId = opt("--team");
const organizationId = opt("--org");

const targets =
  teamId && organizationId
    ? [{ teamId, organizationId }]
    : await listDreamingTeams();

console.info(`[run-dreaming] ${targets.length.toString()} team(s), inline`);
for (const target of targets) {
  try {
    await runDreamingTeam(target);
  } catch (err) {
    console.error(
      `[run-dreaming] team ${target.teamId} failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}
process.exit(0);
