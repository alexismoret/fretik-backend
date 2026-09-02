import { claim, finish } from "./ledger";
import type { ReleaseTask } from "./types";

/**
 * Run the tasks this service owns, once per deployed version.
 *
 * Called from a service's `index.ts` AFTER migrations and AFTER the server is
 * listening, and never awaited: a release task is not part of being ready to
 * serve. A slow prompt publish must not hold the healthcheck open, and a
 * broken one must not take the deployment down — the previous behaviour, where
 * these ran by hand or not at all, was at least never fatal, and automating
 * them may not make things worse.
 *
 * NOTHING HERE THROWS. Every failure path — the ledger unreachable, a task
 * raising, the whole database down — is logged and swallowed. That is the one
 * property the boot depends on, and it is why the runner catches around each
 * task AND around the loop.
 *
 * The log lines are the interface. Nobody watches this table; they read
 * container logs when a deploy looks wrong, so each line says the task, the
 * version, and what happened.
 */
export const runReleaseTasks = async (
  tasks: readonly ReleaseTask[],
  context: { service: string; version: string },
): Promise<void> => {
  if (tasks.length === 0) return;

  for (const task of tasks) {
    const label = `${task.name}@${context.version}`;
    try {
      const claimed = await claim({
        name: task.name,
        version: context.version,
        service: context.service,
      });
      if (!claimed) {
        // Either it already succeeded for this version, or another replica is
        // running it right now. Both are the system working.
        continue;
      }

      console.log(
        `[release-tasks] ${label} — ${claimed.retry ? "retrying after a failed or abandoned run" : "starting"}`,
      );
      const startedAt = Date.now();

      try {
        const detail = await task.run();
        const durationMs = Date.now() - startedAt;
        await finish({
          id: claimed.id,
          outcome: "ok",
          detail: detail ?? null,
          durationMs,
        });
        console.log(
          `[release-tasks] ${label} — ok in ${durationMs.toString()}ms${
            detail ? ` ${JSON.stringify(detail)}` : ""
          }`,
        );
      } catch (err: unknown) {
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        // Recorded as `failed`, which the claim treats as available again —
        // so the next boot of this version retries it rather than skipping it
        // forever.
        await finish({
          id: claimed.id,
          outcome: "failed",
          detail: { error: message },
          durationMs,
        }).catch(() => undefined);
        console.error(`[release-tasks] ${label} — FAILED: ${message}`);
      }
    } catch (err: unknown) {
      // The ledger itself is unreachable. Say so once per task and carry on:
      // a service that cannot journal must still serve.
      console.error(
        `[release-tasks] ${label} — could not be claimed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
};

/**
 * What "this deployment" means.
 *
 * `GIT_SHA`, baked into the image at build time. NOT `package.json.version`:
 * `version-bump` commits after the build, so the number inside an image is one
 * behind the tag it ships under, and two different images can carry the same
 * one — which would make the ledger skip a task for a version it never ran.
 *
 * The fallback exists so a laptop can exercise this path at all; it is not a
 * deployment identity, and the caller logs which one it got.
 */
export const deployedVersion = (fallback: string): string =>
  process.env["GIT_SHA"] ?? `local-${fallback}`;
