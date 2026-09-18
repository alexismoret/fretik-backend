import { eq } from "drizzle-orm";
import db from "../db";
import { workflows } from "../db/schema";
import { assertOperatorTarget } from "../lib/operator-guard";

/**
 * Repair the workflows that were configured to email nobody.
 *
 * `{emailOnCompletion: true, notifyTriggeredBy: false, recipientUserIds: []}`
 * is a configuration that says "send a completion email" and "to no one" at the
 * same time. It was reachable through the settings panel — a master switch and
 * two unlinked recipient controls, none of them required — and two production
 * workflows were in it on 2026-09-17, one of which a user filled a form on and
 * then waited for a mail that was never sent.
 *
 * The panel no longer produces it and `WorkflowNotificationsInputSchema` no
 * longer accepts it, but neither rewrites a row that already exists: without
 * this, those workflows keep notifying nobody after the deploy.
 *
 * The repair is `notifyTriggeredBy: true`, which is the shipped default and the
 * option the user believed they had. Idempotent, and a no-op on every workflow
 * that is not in the dead state.
 *
 * Run: `bun --env-file=../../.env run src/scripts/repair-workflow-notifications.ts`
 * Add `--apply` to write; without it the script only reports.
 */
const run = async (): Promise<void> => {
  await assertOperatorTarget(Bun.argv);
  const apply = Bun.argv.includes("--apply");

  const rows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      teamId: workflows.teamId,
      notifications: workflows.notifications,
    })
    .from(workflows);

  const dead = rows.filter(
    (row) =>
      row.notifications.emailOnCompletion &&
      !row.notifications.notifyTriggeredBy &&
      row.notifications.recipientUserIds.length === 0,
  );

  console.log(
    `[repair-notifications] ${rows.length.toString()} workflow(s) scanned, ${dead.length.toString()} emailing nobody`,
  );
  for (const row of dead) {
    console.log(`[repair-notifications]   ${row.id}  ${row.name}`);
  }
  if (dead.length === 0 || !apply) {
    if (dead.length > 0) {
      console.log("[repair-notifications] dry run — re-run with --apply");
    }
    process.exit(0);
  }

  for (const row of dead) {
    await db
      .update(workflows)
      .set({ notifications: { ...row.notifications, notifyTriggeredBy: true } })
      .where(eq(workflows.id, row.id));
    console.log(`[repair-notifications] repaired ${row.id}`);
  }

  console.log(`[repair-notifications] done (${dead.length.toString()} fixed)`);
  process.exit(0);
};

run().catch((error) => {
  console.error("[repair-notifications] failed:", error);
  process.exit(1);
});
