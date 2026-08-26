import { Sandbox } from "@e2b/code-interpreter";
import { E2B_ENVIRONMENT, E2B_TEMPLATE } from "./client";
import { getSandboxIdsFromRegistry } from "./registry";

/**
 * Sweep E2B for sandboxes that are still alive on E2B's side but no
 * longer match a live conversation in our Redis registry. A sandbox is
 * considered orphan when its `metadata.conversationId` either has no
 * Redis entry (TTL expired = conversation idle past
 * `SANDBOX_REGISTRY_TTL_S`) or maps to a different sandbox id (stale
 * sandbox the registry rotated past).
 *
 * Called from two triggers, neither of which is a BullMQ cron:
 * - **boot**: once at AI server start (covers dev hot-reloads and
 *   restarts that orphan sandboxes from a previous run),
 * - **release-throttled**: at the end of `releaseSandbox`, gated by a
 *   30-min Redis SETNX so at most one instance sweeps per window.
 *
 * Best-effort throughout: any failure is logged and execution
 * continues so a single bad sandbox can't block the rest of the sweep.
 */

/**
 * Upper bound on kills per sweep. The sweep runs unattended on boot and after
 * a release; if the listing ever comes back wrong, a cap turns "wiped the
 * account" into "logged a suspicious sweep".
 */
const MAX_KILLS_PER_SWEEP = 200;

/**
 * Never touch a sandbox younger than this. `acquireSandbox` writes the Redis
 * entry AFTER `Sandbox.create` returns, so a sandbox being created right now
 * is legitimately absent from the registry for a moment.
 */
const MIN_AGE_BEFORE_RECLAIM_MS = 5 * 60 * 1000;

/** The subset of `SandboxInfo` the ownership decision reads. */
export interface ReclaimCandidateInfo {
  sandboxId: string;
  metadata?: Record<string, string>;
  startedAt?: Date;
}

/**
 * Is this sandbox ours to consider killing? Pure so the rule that decides
 * whether a running production turn survives a dev server's boot is testable
 * without an E2B account.
 *
 * Three ways to be spared, before the registry is even consulted:
 * 1. no `conversationId` — not created by us at all;
 * 2. a DIFFERENT deployment's `environment` tag — its conversation ids live in
 *    that deployment's Redis, so our registry lookup would read "orphan" and
 *    kill a live turn. An ABSENT tag predates the tag and is still swept, so
 *    the legacy population drains once instead of lingering forever;
 * 3. younger than `minAgeMs` — `acquireSandbox` writes Redis only AFTER
 *    `Sandbox.create` returns, so a sandbox being created right now is
 *    legitimately missing from the registry for a moment.
 */
export const isOwnedByThisDeployment = (
  info: ReclaimCandidateInfo,
  opts: { environment: string; now: number; minAgeMs: number },
): boolean => {
  if (!info.metadata?.conversationId) return false;

  const environment = info.metadata.environment;
  if (environment !== undefined && environment !== opts.environment) {
    return false;
  }

  if (
    info.startedAt instanceof Date &&
    info.startedAt.getTime() > opts.now - opts.minAgeMs
  ) {
    return false;
  }

  return true;
};

export const reclaimOrphanSandboxes = async (): Promise<void> => {
  const paginator = Sandbox.list({
    query: {
      state: ["running", "paused"],
      // Only our own template — an account shared with anything else is not
      // ours to clean up.
      template: E2B_TEMPLATE,
    },
    limit: 100,
  });
  const now = Date.now();
  let killed = 0;

  /* oxlint-disable no-await-in-loop -- paginator cursor advances on await */
  while (paginator.hasNext && killed < MAX_KILLS_PER_SWEEP) {
    const page = await paginator.nextItems();

    const candidates = page.flatMap((info) => {
      if (
        !isOwnedByThisDeployment(info, {
          environment: E2B_ENVIRONMENT,
          now,
          minAgeMs: MIN_AGE_BEFORE_RECLAIM_MS,
        })
      ) {
        return [];
      }
      const conversationId = info.metadata?.conversationId;
      if (!conversationId) return [];
      return [{ info, conversationId }];
    });
    if (candidates.length === 0) continue;

    // One MGET for the page instead of one GET per sandbox.
    const cachedIds = await getSandboxIdsFromRegistry(
      candidates.map((c) => c.conversationId),
    );

    const orphans = candidates.filter(
      (c, i) => cachedIds[i] !== c.info.sandboxId,
    );
    if (orphans.length === 0) continue;

    const budget = orphans.slice(0, MAX_KILLS_PER_SWEEP - killed);
    killed += budget.length;

    await Promise.all(
      budget.map(async ({ info, conversationId }) => {
        // Either Redis is empty (conversation idle past TTL) or it
        // points at a different sandbox (this one is stale).
        console.warn(
          `[e2b:reclaim] killing orphan sandbox=${info.sandboxId} state=${info.state} conversationId=${conversationId}`,
        );
        try {
          await Sandbox.kill(info.sandboxId);
        } catch (err) {
          console.warn(
            `[e2b:reclaim] kill failed for ${info.sandboxId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }),
    );
  }
  /* oxlint-enable no-await-in-loop */

  if (killed >= MAX_KILLS_PER_SWEEP) {
    console.warn(
      `[e2b:reclaim] hit the ${MAX_KILLS_PER_SWEEP.toString()}-kill cap for env "${E2B_ENVIRONMENT}" — sweep stopped early, remaining orphans wait for the next one`,
    );
  }
};
