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
  /**
   * The viewer, when the route knows one; null on the anonymous public route.
   * External datasets resolve "the viewer's own connection" from it — object
   * queries ignore it, their scope is the team.
   */
  userId: string | null;
  /** Declared variables, already coerced. The only viewer input that gets in. */
  state: Record<string, PageValue>;
  /**
   * The window and ordering the viewer asked for, already bounded by the
   * schema. A source that has no meaningful window (inline rows, an aggregate)
   * ignores it — it is a hint, never a contract.
   */
  query?: PageDatasetQuery;
  /**
   * The refresh button: sources that cache upstream answers bypass their read
   * (but still repopulate). Never set on the public route.
   */
  fresh?: boolean;
}

export interface PageDataSource {
  kind: PageDatasetKind;
  /**
   * `dependsOn` lived here until 2026-08-21, for `transform` — the only source
   * that ever read another dataset's rows. With it gone every dataset is
   * independent, so they all run in ONE wave and `data` is dead weight in the
   * context above. Re-adding either means re-adding the scheduler; do not do it
   * for a source that could read its own inputs directly.
   */
  resolve: (
    dataset: PageDataset,
    context: PageDataSourceContext,
  ) => Promise<PageDatasetResult>;
}
