import type { ExternalAppConnection } from "../../../db/schema";
import { getProvider } from "../../../external-apps/registry";
import { RedisLockTimeoutError, withRedisLock } from "../../../lib/redis-lock";

/**
 * Hold the one slot a SERIAL connection has, for as long as the call takes.
 *
 * Most third parties are happy to answer several questions at once, and for
 * them this is a function call and nothing else — no Redis, no lock, no cost.
 * The exception is an API where a call is not self-contained. Akanea WMS leases
 * a LICENCE SEAT per action (`GetToken` … work … `ReleaseToken`), so a page
 * loading six widgets over one account asks for six seats simultaneously, and
 * the ones past the pool's size come back with no token — which on the wire is
 * indistinguishable from wrong credentials, so the user is told to check a
 * password that was never wrong.
 *
 * The lock is keyed by CONNECTION, not by provider or by team: two accounts on
 * the same app have two independent seat pools, and one team's fan-out must not
 * queue behind another's.
 *
 * NOT REENTRANT. Take it at exactly one level of the call stack — a second
 * acquire on the same key from inside the critical section waits out the whole
 * budget and then fails. See the call-site table in `read-executor.ts`.
 */

/** The wait budget ran out with the connection still busy. */
export class ConnectionBusyError extends Error {
  constructor(
    readonly connectionId: string,
    readonly displayName: string,
    readonly waitedMs: number,
  ) {
    super(
      `"${displayName}" answers one request at a time and was still busy after ${(waitedMs / 1000).toString()}s — too many things are asking it at once. Ask it fewer times (raise a dataset's cacheTtlSeconds, or fold several reads into one), then retry.`,
    );
    this.name = "ConnectionBusyError";
  }
}

/** Used when a connection is serial but nothing declares a budget — an MCP
 *  server has no manifest to read one from. */
const DEFAULT_MAX_WAIT_MS = 8_000;

type SlotConnection = Pick<
  ExternalAppConnection,
  "id" | "providerKey" | "displayName" | "concurrencyMode"
>;

/**
 * The connection's own setting wins over the provider's: the same app is not
 * the same everywhere, and only the operator knows how many seats this account
 * bought.
 */
const resolveConcurrency = (
  connection: SlotConnection,
): { serial: boolean; maxWaitMs: number } => {
  const declared = getProvider(connection.providerKey)?.manifest.concurrency;
  const mode = connection.concurrencyMode ?? declared?.mode ?? "parallel";
  return {
    serial: mode === "serial",
    maxWaitMs: declared?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
  };
};

export const withConnectionSlot = async <T>(
  connection: SlotConnection,
  fn: () => Promise<T>,
  opts: {
    /**
     * How long the slot may be held before it is assumed abandoned. Must
     * comfortably EXCEED the caller's own timeout — a lease that expires under
     * a live holder is the one way two calls end up overlapping, which is
     * exactly what this exists to prevent.
     */
    leaseMs: number;
  },
): Promise<T> => {
  const { serial, maxWaitMs } = resolveConcurrency(connection);
  if (!serial) return await fn();

  try {
    return await withRedisLock(`lock:ext-conn:${connection.id}`, fn, {
      ttlMs: opts.leaseMs,
      maxWaitMs,
    });
  } catch (error) {
    if (error instanceof RedisLockTimeoutError) {
      throw new ConnectionBusyError(
        connection.id,
        connection.displayName,
        maxWaitMs,
      );
    }
    throw error;
  }
};

/**
 * Whether calls on this connection must not overlap — for callers that need to
 * ORDER work rather than block on it. `run-page-data` uses it to run a serial
 * connection's datasets one after another instead of letting them all pile onto
 * the lock, which turns contention into a queue nobody has to wait out.
 */
export const isSerialConnection = (connection: SlotConnection): boolean =>
  resolveConcurrency(connection).serial;
