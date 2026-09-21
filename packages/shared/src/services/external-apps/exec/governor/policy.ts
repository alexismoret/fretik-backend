import type { ExternalAppConnection } from "../../../../db/schema";
import type {
  ProviderRateLimit,
  RateBudget,
} from "../../../../external-apps/manifest-schema";
import { getProvider } from "../../../../external-apps/registry";
import { intFromEnv, intFromEnvAllowingZero } from "../../../../lib/env";

/**
 * What this connection is allowed to ask of its app — resolved once, from four
 * places that disagree on purpose.
 *
 * Pure: it reads the connection row, the manifest and the environment, and
 * touches nothing. That is what makes the precedence testable, and the
 * precedence is the whole point of the file — every layer here exists because
 * one of the others cannot express something.
 *
 * `maxConcurrent`, most-specific first:
 *
 *  1. `connection.max_concurrent` — the operator's number. It outranks the
 *     mode below because a number says everything a mode says and more: an
 *     account with five licence seats should not be held to one by a flag set
 *     when the only choice was "one or unlimited".
 *  2. `connection.concurrency_mode = 'serial'` → 1. The pre-existing override,
 *     still the only way to tame an MCP server (no manifest to read).
 *  3. `manifest.rateLimit.maxConcurrent` — what the provider declares.
 *  4. `manifest.concurrency.mode = 'serial'` → 1. What akanea-wms, ftp-sftp and
 *     pbyp declare today.
 *  5. unlimited.
 *
 * The request budget, most-specific first: the connection's own columns, then
 * `manifest.rateLimit.perConnection`, then the process default. The process
 * default is NOT a guess about the app — it is a floor under our own fan-out,
 * because a page with forty datasets will otherwise ask forty questions in one
 * tick of whatever it is pointed at. `0` turns it off.
 *
 * `perProvider` has no default and no connection-level override. It is shared
 * by every account of the provider in this deployment, so it can only come from
 * a manifest — one team must not be able to widen or narrow a ceiling every
 * other team is behind.
 */

/** Unlimited, as the Lua script reads it. */
const UNLIMITED = 0;

export interface GovernorPolicy {
  connectionId: string;
  providerKey: string;
  displayName: string;
  perConnection: RateBudget | undefined;
  perProvider: RateBudget | undefined;
  /** 0 = unlimited. */
  maxConcurrent: number;
  /** Extra header names this app answers a 429 with. */
  retryAfterHeaders: readonly string[];
  /** How long an interactive caller may wait for a permit before giving up. */
  maxWaitMs: number;
  /** What to assume when a 429 arrives with nothing to read. */
  defaultRetryAfterMs: number;
  /** Ceiling on any single block, however long the app says to wait. */
  maxBlockMs: number;
}

export type PolicyConnection = Pick<
  ExternalAppConnection,
  | "id"
  | "providerKey"
  | "displayName"
  | "concurrencyMode"
  | "rateLimitRequests"
  | "rateLimitPerSeconds"
  | "maxConcurrent"
>;

const manifestRateLimit = (
  providerKey: string,
): ProviderRateLimit | undefined =>
  getProvider(providerKey)?.manifest.rateLimit;

const manifestIsSerial = (providerKey: string): boolean =>
  getProvider(providerKey)?.manifest.concurrency?.mode === "serial";

const resolveMaxConcurrent = (connection: PolicyConnection): number => {
  if (connection.maxConcurrent !== null && connection.maxConcurrent > 0) {
    return connection.maxConcurrent;
  }
  if (connection.concurrencyMode === "serial") return 1;
  const declared = manifestRateLimit(connection.providerKey)?.maxConcurrent;
  if (declared !== undefined) return declared;
  if (manifestIsSerial(connection.providerKey)) return 1;
  return UNLIMITED;
};

const resolvePerConnection = (
  connection: PolicyConnection,
): RateBudget | undefined => {
  if (
    connection.rateLimitRequests !== null &&
    connection.rateLimitRequests > 0 &&
    connection.rateLimitPerSeconds !== null &&
    connection.rateLimitPerSeconds > 0
  ) {
    return {
      requests: connection.rateLimitRequests,
      perSeconds: connection.rateLimitPerSeconds,
    };
  }
  const declared = manifestRateLimit(connection.providerKey)?.perConnection;
  if (declared !== undefined) return declared;

  const perMinute = intFromEnvAllowingZero(
    "EXTERNAL_APP_DEFAULT_RATE_PER_MINUTE",
    300,
  );
  return perMinute > 0 ? { requests: perMinute, perSeconds: 60 } : undefined;
};

export const resolveGovernorPolicy = (
  connection: PolicyConnection,
): GovernorPolicy => {
  const rateLimit = manifestRateLimit(connection.providerKey);
  const header = rateLimit?.retryAfterHeader;
  return {
    connectionId: connection.id,
    providerKey: connection.providerKey,
    displayName: connection.displayName,
    perConnection: resolvePerConnection(connection),
    perProvider: rateLimit?.perProvider,
    maxConcurrent: resolveMaxConcurrent(connection),
    retryAfterHeaders: header === undefined ? [] : [header],
    // The budget the serial slot used to have, kept: it is the one measured
    // number here — long enough to absorb a page's fan-out, short enough that
    // a stuck holder costs one widget a message rather than the whole render.
    maxWaitMs:
      getProvider(connection.providerKey)?.manifest.concurrency?.maxWaitMs ??
      intFromEnv("EXTERNAL_APP_MAX_WAIT_MS", 8_000),
    defaultRetryAfterMs: intFromEnv(
      "EXTERNAL_APP_DEFAULT_RETRY_AFTER_MS",
      30_000,
    ),
    maxBlockMs: intFromEnv("EXTERNAL_APP_MAX_BLOCK_MS", 15 * 60 * 1000),
  };
};

/**
 * Whether calls on this connection must not overlap — for callers that ORDER
 * work rather than block on it. `run-page-data` uses it to run such a
 * connection's datasets one after another instead of letting them all pile onto
 * the permit, which turns contention into a queue nobody has to wait out.
 *
 * Replaces `isSerialConnection`: the question is no longer "is the mode
 * serial" but "does one call at a time get through", which a `maxConcurrent` of
 * 1 also answers.
 */
export const isSingleFlightConnection = (
  connection: PolicyConnection,
): boolean => resolveMaxConcurrent(connection) === 1;
