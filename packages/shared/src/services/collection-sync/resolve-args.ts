import type { ActionIncremental } from "../../external-apps/manifest-schema";
import {
  isSyncFieldBinding,
  isSyncSinceBinding,
  type SyncArgs,
  type SyncArgValue,
} from "../../schemas/collection-sync";

/**
 * Turn a source's stored arguments into the literals a call takes.
 *
 * Two bindings, resolved here and nowhere else, so the walker, the preview and
 * the lookup runner cannot disagree about what `{"$field": "siret"}` means:
 *
 *  - `{"$since": true}` → the source's `lastSuccessAt` in the format the action
 *    declares. With no `lastSuccessAt` the KEY IS DROPPED rather than sent
 *    empty: the first run must be a full pass, and an API handed
 *    `updated_after=""` answers anything from "everything" to `400`.
 *  - `{"$field": "<key>"}` → the record's own value. A record with no value for
 *    the key resolves to `undefined`, which drops the key too and is reported
 *    up as `missing` — the lookup runner then makes NO call for that record,
 *    because asking `get_company(siret: null)` is a wasted call whose answer is
 *    already known.
 *
 * Dropping rather than nulling is the rule for both, and it is the same rule:
 * an absent argument means "no filter", a null one means "filter on null", and
 * only one of those is what a missing value intends.
 */

export interface ResolveSyncArgsInput {
  args: SyncArgs;
  /** The source's `lastSuccessAt`, for `{"$since": true}`. */
  since?: Date | null;
  /** Wire format the action wants its lower bound in. Defaults to ISO. */
  incremental?: ActionIncremental | undefined;
  /** The record's data, for `{"$field": …}`. Absent on a `table` source. */
  fieldValues?: Record<string, unknown>;
}

export interface ResolveSyncArgsResult {
  args: Record<string, unknown>;
  /** Field keys a `{"$field"}` binding asked for and the record did not have. */
  missingFieldKeys: string[];
}

/** `lastSuccessAt` in the shape the third party parses. */
export const formatSince = (
  at: Date,
  format: ActionIncremental["format"] | undefined,
): string | number => {
  switch (format) {
    case "date":
      return at.toISOString().slice(0, 10);
    case "epoch-seconds":
      return Math.floor(at.getTime() / 1000);
    case "epoch-millis":
      return at.getTime();
    default:
      return at.toISOString();
  }
};

/** A value that means "the record has nothing here". */
const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && value.length === 0);

export const resolveSyncArgs = (
  input: ResolveSyncArgsInput,
): ResolveSyncArgsResult => {
  const missingFieldKeys: string[] = [];

  /** `undefined` means "drop this key", at any depth. */
  const walk = (value: SyncArgValue): unknown => {
    if (isSyncSinceBinding(value)) {
      return input.since == null
        ? undefined
        : formatSince(input.since, input.incremental?.format);
    }
    if (isSyncFieldBinding(value)) {
      const bound = input.fieldValues?.[value.$field];
      if (isEmpty(bound)) {
        missingFieldKeys.push(value.$field);
        return undefined;
      }
      return bound;
    }
    if (Array.isArray(value)) {
      // A dropped element would shift every index after it, so an array keeps
      // its shape: only whole KEYS are droppable.
      return value.map((entry) => walk(entry) ?? null);
    }
    if (typeof value === "object" && value !== null) {
      const nested: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        const resolved = walk(entry);
        if (resolved !== undefined) nested[key] = resolved;
      }
      return nested;
    }
    return value;
  };

  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.args)) {
    const resolved = walk(value);
    if (resolved !== undefined) args[key] = resolved;
  }
  return { args, missingFieldKeys: [...new Set(missingFieldKeys)] };
};
