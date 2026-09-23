import type {
  ActionIncremental,
  ActionPagination,
  ParamSpec,
  ReturnSpec,
} from "../../external-apps/manifest-schema";
import {
  SYNC_LIMITS,
  type SyncArgs,
  type WalkPosition,
} from "../../schemas/collection-sync";
import { UpstreamRateLimitedError } from "../external-apps/exec/governor/upstream-error";
import { resolveSyncArgs } from "./resolve-args";
import { resolveResultPath } from "./result-path";

/**
 * The generic upstream walker: an action, its arguments and a budget in — every
 * row the third party will give us out, ONE PAGE AT A TIME.
 *
 * It exists because pagination is the one thing a sync source cannot leave to
 * the caller. A page dataset shows the first answer and stops (that is its
 * whole contract); a collection sync must pull EVERY row or the collection is a
 * lie that filters and formulas then compute over. And the 11 providers page in
 * four different ways, none of which was declared anywhere a machine could read
 * until `actionPagination` (see `manifest-schema.ts`).
 *
 * WHY A GENERATOR. The first version collected every row into an array and
 * handed it back. That put the whole upstream answer in memory — at the old
 * 100 000-row cap, hundreds of megabytes before a single row had been written
 * — and made a run atomic: reaching the deadline half way through threw the
 * work away and the collection never finished loading. Yielding pages lets the
 * caller diff and write each one and lets a stopped walk hand back a POSITION,
 * which is what `walk_checkpoint` stores and the next leg resumes from.
 *
 * Inference, when nothing is declared, is deliberately narrow — a wrong guess
 * is worse than one page, because it either loops or silently drops rows:
 *   - `paginate: true`   → the proxy already walked it; one call, whole answer.
 *   - `returns: {page}`  → the mapper's contract is `{items, page_token}`, so a
 *                          cursor over `page_token` in and out.
 *   - anything else      → ONE call. `limit`/`offset` is NOT inferred from the
 *                          presence of a `limit` param: plenty of actions take
 *                          one and have no second page to give.
 *
 * Five budgets bound a walk, and each one that bites ends it CLEANLY with a
 * reason rather than throwing: a run that stops at its ceiling has still done
 * useful work, and — unlike the collector — the rows it did pull are already
 * written and its position is resumable.
 */

/** Page size when neither the declaration nor the param spec names one. */
const DEFAULT_PAGE_SIZE = 100;

export type WalkTruncationReason =
  /** `rowCap` reached — the source's own ceiling. */
  | "row_cap"
  /** `SYNC_LIMITS.maxPagesPerRun` reached. */
  | "page_cap"
  /** `SYNC_LIMITS.maxUpstreamCallsPerRun` reached. */
  | "call_cap"
  /** The run's wall clock ran out mid-walk. */
  | "deadline"
  /** The governor refused, or the third party did. Resumable, after a wait. */
  | "rate_limited"
  /**
   * The action DECLARES a pagination mode whose parameter it does not accept.
   * One page is all that can be asked for, and saying so beats looping on the
   * same arguments or pretending the collection is complete.
   */
  | "unpaged";

/** One page of upstream rows, with the position that would re-read it. */
export interface WalkPage {
  rows: Record<string, unknown>[];
  /** Calls made SO FAR in this walk, this page included. */
  calls: number;
  /** Rows yielded so far, this page included. */
  rowsSeen: number;
  /** Pages yielded so far, this one included. */
  pagesDone: number;
  /**
   * Where the NEXT call would start, or `null` when the walk is complete.
   *
   * Computed after the page is read and before it is handed over, so a caller
   * that stops on this page stores a position pointing at the next one — never
   * at the page it just wrote, which would be re-read and re-diffed forever.
   */
  next: WalkPosition | null;
}

/** How a walk ended when it did not end by running out of rows. */
export interface WalkStop {
  reason: WalkTruncationReason;
  /** Resume here. `null` when there is nothing to resume (an unpaged action). */
  next: WalkPosition | null;
  /** `rate_limited` only — how long the governor says to wait. */
  retryAfterMs?: number;
}

