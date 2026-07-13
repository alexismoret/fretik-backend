import { Nango } from "@nangohq/node";

/**
 * Lazy-instantiated Nango Node SDK client.
 *
 * Configured by env:
 *  - `NANGO_HOST`        : full URL of the self-hosted Nango server
 *                          (e.g. `https://nango.fretik.com`).
 *  - `NANGO_SECRET_KEY`  : a key with `environment:proxy` and
 *                          `environment:connect_sessions:write` scopes.
 *
 * No tokens or credentials of the end-user's connected apps ever pass
 * through this code path — they stay encrypted inside Nango.
 */

let cached: Nango | undefined;

/**
 * Raw Nango host + secret key. Exposed for code paths the `@nangohq/node`
 * SDK doesn't cover cleanly. Same env contract as `getNangoClient()`.
 */
export const getNangoConfig = (): { host: string; secretKey: string } => {
  const host = Bun.env.NANGO_HOST;
  const secretKey = Bun.env.NANGO_SECRET_KEY;
  if (host === undefined || host === "") {
    throw new Error("NANGO_HOST env var must be set");
  }
  if (secretKey === undefined || secretKey === "") {
    throw new Error("NANGO_SECRET_KEY env var must be set");
  }
  return { host: host.replace(/\/$/, ""), secretKey };
};

export const getNangoClient = (): Nango => {
  if (cached !== undefined) return cached;
  const { host, secretKey } = getNangoConfig();
  cached = new Nango({ host, secretKey });
  return cached;
};
