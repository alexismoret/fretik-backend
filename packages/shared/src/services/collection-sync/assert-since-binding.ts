import db from "../../db";
import type { ActionIncremental } from "../../external-apps/manifest-schema";
import { getAction } from "../../external-apps/registry";
import { badRequest, throwHttpError } from "../../lib/errors";
import type { SyncArgs } from "../../schemas/collection-sync";
import {
  syncArgsBindSince,
  syncArgsSincePlacement,
} from "../../schemas/collection-sync";
import { resolveSyncAction } from "./resolve-action";

/**
 * Refuse a `{"$since": true}` the action cannot honour.
 *
 * The binding means two different things to two different readers, and only
 * one of them looks at where it sits:
 *
 *  - the RUNNER formats the source's `lastSuccessAt` into whatever key the
 *    binding occupies, using the format the action declares — so a binding on
 *    the wrong key sends a timestamp the app does not filter on, and the app
 *    answers with everything;
 *  - `syncArgsBindSince` asks only whether one exists ANYWHERE, and that
 *    answer is what makes the run skip the orphan diff, because an incremental
 *    answer holds only what changed.
 *
 * Put together, a misplaced binding is a source that reads the whole table
 * every run AND has stopped noticing deletions, while reporting `success`.
 * Nothing downstream can see it: the run is well-formed, the counters are
 * plausible, and the only symptom is a row that disappeared upstream months
 * ago still sitting in the collection.
 *
 * So it is checked once, here, where a person is present to be told. Both
 * doors call it — `createSyncSource` and `updateSyncSource` — because a source
 * can acquire the binding by being edited just as easily as by being born.
 *
 * `action` is `undefined` when the operation could not be resolved at all (an
 * MCP server still preparing, a provider renamed mid-edit). That is not this
 * function's refusal to make: the caller decides whether an unresolvable
 * action is fatal, and a source whose action is momentarily unavailable must
 * still be editable.
 */
export const assertSinceBinding = (
  args: SyncArgs,
  incremental: ActionIncremental | undefined,
): void => {
  const { topLevel, nested } = syncArgsSincePlacement(args);
  if (topLevel.length === 0 && !nested) return;

  if (incremental === undefined) {
    return throwHttpError(
      400,
      badRequest(
        'This action has no incremental parameter, so {"$since": true} would be sent as a filter it does not know — it would be ignored, and the source would silently stop detecting rows deleted upstream. Remove the binding; every run reads the whole list, which is what this action supports.',
      ),
    );
  }

  // Nested first: a binding inside an object or an array never reaches the
  // app as a top-level filter, whatever the key above it is called.
  if (nested) {
    return throwHttpError(
      400,
      badRequest(
        `{"$since": true} only works as a top-level argument. Bind it to "${incremental.param}" directly, not inside another value.`,
      ),
    );
  }
  if (topLevel.length > 1) {
    return throwHttpError(
      400,
      badRequest(
        `Only one argument may take {"$since": true} — ${topLevel.map((key) => `"${key}"`).join(", ")} all do. This action reads incrementally through "${incremental.param}".`,
      ),
    );
  }
  const [bound] = topLevel;
  if (bound !== incremental.param) {
    return throwHttpError(
      400,
      badRequest(
        `"${bound}" is not what this action filters by date — bind {"$since": true} to "${incremental.param}" instead. On the wrong argument the app returns everything AND the source stops noticing deleted rows, without ever reporting an error.`,
      ),
    );
  }
};

/**
 * Check a source's arguments against what its action declares, resolving the
 * action only when there is something to check.
 *
 * The gate matters: resolving costs a connection read and, for an MCP
 * connection, a snapshot fetch that can legitimately be "still preparing".
 * Paying that on every create to validate a binding almost no source carries
 * would turn a transient MCP state into a refusal to create anything.
 */
export const assertSinceBindingForSource = async (input: {
  args: SyncArgs;
  teamId: string;
  connectionId?: string | null;
  providerKey: string;
  operation: string;
}): Promise<void> => {
  if (!syncArgsBindSince(input.args)) return;

  if (input.connectionId === undefined || input.connectionId === null) {
    // No connection yet — the source names its provider and the action is the
    // manifest's, which is enough to know the incremental parameter.
    const resolved = getAction(`${input.providerKey}.${input.operation}`);
    assertSinceBinding(input.args, resolved?.action.incremental);
    return;
  }

  const connection = await db.query.externalAppConnections.findFirst({
    where: { id: input.connectionId, teamId: input.teamId },
  });
  if (connection === undefined) return;

  const resolved = await resolveSyncAction(connection, input.operation);
  if (!resolved.ok) {
    // The action cannot be read, and the argument being checked is the one
    // whose misuse is silent. Refusing here is the safe direction: the source
    // is not created, and the message says what to do.
    return throwHttpError(
      400,
      badRequest(
        `This source binds {"$since": true}, which only works on the argument the action declares as incremental — and that action cannot be read right now (${resolved.message}). Try again once it resolves, or remove the binding.`,
      ),
    );
  }
  assertSinceBinding(input.args, resolved.action.incremental);
};