/** The slice of a resolved action a walk needs. Structural, so a test fakes it. */
export interface WalkableAction {
  params: Record<string, ParamSpec>;
  returns?: ReturnSpec;
  pagination?: ActionPagination;
  incremental?: ActionIncremental;
  walksItself: boolean;
  call: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface WalkReadInput {
  action: WalkableAction;
  args: SyncArgs;
  /** Dot path to the rows inside one answer. */
  resultPath?: string | null;
  /** Resolves `{"$since": true}`. Absent ⇒ the key is dropped (full pass). */
  lastSuccessAt?: Date | null;
  rowCap: number;
  maxPages?: number;
  maxCalls?: number;
  /** Epoch ms past which no further call starts. */
  deadlineAt?: number;
  /** Resume a suspended walk from exactly here. */
  resumeFrom?: WalkPosition | null;
  /**
   * Rows the earlier legs already saw. Carried because `rowCap` is the
   * source's ceiling on the COLLECTION, so it spans every leg — and because an
   * offset walk resumes by row count.
   */
  rowsSeen?: number;
  /**
   * Calls and pages the earlier legs already made, for REPORTING only.
   *
   * `maxCalls` and `maxPages` are per LEG, deliberately: they bound one job's
   * work, and what bounds the whole walk is `SYNC_LIMITS.maxRunLegs`. Budgeting
   * them cumulatively would make a walk that stopped at the call cap resume and
   * stop again on its first call, forever.
   */
  calls?: number;
  pagesDone?: number;
}

/**
 * What the walker will do with this action, declaration or inference. Exported
 * because the preview shows it: "this pulls every row" and "this reads one page"
 * are different promises and a person is entitled to know which one they picked.
 */
export const resolveActionPagination = (
  action: Pick<WalkableAction, "returns" | "pagination" | "walksItself">,
): ActionPagination => {
  if (action.pagination !== undefined) return action.pagination;
  if (action.walksItself) return { kind: "auto" };
  if (action.returns !== undefined && "page" in action.returns) {
    return {
      kind: "cursor",
      tokenParam: "page_token",
      tokenPath: "page_token",
    };
  }
  return { kind: "none" };
};

/**
 * Rows out of one answer.
 *
 * With no `resultPath`, a record carrying an `items` array is unwrapped — that
 * is the declared shape of every `{page}` and mapped `{list}` return, so making
 * the user type `items` would be asking them to restate the contract. A lone
 * object is one row (a `get_*` feeding a lookup source), and a scalar is wrapped
 * under `value` so a mapping path always has something to walk.
 *
 * `undefined` means the path found nothing, which is a configuration error the
 * caller reports — distinct from finding an empty list, which is just no rows.
 */
export const extractRows = (
  payload: unknown,
  resultPath?: string | null,
): Record<string, unknown>[] | undefined => {
  let value: unknown = payload;
  if (resultPath !== undefined && resultPath !== null && resultPath !== "") {
    value = resolveResultPath(payload, resultPath);
    if (value === undefined) return undefined;
  } else if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray(Reflect.get(value, "items"))
  ) {
    value = Reflect.get(value, "items");
  }
  return toRows(value);
};

const toRows = (value: unknown): Record<string, unknown>[] => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(asRow);
  return [asRow(value)];
};

const asRow = (entry: unknown): Record<string, unknown> =>
  typeof entry === "object" && entry !== null && !Array.isArray(entry)
    ? { ...entry }
    : { value: entry };

/** The next cursor, or `undefined` when the provider says there is none. */
const readNextToken = (
  payload: unknown,
  tokenPath: string | undefined,
): string | undefined => {
  const raw = resolveResultPath(payload, tokenPath ?? "page_token");
  if (typeof raw === "string") return raw === "" ? undefined : raw;
  if (typeof raw === "number") return String(raw);
  return undefined;
};

/**
 * Largest page this action accepts. The declaration wins; failing that the
 * param's own `max` is the provider's own answer to the same question, and
 * asking for more than it is an error rather than a cap (see `maxLimit`).
 */
const pageSizeFor = (
  action: WalkableAction,
  pagination: ActionPagination,
  remaining: number,
): number => {
  const spec = action.params[pagination.limitParam ?? "limit"];
  const ceiling =
    pagination.maxLimit ??
    (typeof spec?.max === "number" ? spec.max : undefined) ??
    DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(ceiling, remaining));
};

/**
 * Walk the upstream list, yielding one page at a time.
 *
 * The generator's RETURN value (not a yield) is the stop: `undefined` when the
 * list ran out, a {@link WalkStop} when a budget bit. A caller reads it from
 * the `done: true` result of the iterator — which is why the loop below is
 * written with an explicit `for await` in `run-table-sync.ts` rather than a
 * `for…of`, whose return value JavaScript discards.
 */
