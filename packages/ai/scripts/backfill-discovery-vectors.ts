/**
 * Index workflows and pages that predate the discovery feature, so the
 * assistant can find them from a plain request.
 *
 *     bun run backfill:discovery-vectors
 *
 * This used to run on EVERY boot of `@fretik/ai`, fire-and-forget, and it does
 * not belong there. Three reasons, in the order they cost something:
 *
 *  1. **A failing row retried forever.** The loop swallows a per-row error so
 *     one bad workflow cannot stop the pass — correct for a backfill, but on
 *     the boot path it means a row that can never be embedded is re-attempted
 *     at every deploy, paying for an embedding call each time, with nobody
 *     reading the warning.
 *  2. **It hid its own failure for weeks.** The header of
 *     `backfillWorkflowVectors` records it: comparing `workflows.id::text`
 *     against a uuid made Postgres refuse the query, so the backfill threw on
 *     every boot and indexed nothing. Boot code that fails silently is boot
 *     code nobody watches.
 *  3. **It is a migration.** Its whole job is to catch up rows written before
 *     the feature existed; the live write path
 *     (`handlers/vectorize.ts`) indexes everything since. A migration that
 *     re-asks the same question at every start is a query on the hot path
 *     forever, in exchange for an answer that stopped changing months ago.
 *
 * Both passes select only un-indexed rows, so a re-run is a no-op and a run
 * interrupted halfway picks up where it stopped.
 */
import { assertOperatorTarget } from "@fretik/shared/lib/operator-guard";
import process from "node:process";
import { backfillPageVectors } from "../src/services/vectorize/pages";
import { backfillWorkflowVectors } from "../src/services/vectorize/workflows";

await assertOperatorTarget(Bun.argv);

const workflows = await backfillWorkflowVectors();
console.info(`workflows indexed: ${workflows.indexed.toString()}`);

const pages = await backfillPageVectors();
console.info(`pages indexed:     ${pages.indexed.toString()}`);

if (workflows.indexed === 0 && pages.indexed === 0) {
  console.info("\nNothing to do — every workflow and page is already indexed.");
}

process.exit(0);
