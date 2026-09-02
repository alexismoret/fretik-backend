import { listPendingMigrations, runMigrationsWithLock } from "../db/migrations";
import { assertOperatorTarget } from "../lib/operator-guard";

/**
 * Apply pending migrations, as an operator.
 *
 * The ONLY migration path besides a service boot — `drizzle-kit migrate` is
 * gone from the scripts on purpose. Two paths meant two behaviours to reason
 * about (a different folder resolution, no advisory lock, no target check) and
 * only one of them was ever exercised by CI. This one is the one CI runs.
 */
const main = async (): Promise<void> => {
  const { target, database } = await assertOperatorTarget(Bun.argv);

  const { pending } = await listPendingMigrations();
  if (pending.length === 0) {
    console.log(`Nothing to do — "${database}" is already current.`);
    return;
  }

  console.log(`Applying ${pending.length.toString()} migration(s):`);
  for (const name of pending) console.log(`  - ${name}`);

  await runMigrationsWithLock({ kind: "operator", target });
};

await main();
