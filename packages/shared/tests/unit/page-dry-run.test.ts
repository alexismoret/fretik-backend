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
  test("reports row count and real rows, long values clipped", async () => {
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
    const [first] = result.samples.sales?.rows ?? [];
    const note =
      typeof first === "object" && first !== null && !Array.isArray(first)
        ? first.note
        : undefined;
    expect(typeof note === "string" && note.length).toBe(161);
    expect(typeof note === "string" && note.endsWith("…")).toBe(true);
  });

  /**
   * Five rows, not one — the change that made this a probe.
   *
   * One row says a field exists and nothing about what it holds, and a page
   * designed from one row is how a filter over an unused status ships. The
   * profile is the same answer in summary form: what recurs, what is empty.
   */
  test("returns several rows and a per-field profile", async () => {
    const rows = [
      { status: "open", owner: "ana", amount: 10 },
      { status: "open", owner: "bo", amount: 20 },
      { status: "won", owner: "ana", amount: 30 },
      { status: "won", owner: null, amount: 40 },
      { status: "lost", owner: "cy", amount: 50 },
      { status: "open", owner: "ana", amount: 60 },
    ];
    const result = await dryRunPage({
      definition: withDatasets([{ id: "deals", kind: "inline", rows }]),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });

    const sample = result.samples.deals;
    expect(sample?.rowCount).toBe(6);
    // Capped: a probe shows the shape, it does not dump the data.
    expect(sample?.rows).toHaveLength(5);

    const status = sample?.profile?.["status"];
    expect(status?.distinct).toBe(3);
    // The vocabulary a filter is built from, most common first.
    expect(status?.top?.[0]).toEqual({ value: "open", count: 3 });

    const owner = sample?.profile?.["owner"];
    expect(owner?.nulls).toBe(1);

    const amount = sample?.profile?.["amount"];
    expect(amount?.min).toBe(10);
    expect(amount?.max).toBe(60);
    // Stated, never implied: these numbers describe the rows that came back.
    expect(amount?.basis).toBe("window");
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

  /**
   * Two channels, because they ask for different actions: `refusals` is what
   * the write path would reject, `warnings` is advice. Mixed into one list, the
   * agent triaged instead of acting.
   */
  test("empty code is a refusal — the write path would reject it", async () => {
    const result = await dryRunPage({
      definition: withDatasets([], ""),
      teamId: "team-1",
      userId: null,
      assumeCompiled: true,
    });
    expect(
      result.refusals.some((line) => line.includes("code.source is empty")),
    ).toBe(true);
  });

  test("a data probe carries no code, and that is not a finding", async () => {
    // `pageProbe` runs before a line of code exists. Telling it to write an
    // SFC is advice about a step it is not on.
    const result = await dryRunPage({
      definition: withDatasets(
        [{ id: "sales", kind: "inline", rows: [{ amount: 1 }] }],
        "",
      ),
      teamId: "team-1",
      userId: null,
      dataOnly: true,
    });
    expect(result.refusals).toHaveLength(0);
    expect(result.samples.sales?.rowCount).toBe(1);
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
