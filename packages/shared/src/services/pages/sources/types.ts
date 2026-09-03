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
  /**
   * The page being viewed, when there is one. Only a source that resolves a
   * per-viewer choice needs it (which connected account this page reads
   * through); everything else ignores it, as it ignores `userId`.
   */
  pageId?: string;
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
  /**
   * Epoch ms past which this RUN stops waiting on anything outside the
   * database — shared by every dataset of one render.
   *
   * It exists for third parties, and only a source that calls one reads it: a
   * slow app is waited out per call, and datasets that must not overlap run in
   * sequence, so without one budget over the whole run a single unresponsive
   * app costs the render the SUM of its widgets' waits. What is left is spent
   * in declaration order; a dataset that finds nothing left is asked again on
   * the next render, by which time the answer already in flight is cached.
   */
  deadlineAt?: number;
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
  /**
   * A key two datasets share when they MUST NOT run at the same time, or
   * `undefined` when they may — which is the answer for every source but one.
   *
   * It exists because a page's fan-out and a third party's tolerance are two
   * different facts, and only the source knows the second: Akanea WMS leases a
   * licence seat per call, so five widgets over one account is five seats
   * requested at once and the ones past the pool come back looking like bad
   * credentials. `withConnectionSlot` already makes that CORRECT — this makes
   * it cheap, by never creating the contention in the first place. Same-key
   * datasets run one after another; different keys, and everything without one,
   * still run together.
   *
   * Deliberately synchronous and derived from the DECLARATION alone: this runs
   * before any dataset does, and resolving each one's connection first would
   * cost a query per widget to schedule work that has not started.
   */
  serialKey?: (dataset: PageDataset) => string | undefined;
}