export const walkPages = async function* (
  input: WalkReadInput,
): AsyncGenerator<WalkPage, WalkStop | undefined> {
  const { action } = input;
  const pagination = resolveActionPagination(action);
  const maxPages = input.maxPages ?? SYNC_LIMITS.maxPagesPerRun;
  const maxCalls = input.maxCalls ?? SYNC_LIMITS.maxUpstreamCallsPerRun;

  const base = resolveSyncArgs({
    args: input.args,
    since: input.lastSuccessAt ?? null,
    incremental: action.incremental,
  }).args;

  let calls = input.calls ?? 0;
  let rowsSeen = input.rowsSeen ?? 0;
  let pagesDone = input.pagesDone ?? 0;
  /** This leg's own spend, which is what `maxCalls` / `maxPages` bound. */
  let legCalls = 0;
  let legPages = 0;
  let lastPayload: unknown;

  /** One call, plus the bookkeeping every mode shares. */
  const callPage = async (
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> => {
    const payload = await action.call({ ...base, ...extra });
    calls += 1;
    legCalls += 1;
    const page = extractRows(payload, input.resultPath);
    if (page === undefined) {
      throw new Error(
        `resultPath "${input.resultPath ?? ""}" found nothing in the answer. Preview the operation to see its real shape`,
      );
    }
    lastPayload = payload;
    return page;
  };

  /**
   * Trim a page to what is left under `rowCap`.
   *
   * The cap counts rows the CALLER will see, so trimming here rather than
   * after the yield keeps `rowsSeen` and the offset the next leg sends in step
   * with each other — an over-count would skip exactly the rows it dropped.
   */
  const take = (
    page: Record<string, unknown>[],
  ): { rows: Record<string, unknown>[]; capped: boolean } => {
    const room = input.rowCap - rowsSeen;
    if (page.length >= room) {
      return { rows: page.slice(0, Math.max(0, room)), capped: true };
    }
    return { rows: page, capped: false };
  };

  /** Budgets checked BEFORE a call, never after — an over-budget call is one
   *  the third party is charged for and we throw away. */
  const outOfBudget = (): WalkTruncationReason | undefined => {
    if (legPages >= maxPages) return "page_cap";
    if (legCalls >= maxCalls) return "call_cap";
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      return "deadline";
    }
    return undefined;
  };

  /** Account for a page and build what the caller receives. */
  const page = (
    rows: Record<string, unknown>[],
    next: WalkPosition | null,
  ): WalkPage => {
    rowsSeen += rows.length;
    pagesDone += 1;
    legPages += 1;
    return { rows, calls, rowsSeen, pagesDone, next };
  };

  // `auto` and `none` are the same walk: one call. They differ only in what the
  // UI says about completeness, which is not this function's business. Neither
  // has a position, so neither is ever resumed — a leg that stops here restarts.
  if (pagination.kind === "auto" || pagination.kind === "none") {
    const { rows, capped } = take(await callPage({}));
    yield page(rows, null);
    return capped ? { reason: "row_cap", next: null } : undefined;
  }

  if (pagination.kind === "cursor") {
    const tokenParam = pagination.tokenParam ?? "page_token";
    if (!(tokenParam in action.params)) {
      const { rows, capped } = take(await callPage({}));
      yield page(rows, null);
      if (capped) return { reason: "row_cap", next: null };
      // Only mark it unpaged if there WAS a next page to ask for — an action
      // that answered everything in one go is not truncated.
      const next = readNextToken(lastPayload, pagination.tokenPath);
      return next !== undefined ? { reason: "unpaged", next: null } : undefined;
    }
    let token: string | undefined =
      input.resumeFrom?.kind === "cursor" ? input.resumeFrom.token : undefined;
    for (;;) {
      const over = outOfBudget();
      if (over !== undefined) {
        return {
          reason: over,
          next: token === undefined ? null : { kind: "cursor", token },
        };
      }
      const extra: Record<string, unknown> = {};
      if (token !== undefined) extra[tokenParam] = token;
      if (pagination.limitParam !== undefined) {
        extra[pagination.limitParam] = pageSizeFor(
          action,
          pagination,
          input.rowCap - rowsSeen,
        );
      }
      const stop = await rateLimited(() => callPage(extra));
      if ("error" in stop) {
        return {
          reason: "rate_limited",
          next: token === undefined ? null : { kind: "cursor", token },
          ...(stop.error.retryAfterMs !== undefined
            ? { retryAfterMs: stop.error.retryAfterMs }
            : {}),
        };
      }
      const { rows, capped } = take(stop.page);
      const raw = readNextToken(lastPayload, pagination.tokenPath);
      // A provider that echoes the token it was given would otherwise spin to
      // `maxPages` re-reading one page. Seen in the wild; cheap to refuse.
      const next = raw === undefined || raw === token ? undefined : raw;
      yield page(
        rows,
        next === undefined ? null : { kind: "cursor", token: next },
      );
      if (capped) {
        return {
          reason: "row_cap",
          next: next === undefined ? null : { kind: "cursor", token: next },
        };
      }
      if (next === undefined) return undefined;
      token = next;
    }
  }

  // `offset` counts ROWS, `page-number` counts PAGES from 1. Same loop, one
  // different parameter — and the difference is not cosmetic: sending `0` where
  // a 1-based index is expected either re-reads page one forever or skips it.
  const indexParam =
    pagination.kind === "offset"
      ? (pagination.offsetParam ?? "offset")
      : (pagination.pageParam ?? "page");
  const limitParam = pagination.limitParam ?? "limit";
  if (!(indexParam in action.params)) {
    const { rows, capped } = take(await callPage({}));
    yield page(rows, null);
    return { reason: capped ? "row_cap" : "unpaged", next: null };
  }
  const hasLimit = limitParam in action.params;
  // An offset walk resumes by ROW COUNT, which `rowsSeen` already carries; a
  // page-number walk resumes by page index, which it does not.
  let pageIndex = input.resumeFrom?.kind === "page" ? input.resumeFrom.page : 1;
  for (;;) {
    const position: WalkPosition =
      pagination.kind === "offset"
        ? { kind: "offset", offset: rowsSeen }
        : { kind: "page", page: pageIndex };
    const over = outOfBudget();
    if (over !== undefined) return { reason: over, next: position };

    const size = pageSizeFor(action, pagination, input.rowCap - rowsSeen);
    const extra: Record<string, unknown> = {
      [indexParam]:
        pagination.kind === "offset" ? rowsSeen : /* 1-based */ pageIndex,
    };
    if (hasLimit) extra[limitParam] = size;
    const stop = await rateLimited(() => callPage(extra));
    if ("error" in stop) {
      return {
        reason: "rate_limited",
        next: position,
        ...(stop.error.retryAfterMs !== undefined
          ? { retryAfterMs: stop.error.retryAfterMs }
          : {}),
      };
    }
    const got = stop.page;
    const { rows, capped } = take(got);
    pageIndex += 1;
    const after: WalkPosition =
      pagination.kind === "offset"
        ? { kind: "offset", offset: rowsSeen + rows.length }
        : { kind: "page", page: pageIndex };
    // A short page is the last page. With no limit param we cannot know what
    // "short" means, so an empty page is the only stop signal left.
    const last = got.length === 0 || (hasLimit && got.length < size) || capped;
    yield page(rows, last ? null : after);
    if (capped) return { reason: "row_cap", next: after };
    if (last) return undefined;
  }
};

