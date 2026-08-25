import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  RECONCILABLE_SOURCE_TYPES,
  orphanCondition,
} from "../../src/services/ai-vectors/reconcile-predicates";

/**
 * The reconciliation sweep DELETES, every night, with nobody watching. Its one
 * catastrophic failure mode is a descriptor pointing at the wrong parent
 * table: every vector of that type would look orphaned and be removed.
 *
 * That is a coding error, not a data condition — so it is caught here, in a
 * test that reads the SQL the sweep would actually issue, rather than by a
 * runtime guard trying to infer "this looks like too many" from row counts.
 * A ratio guard was considered and rejected: it protects least where the
 * absolute numbers are largest, and it would block the legitimate mass purges
 * (a team deleting a big collection, a customer offboarding) that matter most.
 *
 * No database is touched, and that is load-bearing rather than tidy: `bun
 * test` shares one process, so a test file that imports the real `db` poisons
 * the module cache for every file that mocks it. `reconcile-predicates` builds
 * its subqueries with a connectionless `QueryBuilder` precisely so this file
 * can render them with `PgDialect` alone.
 */

const dialect = new PgDialect();

const orphanSql = (sourceType: string): string =>
  dialect.sqlToQuery(orphanCondition(sourceType as never)).sql;

/** The parent table each source type's orphan check MUST interrogate. */
const EXPECTED_PARENT: Record<string, string> = {
  pages: "pages",
  workflows: "workflows",
  memories: "ai_memories",
  context: "ai_context_files",
  episodes: "ai_episodes",
  documents: "documents",
};

describe("orphan predicates", () => {
  test("every reconciled type has an expected parent declared here", () => {
    // Guards the guard: a new source type added to the sweep without a line in
    // EXPECTED_PARENT would otherwise be deleted-from untested.
    const declared: string[] = [...RECONCILABLE_SOURCE_TYPES];
    expect(declared.sort()).toEqual(Object.keys(EXPECTED_PARENT).sort());
  });

  for (const [sourceType, parentTable] of Object.entries(EXPECTED_PARENT)) {
    test(`${sourceType} checks against ${parentTable}, keyed on source_id`, () => {
      const sql = orphanSql(sourceType);
      expect(sql).toContain(`"${parentTable}"`);
      // The join key. A predicate that lost it would match every row.
      expect(sql).toContain(`"ai_vectors"."source_id"`);
      // Scoped to its own type — never a bare "delete the orphans".
      expect(sql).toContain(`"ai_vectors"."source_type"`);
      expect(sql).toContain("not exists");
    });

    test(`${sourceType} interrogates no other parent table`, () => {
      const sql = orphanSql(sourceType);
      const foreign = Object.values(EXPECTED_PARENT).filter(
        (t) => t !== parentTable && !parentTable.includes(t),
      );
      for (const other of foreign) {
        expect(sql).not.toContain(`"${other}"`);
      }
    });
  }

  test("a retired parent is purged, an unfinished one is not", () => {
    // `retired` and `indexable` are deliberately not each other's negation:
    // an archived workflow must lose its card, while a document still being
    // processed keeps the vectors it has until new ones replace them.
    expect(orphanSql("workflows")).toContain("archived");
    expect(orphanSql("episodes")).toContain("active");
    // Documents declare no `retired`, so `status` must not appear in the
    // DELETE predicate — otherwise a mid-reprocessing document loses its
    // index and drops out of search until it finishes.
    expect(orphanSql("documents")).not.toContain("status");
    expect(orphanSql("context")).not.toContain("status");
  });
});
