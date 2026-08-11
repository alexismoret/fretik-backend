import { runSandboxedJs } from "../../../lib/js-sandbox";
import type { PageValue } from "../../../schemas/pages";
import type { PageDataSource } from "./types";
import { toPageValue } from "./values";

/**
 * A dataset computed from other datasets — derived columns, set differences,
 * ratios, joins across sources: whatever the base queries cannot express.
 *
 * The code is JAVASCRIPT, and running it is safe for the same reason the rest
 * of this route is: it comes from the stored DEFINITION, written by the team's
 * own agent, never from the caller. An anonymous viewer sends variable values
 * and a window; it cannot introduce a line of code. The sandbox then bounds
 * what that stored code may cost — CPU, memory, output size — so a bad
 * transform is a failed widget rather than a stalled server. See
 * `lib/js-sandbox.ts` for what the boundary actually is.
 *
 * This is NOT the path for large volumes, by design. The transform sees rows
 * that a query already reduced: a `GROUP BY` runs where the data lives and
 * returns tens of rows, while pulling a million rows here would mean moving the
 * database into the application server first. The input cap enforces that, and
 * `sanitize` warns about it at write time, before anyone waits.
 */
export const transformSource: PageDataSource = {
  kind: "transform",
  dependsOn: (dataset) => dataset.inputs ?? [],
  resolve: async (dataset, { state, data }) => {
    if (!dataset.code) {
      return { status: "error", message: "transform has no code" };
    }

    const inputs: Record<string, PageValue> = {};
    for (const id of dataset.inputs ?? []) {
      inputs[id] = data[id] ?? null;
    }

    const result = await runSandboxedJs({
      code: dataset.code,
      data: inputs,
      state,
    });
    if (!result.ok) return { status: "error", message: result.error };

    // A transform may legitimately return a single object (a KPI bag); wrap it
    // so every dataset presents the same row-array shape to the renderer.
    const value = result.value;
    const rows =
      value === undefined || value === null
        ? []
        : Array.isArray(value)
          ? value.map(toPageValue)
          : [toPageValue(value)];
    return { status: "ok", rows, truncated: false };
  },
};
