/**
 * Carry a BYOK call's real price from where the provider states it to where
 * the readers can reach it.
 *
 * Under BYOK the upstream bills OUR key directly, so the aggregator invoices
 * nothing and `usage.cost` is 0 — which is how a BYOK generation came to read
 * as free on every cost surface at once (measured 2026-09-18: a $0.0026
 * DeepSeek call on BaseTen reported $0). The real figure is on the wire, as
 * `cost_details.upstream_inference_cost`, but reading it needs `is_byok`,
 * because that same field ALSO appears on ordinary calls where it merely
 * restates the bill (see `readByokUpstreamCost`).
 *
 * And `is_byok` is exactly the field that does not survive. The AI SDK keeps
 * the provider's unsanitised usage block on `usage.raw` at the MODEL layer,
 * where a middleware sees it — verified on a live stream — but the core drops
 * `raw` when it aggregates a step, so `result.usage.raw` is `undefined` and
 * anything reading a finished step is blind to it. `providerMetadata` is the
 * channel that does survive that aggregation, and it is already how every
 * cost reader in the service gets its number.
 *
 * So this middleware does one thing: when a call was BYOK, it copies the
 * upstream charge into the transport's metadata namespace under a key that is
 * visibly ours. `extractOpenRouterReport` then adds it to the aggregator's own
 * figure, and Langfuse, the turn ledger and the pool's cost ranking are all
 * corrected by that one read.
 *
 * UNCONDITIONAL, like the detectors and the passive telemetry it sits beside
 * in `instrumentModel`, and for the same reason: the pool ranks hosts on cost,
 * so a host that reports zero does not merely look cheap on a dashboard — it
 * wins the comparison against every host honest enough to report what it
 * charges. That must not depend on an observability vendor being configured.
 */
import type {
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { TransformStream } from "node:stream/web";
import {
  BYOK_UPSTREAM_COST_KEY,
  readByokUpstreamCost,
} from "./model-registry/transports/openrouter";

/**
 * Return `metadata` with the BYOK charge folded into its `openrouter.usage`
 * block, or unchanged when there is nothing to fold.
 *
 * Everything else is copied through untouched — this adds one key and is
 * never allowed to drop another, because the same block carries the serving
 * provider, the token breakdown and the reasoning details that four other
 * readers depend on.
 */
/**
 * A plain JSON object, narrowed in a way `Array.isArray` cannot manage here:
 * the SDK's `JSONValue` admits READONLY arrays, and TypeScript's
 * `Array.isArray` guard does not remove `readonly T[]` from a union — so the
 * inline three-part check reads as correct and still leaves an array in the
 * narrowed type.
 */
const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withByokCost = (
  metadata: SharedV4ProviderMetadata | undefined,
  rawUsage: unknown,
): SharedV4ProviderMetadata | undefined => {
  const byok = readByokUpstreamCost(rawUsage);
  if (byok === undefined || metadata?.openrouter === undefined) return metadata;
  const openrouter = metadata.openrouter;
  // The namespace has to be a plain object before it can be spread. `Array`
  // is a legal `JSONValue`, and spreading one into an object position yields
  // `{ "0": …, "1": … }` — a metadata shape none of the four readers
  // downstream would recognise, produced silently.
  if (!isJsonRecord(openrouter)) return metadata;
  const usage = openrouter["usage"];
  // A provider that answered with no usage block at all told us nothing to
  // extend, and inventing one would put a cost on a call with no tokens.
  if (!isJsonRecord(usage)) return metadata;
  return {
    ...metadata,
    openrouter: {
      ...openrouter,
      usage: { ...usage, [BYOK_UPSTREAM_COST_KEY]: byok },
    },
  };
};

export const byokCostCarrierMiddleware: LanguageModelV4Middleware = {
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    return {
      ...result,
      providerMetadata: withByokCost(result.providerMetadata, result.usage.raw),
    };
  },
  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();
    const tapped = stream.pipeThrough(
      new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>(
        {
          transform: (part, controller) => {
            // The terminal `finish` part is the only one carrying both the raw
            // usage and the metadata, so it is the only one to rewrite.
            controller.enqueue(
              part.type === "finish"
                ? {
                    ...part,
                    providerMetadata: withByokCost(
                      part.providerMetadata,
                      part.usage.raw,
                    ),
                  }
                : part,
            );
          },
        },
      ),
    );
    return { stream: tapped, ...rest };
  },
};