/**
 * Run one call and turn a rate-limit refusal into a VALUE.
 *
 * Only that one error: a 404 or a mapper failure is a real fault and belongs in
 * the run's `error`, while a refusal is an instruction to come back later and
 * the walk has a position to come back to. Letting it throw would lose the
 * position and re-walk the whole list on the next leg.
 */
const rateLimited = async (
  call: () => Promise<Record<string, unknown>[]>,
): Promise<
  { page: Record<string, unknown>[] } | { error: UpstreamRateLimitedError }
> => {
  try {
    return { page: await call() };
  } catch (cause) {
    if (cause instanceof UpstreamRateLimitedError) return { error: cause };
    throw cause;
  }
};

export interface WalkReadResult {
  rows: Record<string, unknown>[];
  /** Calls actually made — the figure a team can act on (plan §3.5). */
  calls: number;
  truncated: boolean;
  truncatedReason?: WalkTruncationReason;
}

/**
 * Every row in one array — the PREVIEW's walker, not the runner's.
 *
 * It is safe here and nowhere else because the preview asks for
 * `SYNC_LIMITS.previewRows` (20) and shows them to a person. The runner walks
 * the same generator without ever holding more than one page.
 */
export const walkRead = async (
  input: WalkReadInput,
): Promise<WalkReadResult> => {
  const rows: Record<string, unknown>[] = [];
  const walk = walkPages(input);
  let calls = 0;
  for (;;) {
    const step = await walk.next();
    if (step.done === true) {
      const reason = step.value?.reason;
      return {
        rows,
        calls,
        truncated: reason !== undefined,
        ...(reason !== undefined ? { truncatedReason: reason } : {}),
      };
    }
    rows.push(...step.value.rows);
    calls = step.value.calls;
  }
};
