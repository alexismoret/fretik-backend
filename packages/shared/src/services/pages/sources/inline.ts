import type { PageDataSource } from "./types";

/**
 * Rows written into the definition itself.
 *
 * The one source whose data is frozen, which is exactly why it is rare: a page
 * stores a question. Legitimate for a reference table the agent typed out —
 * targets, thresholds, a mapping — that no query can produce.
 */
export const inlineSource: PageDataSource = {
  kind: "inline",
  resolve: (dataset) =>
    Promise.resolve({
      status: "ok",
      rows: dataset.rows ?? [],
      truncated: false,
    }),
};
