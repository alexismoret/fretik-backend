import { raiseModelAlert } from "@fretik/shared/services/model-registry/alerts";
import type { ReleaseTask } from "@fretik/shared/services/release-tasks/types";
import {
  langfuseCredentialsPresent,
  seedLangfusePrompts,
} from "./lib/langfuse-prompts/seed";
import { AUDIT_CHECK_LABELS, runModelAudit } from "./services/model-audit/run";

/**
 * What this service does once per deployed version, by itself.
 *
 * The AI service owns these rather than the API or the worker for one reason:
 * the credentials. `LANGFUSE_*` is set on this container and nowhere else, so
 * this is the only process that COULD publish a prompt.
 *
 * The list is short on purpose, and `services/release-tasks/types.ts` records
 * what keeps it short. Four candidates were considered on 2026-09-02 and
 * rejected, each for a reason worth restating where somebody would come to add
 * a fifth:
 *
 *  - `reseed-system-ontology` writes across every organization and matters
 *    only when the seeded set changes. Usually a no-op that still writes.
 *  - `sync-collection-tables` performs DDL — including column DROPS — over
 *    every team. Its own header calls it backfill/repair: teams get their
 *    tables at creation time.
 *  - `check-collections-rls` creates a real organization, two teams and
 *    records to verify isolation, then deletes them. That is a verification an
 *    operator drives, not something that happens to production on a merge.
 *  - `langfuse-seed-eval-config` is a one-time bootstrap that stores an API
 *    key and creates evaluation rules, and Langfuse score configs cannot be
 *    deleted. After the first run it is a no-op with a permanent downside.
 */

/**
 * Publish the prompts the image ships with.
 *
 * This is the task the whole mechanism was built for. Editing a prompt `.md`
 * and deploying used to leave production running the previous text until
 * somebody remembered `langfuse:seed-prompts` — a gap nothing reported, and
 * one that only ever showed up as the assistant behaving like last week.
 *
 * Safe to run on every deploy because it publishes only what CHANGED: each
 * prompt's text is compared against the live `production` version and skipped
 * when identical, so a deploy that touched no prompt writes nothing at all.
 * When it does publish, Langfuse keeps the previous version alongside — the
 * old text is never destroyed, only superseded.
 */
const seedPrompts: ReleaseTask = {
  name: "langfuse-seed-prompts",
  run: async () => {
    const { published, unchanged } = await seedLangfusePrompts();
    return {
      published: published.length,
      unchanged: unchanged.length,
      // The NAMES, not just the count: "which prompt did that deploy change"
      // is the question asked when a turn starts reading differently.
      names: published,
    };
  },
};

/**
 * Check the registry against itself, and say so if it disagrees.
 *
 * `packages/ai/CLAUDE.md` has said "should run on every deploy" about this
 * audit since the engine was built, and nothing made it true. It is a pure
 * READ — `runModelAudit` issues no insert, update or delete — so running it on
 * every boot costs a few queries and can damage nothing.
 *
 * A finding is a REPORT, not a failure: the task still ends `ok`, because
 * marking it failed would retry it on every restart and re-alert each time.
 * What carries the finding to a human is a `model_alerts` row, which the
 * existing digest sweep picks up like any other — the alert exists precisely
 * because nobody reads container logs on a deploy that otherwise went fine.
 */
const modelsAudit: ReleaseTask = {
  name: "models-audit",
  run: async () => {
    const report = await runModelAudit();
    const byCheck = report.findings.reduce<Record<string, number>>(
      (acc, finding) => {
        acc[finding.code] = (acc[finding.code] ?? 0) + 1;
        return acc;
      },
      {},
    );

    if (report.findings.length > 0) {
      const summary = Object.entries(byCheck)
        .map(
          ([code, count]) =>
            `${AUDIT_CHECK_LABELS[code as keyof typeof AUDIT_CHECK_LABELS] ?? code} (${count.toString()})`,
        )
        .join(", ");
      await raiseModelAlert({
        kind: "audit-drift",
        severity: "warning",
        message: `Registry audit found ${report.findings.length.toString()} contradiction(s) on this deploy: ${summary}. Run \`models:admin audit\` in the container for the detail.`,
        context: { counts: report.counts, byCheck },
      });
    }

    return { findings: report.findings.length, byCheck, ...report.counts };
  },
};

/**
 * The tasks, decided at boot from what this container actually has.
 *
 * Registration is CONDITIONAL rather than the task checking and returning
 * early, and the difference matters: a task that runs and reports "no
 * credentials" is recorded `ok` for that version and never reconsidered, so
 * adding the credentials later would fix nothing until the next deploy. Not
 * registering leaves no ledger row at all, and the next boot re-decides.
 *
 * `LANGFUSE_PROMPTS_LOCAL` is the developer's switch for iterating on a prompt
 * without touching `production`. A process running with it set must not be the
 * one that publishes.
 */
export const aiReleaseTasks = (): ReleaseTask[] => {
  const tasks: ReleaseTask[] = [];

  if (
    langfuseCredentialsPresent() &&
    process.env["LANGFUSE_PROMPTS_LOCAL"] !== "true"
  ) {
    tasks.push(seedPrompts);
  }

  // Unconditional: it reads the database this service already needs to boot.
  tasks.push(modelsAudit);

  return tasks;
};
