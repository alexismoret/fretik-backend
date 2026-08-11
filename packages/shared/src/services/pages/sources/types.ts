import type {
  PageDataset,
  PageDatasetKind,
  PageDatasetQuery,
  PageDatasetResult,
  PageValue,
} from "../../../schemas/pages";

/**
 * A place a page's rows can come from.
 *
 * Objects were the first source, never the intended only one. One file per
 * kind, one registry, and the executor (`run-page-data.ts`) keeps what is true
 * of ALL of them: the security boundary, dependency ordering, per-dataset
 * degradation, and targeted refetch. A new source is a new file — no change to
 * the executor, and no migration, because datasets live in the definition's
 * JSONB.
 *
 * An interface rather than a class hierarchy: the package's convention is
 * functional services, and a source has exactly one behaviour.
 */

export interface PageDataSourceContext {
  /**
   * Team whose scope every query runs under — the VIEWER's team, or the
   * owner's for a published page. Never derived from a request parameter.
   */
  teamId: string;
  /** Declared variables, already coerced. The only viewer input that gets in. */
  state: Record<string, PageValue>;
  /** Rows of the datasets resolved before this one, keyed by dataset id. */
  data: Record<string, PageValue>;
  /**
   * The window and ordering the viewer asked for, already bounded by the
   * schema. A source that has no meaningful window (inline rows, an aggregate)
   * ignores it — it is a hint, never a contract.
   */
  query?: PageDatasetQuery;
}

export interface PageDataSource {
  kind: PageDatasetKind;
  /**
   * Dataset ids that must resolve before this one. Declared by the source
   * because only it knows what it reads — a transform names its `inputs`, and
   * a future source may name something else entirely.
   */
  dependsOn?: (dataset: PageDataset) => string[];
  resolve: (
    dataset: PageDataset,
    context: PageDataSourceContext,
  ) => Promise<PageDatasetResult>;
}
