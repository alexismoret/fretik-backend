import { runGcDemote } from "../workers/gc-demote";

/**
 * Force-run the episode GC INLINE (same code path as the 04:00 cron) — ops
 * verification. Demotion is non-destructive: rows stay, vectors drop.
 *
 *   bun run gc:run
 */

const { demoted } = await runGcDemote();
console.info(`[run-gc] demoted ${demoted.toString()} stale episodes`);
process.exit(0);
