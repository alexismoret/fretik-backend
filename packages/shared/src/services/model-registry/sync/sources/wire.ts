import { z } from "zod";
import type { PricingSnapshot } from "../../../../model-registry/types";

/**
 * What the catalogue APIs put on the wire, and how we read it.
 *
 * Three things are shared by every source and belong in one place: the timeout,
 * the failure shape, and the price conversion. The last one is the load-bearing
 * one — BOTH APIs quote USD PER TOKEN as decimal STRINGS (`"0.00000012"`) while
 * everything downstream, from `PricingSnapshot` to the policy ceilings, is USD
 * per 1,000,000 tokens. A single missed conversion is a factor of a million in a
 * number that gates publication and bills credits.
 *
 * Verified against both live endpoint APIs 2026-08-29: prices are strings on the
 * gateway catalogue, on gateway endpoints and on OpenRouter endpoints; only
 * `discount` is ever a number.
 */

/** Every catalogue call. A source that hangs must not hang the run. */
export const SOURCE_TIMEOUT_MS = 20_000;

/**
 * `status: 0` means the call never reached a server (DNS, TLS, timeout, abort).
 * Callers that must not confuse "the upstream said no" with "we could not ask"
 * — the ZDR probe above all — read this field rather than the message.
 */
export type JsonResult =
  { ok: true; body: unknown } | { ok: false; status: number; detail: string };

export const fetchJson = async (
  url: string,
  init?: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  },
): Promise<JsonResult> => {
  try {
    const response = await fetch(url, {
      method: init?.method ?? "GET",
      headers: { accept: "application/json", ...init?.headers },
      ...(init?.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(init?.timeoutMs ?? SOURCE_TIMEOUT_MS),
    });
    if (!response.ok) {
      // The body carries the refusal reason on both APIs — `no_providers_available`
      // on the gateway, a JSON `error.message` on OpenRouter — and the ZDR probe
      // reads it to tell a policy refusal from an outage.
      const detail = await response.text().catch(() => "");
      return {
        ok: false,
        status: response.status,
        detail: detail.slice(0, 500),
      };
    }
    return { ok: true, body: await response.json() };
  } catch (err: unknown) {
    return {
      ok: false,
      status: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
};

/** Prices arrive as decimal strings; a number is accepted in case that changes. */
export const priceSchema = z.union([z.string(), z.number()]).nullish();

/**
 * USD per token → USD per 1,000,000 tokens. Rounded to 6 decimals: a
 * hundred-thousandth of a cent per million tokens is well past any real rate,
 * and it keeps `1.2e-7 * 1e6` from landing on `0.12000000000000001`.
 */
export const perMTok = (
  raw: string | number | null | undefined,
): number | undefined => {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return Math.round(value * 1_000_000 * 1e6) / 1e6;
};

/** Both endpoint APIs spell endpoint prices identically. Verified 2026-08-29. */
export const endpointPricingSchema = z
  .object({
    prompt: priceSchema,
    completion: priceSchema,
    input_cache_read: priceSchema,
    input_cache_write: priceSchema,
  })
  .nullish();

/**
 * An endpoint's prices, or `undefined` when the source quotes neither a prompt
 * nor a completion rate. An unpriceable endpoint is dropped rather than zeroed:
 * a `0` here would drag the pool median toward free and read as a real rate,
 * and `0` is also a LEGITIMATE value the catalogue publishes for free models.
 */
export const toPricingSnapshot = (
  raw: z.infer<typeof endpointPricingSchema>,
): PricingSnapshot | undefined => {
  const inputPerMTok = perMTok(raw?.prompt);
  const outputPerMTok = perMTok(raw?.completion);
  if (inputPerMTok === undefined || outputPerMTok === undefined)
    return undefined;
  return {
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok: perMTok(raw?.input_cache_read),
    cacheWritePerMTok: perMTok(raw?.input_cache_write),
  };
};

/** `alibaba/qwen-3-235b` → `alibaba/qwen-3-235b`, each segment escaped. */
export const encodeModelPath = (modelId: string): string =>
  modelId.split("/").map(encodeURIComponent).join("/");
