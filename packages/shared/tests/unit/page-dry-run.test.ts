import { describe, expect, test } from "bun:test";
// `schemas/ontology` reaches `common/params`, which calls `.openapi()` — the
// method only exists once `@hono/zod-openapi` has patched Zod. In a service
// that happens at boot; here it has to be imported for the side effect.
import "@hono/zod-openapi";
import type { PageDefinition } from "../../src/schemas/pages";
import { dryRunPage } from "../../src/services/pages/dry-run";

/**
 * `dryRunPage`, over datasets that carry their own rows.
 *
 * The output is CHARACTERISED rather than specified — these assertions exist
 * to make the next refactor's diff readable, so they record what it does
 * today, including that it sanitizes the definition itself.
 *
 * Every dataset here is `inline`, which is what lets this file hold NO double
 * at all: nothing it exercises reaches a database. The cases that name a
 * collection do reach one, and moved to
 * `tests/integration/pages/dry-run.test.ts` on 2026-09-02 rather than keeping
 * a faked `db` alive for them — a faked collection table can only ever answer
 * "no such collection", which is one of the two answers under test.
 */

const withDatasets = (
  datasets: PageDefinition["datasets"],
  source = "<template><div>ok</div></template>",
): PageDefinition => ({
  version: 3,
  variables: [],
  datasets,
  operations: [],
  code: { source },
});

describe("dryRunPage — characterisation of today's output", () => {
  test("reports row count and one clipped sample row", async () => {
    const long = "x".repeat(200);
    const result = await dryRunPage({
      definition: withDatasets([
        { id: "sales", kind: "inline", rows: [{ note: long, amount: 10 }] },
      ]),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });

    expect(result.samples.sales?.rowCount).toBe(1);
    const sample = result.samples.sales?.sample;
    const note =
      typeof sample === "object" && sample !== null && !Array.isArray(sample)
        ? sample.note
        : undefined;
    expect(typeof note === "string" && note.length).toBe(161);
    expect(typeof note === "string" && note.endsWith("…")).toBe(true);
  });

  test("a grouped dataset reports its distinct group values", async () => {
    const result = await dryRunPage({
      definition: withDatasets([
        {
          id: "byStage",
          kind: "inline",
          groupBy: "stage",
          rows: [
            { group: "won", n: 3 },
            { group: "lost", n: 1 },
            { group: "won", n: 2 },
          ],
        },
      ]),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });
    expect(result.samples.byStage?.groupCount).toBe(2);
    expect(result.samples.byStage?.groupValues).toEqual(["won", "lost"]);
  });

  test("an empty dataset is a warning that names the likely cause", async () => {
    const result = await dryRunPage({
      definition: withDatasets([{ id: "sales", kind: "inline", rows: [] }]),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });
    expect(result.warnings).toContain(
      'dataset "sales" returned no rows — check its filters, or the collection may be empty.',
    );
  });

  test("empty code is a warning, not a refusal — a dry run persists nothing", async () => {
    const result = await dryRunPage({
      definition: withDatasets([], ""),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });
    expect(
      result.warnings.some((w) => w.includes("code.source is empty")),
    ).toBe(true);
  });

  test("without assumeCompiled, compile errors land in warnings", async () => {
    // No <template> is a STRUCTURAL failure — caught before the Tailwind
    // subprocess, so this stays a fast unit test of the wiring.
    const result = await dryRunPage({
      definition: withDatasets(
        [],
        '<script setup lang="ts">const a = 1</script>',
      ),
      teamId: "team-1",
      userId: null,
    });
    const found = result.warnings.find((w) => w.startsWith("code [structure]"));
    expect(found).toBeDefined();
    expect(found).toContain("<template>");
  });

  test("assumeCompiled skips the compile pass — the write just paid for it", async () => {
    const result = await dryRunPage({
      definition: withDatasets(
        [],
        '<script setup lang="ts">const a = 1</script>',
      ),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });
    expect(result.warnings.some((w) => w.startsWith("code ["))).toBe(false);
  });
});
