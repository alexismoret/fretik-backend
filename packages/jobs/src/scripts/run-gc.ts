import { assertOperatorTarget } from "@fretik/shared/lib/operator-guard";
import { runGcDemote } from "../workers/gc-demote";

/**
 * Force-run the episode GC INLINE (same code path as the 04:00 cron) — ops
 * verification. Stage 1 (demotion) is non-destructive (rows stay, vectors
 * drop); stage 2 hard-deletes episodes demoted for ≥ 30 days.
 *
 *   bun run gc:run
 */

// Stage 2 HARD-DELETES episodes. Say which database before deleting from it.
await assertOperatorTarget(Bun.argv);

const { demoted, purged } = await runGcDemote();
console.info(
  `[run-gc] demoted ${demoted.toString()} stale episodes, purged ${purged.toString()} expired`,
);
process.exit(0);
