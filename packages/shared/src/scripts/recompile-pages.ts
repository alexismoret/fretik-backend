/**
 * Re-run the page compiler over every stored page.
 *
 * Pages compile on WRITE and never on read — a GET must not spawn Tailwind —
 * so a page keeps the artifact it was saved with until somebody edits it. That
 * is right for source changes and wrong for compiler changes: when the compiler
 * itself is fixed, every page already in the table keeps serving the defect.
 *
 * `PAGE_COMPILER_REVISION` is what makes this script's work visible — it enters
 * the compile hash, so a bump makes `ensurePageCompiled` rebuild rather than
 * recognise its own output. Without a bump this script is a no-op, which is the
 * correct behaviour: nothing to do.
 *
 * Idempotent, and safe to interrupt — each page is its own write.
 *
 *   cd backend/packages/shared
 *   bun --env-file=../../.env run src/scripts/recompile-pages.ts            # dry run
 *   bun --env-file=../../.env run src/scripts/recompile-pages.ts --apply
 *
 * `--apply` is required to write: this walks EVERY page of every team, and the
 * env file decides which database that is.
 */

import { eq } from "drizzle-orm";
import db from "../db";
import { pages } from "../db/schema";
import { ensurePageCompiled } from "../services/pages/compile";

const apply = process.argv.includes("--apply");

const rows = await db
  .select({
    id: pages.id,
    name: pages.name,
    definition: pages.definition,
    updatedAt: pages.updatedAt,
  })
  .from(pages);

console.log(`${rows.length.toString()} pages${apply ? "" : " (dry run)"}`);

let rebuilt = 0;
let unchanged = 0;
let refused = 0;

for (const row of rows) {
  const before = row.definition.code.compiled?.sourceHash;
  let next;
  try {
    next = await ensurePageCompiled(row.definition);
  } catch (error) {
    // A page that no longer compiles is a finding, not a crash: the rest of the
    // table still deserves its fix, and the id is what makes this actionable.
    refused += 1;
    console.log(
      `  REFUSED  ${row.id}  ${row.name} — ${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`,
    );
    continue;
  }
  const after = next.definition.code.compiled?.sourceHash;
  if (before === after) {
    unchanged += 1;
    continue;
  }
  rebuilt += 1;
  console.log(`  rebuilt  ${row.id}  ${row.name}`);
  if (!apply) continue;
  // `updatedAt` carried explicitly: the column has an `$onUpdateFn`, which
  // applies to EVERY `.set()`, and a compiler fix is not a change to the page —
  // letting it bump would reshuffle every team's hub into recompile order.
  await db
    .update(pages)
    .set({ definition: next.definition, updatedAt: row.updatedAt })
    .where(eq(pages.id, row.id));
}

console.log(
  `rebuilt ${rebuilt.toString()} · unchanged ${unchanged.toString()} · refused ${refused.toString()}${apply ? "" : "  (nothing written — pass --apply)"}`,
);
process.exit(0);
