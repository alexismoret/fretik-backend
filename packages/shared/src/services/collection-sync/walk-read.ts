import type {
  ActionIncremental,
  ActionPagination,
  ParamSpec,
  ReturnSpec,
} from "../../external-apps/manifest-schema";
import { SYNC_LIMITS, type SyncArgs } from "../../schemas/collection-sync";
import { resolveSyncArgs } from "./resolve-args";
import { resolveResultPath } from "./result-path";

/**
 * The generic upstream walker: an action, its arguments and a budget in — every
 * row the third party will give us out.
 *
 * It exists because pagination is the one thing a sync source cannot leave to
 * the caller. A page dataset shows the first answer and stops (that is its
 * whole contract); a collection sync must pull EVERY row or the collection is a
 * lie that filters and formulas then compute over. And the 11 providers page in
 * four different ways, none of which was declared anywhere a machine could read
 * until `actionPagination` (see `manifest-schema.ts`).
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
 * Four budgets bound a walk, and each one that bites ends it CLEANLY with a
 * reason rather than throwing: a run that stops at its ceiling has still done
 * useful work, and the next run resumes from a newer `lastSuccessAt`.
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
  /**
   * The action DECLARES a pagination mode whose parameter it does not accept.
   * One page is all that can be asked for, and saying so beats looping on the
   * same arguments or pretending the collection is complete.
   */
  | "unpaged";

export interface WalkReadResult {
  rows: Record<string, unknown>[];
  /** Calls actually made — the figure a team can act on (plan §3.5). */
  calls: number;
  truncated: boolean;
  truncatedReason?: WalkTruncationReason;
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

export const walkRead = async (
  input: WalkReadInput,
): Promise<WalkReadResult> => {
  const { action } = input;
  const pagination = resolveActionPagination(action);
  const maxPages = input.maxPages ?? SYNC_LIMITS.maxPagesPerRun;
  const maxCalls = input.maxCalls ?? SYNC_LIMITS.maxUpstreamCallsPerRun;

  const base = resolveSyncArgs({
    args: input.args,
    since: input.lastSuccessAt ?? null,
    incremental: action.incremental,
  }).args;

  const rows: Record<string, unknown>[] = [];
  let calls = 0;
  let truncatedReason: WalkTruncationReason | undefined;

  /** One call, plus the bookkeeping every mode shares. */
  const callPage = async (
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> => {
    const payload = await action.call({ ...base, ...extra });
    calls += 1;
    const page = extractRows(payload, input.resultPath);
    if (page === undefined) {
      throw new Error(
        `resultPath "${input.resultPath ?? ""}" found nothing in the answer — preview the operation to see its real shape`,
      );
    }
    lastPayload = payload;
    return page;
  };
  let lastPayload: unknown;

  /** Take a page's rows up to the cap; true when the cap stopped us. */
  const absorb = (page: Record<string, unknown>[]): boolean => {
    const room = input.rowCap - rows.length;
    if (page.length >= room) {
      rows.push(...page.slice(0, room));
      truncatedReason = "row_cap";
      return true;
    }
    rows.push(...page);
    return false;
  };

  /** Budgets checked BEFORE a call, never after — an over-budget call is one
   *  the third party is charged for and we throw away. */
  const outOfBudget = (page: number): WalkTruncationReason | undefined => {
    if (page >= maxPages) return "page_cap";
    if (calls >= maxCalls) return "call_cap";
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      return "deadline";
    }
    return undefined;
  };

  // `auto` and `none` are the same walk: one call. They differ only in what the
  // UI says about completeness, which is not this function's business.
  if (pagination.kind === "auto" || pagination.kind === "none") {
    absorb(await callPage({}));
    return result(rows, calls, truncatedReason);
  }

  if (pagination.kind === "cursor") {
    const tokenParam = pagination.tokenParam ?? "page_token";
    if (!(tokenParam in action.params)) {
      absorb(await callPage({}));
      // Only mark it unpaged if there WAS a next page to ask for — an action
      // that answered everything in one go is not truncated.
      const next = readNextToken(lastPayload, pagination.tokenPath);
      return result(
        rows,
        calls,
        truncatedReason ?? (next !== undefined ? "unpaged" : undefined),
      );
    }
    let token: string | undefined;
    for (let page = 0; ; page += 1) {
      const over = outOfBudget(page);
      if (over !== undefined) {
        truncatedReason = over;
        break;
      }
      const extra: Record<string, unknown> = {};
      if (token !== undefined) extra[tokenParam] = token;
      if (pagination.limitParam !== undefined) {
        extra[pagination.limitParam] = pageSizeFor(
          action,
          pagination,
          input.rowCap - rows.length,
        );
      }
      if (absorb(await callPage(extra))) break;
      const next = readNextToken(lastPayload, pagination.tokenPath);
      // A provider that echoes the token it was given would otherwise spin to
      // `maxPages` re-reading one page. Seen in the wild; cheap to refuse.
      if (next === undefined || next === token) break;
      token = next;
    }
    return result(rows, calls, truncatedReason);
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
    absorb(await callPage({}));
    return result(rows, calls, truncatedReason ?? "unpaged");
  }
  const hasLimit = limitParam in action.params;
  for (let page = 0; ; page += 1) {
    const over = outOfBudget(page);
    if (over !== undefined) {
      truncatedReason = over;
      break;
    }
    const size = pageSizeFor(action, pagination, input.rowCap - rows.length);
    const extra: Record<string, unknown> = {
      [indexParam]:
        pagination.kind === "offset" ? rows.length : /* 1-based */ page + 1,
    };
    if (hasLimit) extra[limitParam] = size;
    const got = await callPage(extra);
    if (absorb(got)) break;
    // A short page is the last page. With no limit param we cannot know what
    // "short" means, so an empty page is the only stop signal left.
    if (got.length === 0) break;
    if (hasLimit && got.length < size) break;
  }
  return result(rows, calls, truncatedReason);
};

const result = (
  rows: Record<string, unknown>[],
  calls: number,
  reason: WalkTruncationReason | undefined,
): WalkReadResult => ({
  rows,
  calls,
  truncated: reason !== undefined,
  ...(reason !== undefined ? { truncatedReason: reason } : {}),
});
