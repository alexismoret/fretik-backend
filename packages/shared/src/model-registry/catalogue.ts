import type { CatalogueReasoning, EndpointStat, TransportId } from "./types";

/**
 * What a transport's catalogue says about a model, in ONE shape.
 *
 * The sync was written against the Vercel gateway specifically: the gateway
 * catalogue was "the catalogue", OpenRouter was "the enrichment", and discovery
 * could only ever find models on the gateway. The asymmetry was invisible until
 * it produced a concrete defect — 110 discovered candidates, every one carrying
 * a gateway id and nothing else, on a fleet that runs entirely on OpenRouter.
 * Promoting any of them moved a model onto a transport the fleet does not use
 * and stripped it of the enrichment only the other transport publishes.
 *
 * So the catalogue is an INTERFACE, each transport normalises its own dialect
 * behind it, and a model is described by the UNION of what its catalogues know.
 * The dialects differ in ways worth naming, because absorbing them is the whole
 * job:
 *
 * | fact              | Vercel gateway            | OpenRouter                      | Scaleway                          |
 * |-------------------|---------------------------|---------------------------------|-----------------------------------|
 * | input modalities  | inferred from TAGS        | `architecture.input_modalities` | `tasks` on the price list         |
 * | release date      | `released` (Unix seconds) | `created` (Unix seconds)        | absent (its stamp dates the LISTING) |
 * | max output        | `max_tokens`              | `top_provider.max_completion…`  | published specifications          |
 * | owner             | `owned_by`                | absent — read from the id       | `provider_name` on the price list |
 * | model type        | `type: "language"`        | absent                          | `supported_apis`                  |
 * | zero retention    | `zdr: all\|some\|none`     | absent here; a per-route list   | platform-wide, applied per endpoint |
 * | tools / reasoning | `supported_parameters`    | `supported_parameters`          | specifications + `reasoning` flag |
 * | price             | catalogue, USD per token  | catalogue, USD per token        | product catalogue, EUR per 1k     |
 *
 * The `tools / reasoning` row is what simplifies everything downstream:
 * measured across all 239 gateway language models on 2026-08-30,
 * `supported_parameters` and the `tool-use` / `reasoning` TAGS agree in every
 * single case. So capability derivation reads parameters on all transports,
 * and each source's job is to fill that array in its own dialect.
 *
 * Scaleway stretches the interface in the two places worth naming, and both
 * were design pressure the aggregators never applied. It takes THREE fetches
 * to describe one model — the served list, a product catalogue, and published
 * specifications — which is why a source is a factory holding a per-pass
 * snapshot rather than a bare function. And its context window is genuinely
 * its own rather than the model's, which is what forced merged sizes onto the
 * `smallest` rule below.
 */
export interface CataloguePricing {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface CatalogueEntry {
  /** The model id IN THIS TRANSPORT'S SPELLING. */
  id: string;
  name: string;
  description: string;
  /** Upstream author (`anthropic`, `google`) — the model's `family`. */
  owner: string;
  /** Absent outside language models — a speech model has no context window. */
  contextWindow?: number;
  maxTokens?: number;
  /**
   * `text` is always present; `image`, `file`, `audio`, `video` appear only
   * where the catalogue says so. A source that INFERS these rather than reading
   * them says so through `capabilities.publishesModalities`, and the merge
   * prefers the source that knows.
   */
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  /**
   * The model's REASONING CONTRACT, where the catalogue publishes one.
   *
   * `supportedParameters` answers "can this model reason at all"; this answers
   * the question the product actually asks — WHICH depths may be requested.
   * Measured 2026-08-30 on the 396-model OpenRouter catalogue: 271 entries
   * carry a contract and 130 of those name the exact ladder, spanning eleven
   * distinct shapes (`high/medium/low`, `max/xhigh/high/medium/low`,
   * `high/medium/low/minimal`, …). Nothing derives one shape from another.
   *
   * Load-bearing rather than descriptive: `selectableReasoningLevels` builds the
   * depth menu from this list, so a model discovered without it offers NO depth
   * control at all — which is what every promoted model got until this field
   * existed.
   *
   * `undefined` means the catalogue said nothing, never that the model cannot
   * reason. An empty `supportedEfforts` with `mandatory` present means it
   * reasons on a budget rather than a ladder (Claude Haiku 4.5, MiniMax M3).
   */
  reasoning?: CatalogueReasoning;
  pricing: CataloguePricing;
  /**
   * The catalogue's own zero-retention claim, where it makes one. A useful
   * PRE-FILTER — discovery does not spend an endpoint fetch on a `none` — but
   * never a verdict: `some` says nothing about the endpoints our pool actually
   * routes to. `undefined` must read as "unknown", never as "no".
   */
  zdr?: "all" | "some" | "none";
  releasedAt?: Date;
  /**
   * Whether this is a language model. `undefined` from a catalogue that does
   * not classify — which is not the same as `false`, and discovery must not
   * treat it as a rejection.
   */
  isLanguageModel?: boolean;
  /**
   * Still served, but past its feature life and dated for removal. Discovery
   * skips these; an already-published row keeps working, because withdrawing a
   * model the moment its retirement is announced is a bigger outage than the
   * retirement.
   *
   * Only a catalogue that publishes a lifecycle can set it. `undefined` means
   * the source does not say, which is why the merge requires EVERY serving
   * catalogue to agree before a model counts as retiring.
   */
  deprecated?: boolean;
}

/**
 * What a catalogue can actually answer.
 *
 * Declared rather than discovered, because the difference between "this source
 * says no" and "this source cannot say" decides whether a filter may run at
 * all. Discovery that applied the gateway's `type === "language"` test to a
 * catalogue with no `type` would reject the entire catalogue silently.
 */
export interface CatalogueCapabilities {
  /** Distinguishes language models from embedding, image and speech ones. */
  identifiesModelType: boolean;
  /** Reads modalities from the response rather than inferring them from tags. */
  publishesModalities: boolean;
  /** Names the upstream author, rather than leaving it to the id prefix. */
  publishesOwner: boolean;
  publishesReleaseDate: boolean;
  /** Carries a per-model zero-retention hint usable as a cheap pre-filter. */
  publishesZdrHint: boolean;
  /**
   * Publishes the reasoning CONTRACT (which depths exist), not merely the
   * `reasoning` parameter. Declared for the same reason the others are: a
   * source that cannot say must never erase what a source that can already
   * said, and silence here is not "this model has no ladder".
   */
  publishesReasoningContract: boolean;
  /**
   * The measurement families this catalogue can EVER publish per endpoint.
   * They decide how an unanswered policy rule is reported: data a source
   * publishes but did not return is `not-measured` (repairable — a credential,
   * an idle host), data it structurally cannot return is
   * `not-published-by-source` (nothing an operator can fix tonight).
   */
  publishesPercentiles: boolean;
  /** `supports_tool_choice` — OpenRouter is the only source that reports it. */
  publishesToolChoice: boolean;
  publishesUptime: boolean;
}

/**
 * One transport's view of what exists and how it performs.
 *
 * Built per pass by a factory, so a source needing to prefetch something for
 * the whole catalogue — OpenRouter's zero-retention route list is the live
 * example — holds it in a closure and spends one request rather than one per
 * model. That state is the source's own business and never reaches the sync.
 */
export interface CatalogueSource {
  id: TransportId;
  capabilities: CatalogueCapabilities;
  /**
   * Every model this transport serves. THROWS on an unreadable catalogue; the
   * caller decides whether that is fatal, because it depends on whether this is
   * the only source left standing.
   */
  listModels: () => Promise<CatalogueEntry[]>;
  /**
   * Per-provider figures for one model. Returns `[]` for a model this transport
   * does not serve — the catalogues do not overlap, and that is normal.
   */
  fetchEndpoints: (modelId: string) => Promise<EndpointStat[]>;
}

/** One model as every catalogue that serves it describes it, together. */
export interface MergedCatalogueEntry extends CatalogueEntry {
  /** Its id on each transport that serves it — what `modelIds` is seeded from. */
  idsByTransport: Partial<Record<TransportId, string>>;
}

/**
 * Which transport a NEW row should route through, read off the fleet.
 *
 * Registry order decided this until 2026-09-02, and it was the wrong default
 * wearing a neutral face: that order exists to settle which catalogue's
 * spelling of an id becomes canonical, and it puts the aggregators first for
 * that reason alone. Every model both transports serve was therefore born on
 * the gateway while all 22 published models routed through OpenRouter — so
 * adding a model produced a row on the transport nobody uses, and a human had
 * to switch it. A manual step invented by an implementation detail.
 *
 * Published rows only: candidates are what this is choosing for, so counting
 * them would let one accidental default breed. A tie and an empty fleet both
 * answer `undefined` — a first environment has no fleet to follow, and a fleet
 * evenly split states no preference — which sends the caller back to registry
 * order.
 */
export const preferredTransport = (
  publishedTransports: readonly TransportId[],
  idsByTransport: Partial<Record<TransportId, string>>,
): TransportId | undefined => {
  const counts = new Map<TransportId, number>();
  for (const transport of publishedTransports) {
    if (idsByTransport[transport] === undefined) continue;
    counts.set(transport, (counts.get(transport) ?? 0) + 1);
  }
  const [first, second] = [...counts].sort(([, a], [, b]) => b - a);
  if (first === undefined) return undefined;
  return second !== undefined && second[1] === first[1] ? undefined : first[0];
};

/**
 * The comparable part of a model id.
 *
 * The CREATOR segment is deliberately discarded: the catalogues disagree on it
 * constantly and in both directions — `alibaba/qwen3-max` against
 * `qwen/qwen3-max`, `spacexai/grok-4.5` against `x-ai/grok-4.5` — while the
 * model segment is the name the vendor published and matches character for
 * character once punctuation is folded. Matching on the half that agrees beats
 * maintaining a table of the half that does not.
 */
export const catalogueMatchKey = (id: string): string =>
  (id.split("/").at(-1) ?? id).toLowerCase().replace(/[^a-z0-9]/g, "");

/** Prefer a value the source vouches for, then anything already known. */
const pick = <T>(
  authoritative: boolean,
  incoming: T | undefined,
  current: T | undefined,
): T | undefined =>
  incoming === undefined
    ? current
    : authoritative || current === undefined
      ? incoming
      : current;

/**
 * The SMALLEST of the sizes the catalogues quote.
 *
 * Context length and output cap are the two fields where the catalogues can
 * legitimately disagree, because they are not properties of the model — they
 * are properties of what each transport will accept. Scaleway caps serverless
 * context below the weights' own limit while a model is in preview:
 * `deepseek-v4-flash-0731` answers to 256k there against the 997,952 an
 * aggregator advertises, a factor of 3.9.
 *
 * Taking the smallest is the same rule `computeEffectiveContext` already
 * applies inside a pool, for the same reason — a limit is only real if every
 * route honours it, and overshooting is a failed request while undershooting is
 * a slightly early compaction. It also removes an ordering dependency that was
 * there before Scaleway existed: the previous rule let the LAST catalogue in
 * the list win outright, so the fleet's context numbers moved with the order
 * the sources happened to be registered in.
 */
const smallest = (
  incoming: number | undefined,
  current: number | undefined,
): number | undefined =>
  incoming === undefined
    ? current
    : current === undefined
      ? incoming
      : Math.min(incoming, current);

/**
 * The modalities EVERY publishing catalogue agrees on.
 *
 * Modalities are per-transport for the same reason sizes are: a transport can
 * serve a model without accepting everything the weights accept. Measured
 * 2026-08-30 — OpenRouter serves `qwen3.5-397b-a17b` with `video` input,
 * Scaleway serves the same model with `chat, code, vision` and no video at all.
 *
 * The intersection is the safe direction, and the two errors are not
 * symmetrical. Claiming a modality the serving transport does not accept sends
 * a part it rejects, which fails the turn. Omitting one it would have accepted
 * costs a native path that already has a fallback — `prepareModelMessages`
 * strips anything the profile's `nativeInput` does not cover and routes it
 * through the `read` / `vision` tools instead.
 *
 * Only sources that DECLARE modalities take part. A source that infers them
 * from tags cannot narrow anyone: its silence about audio is ignorance, not a
 * refusal.
 */
const intersect = (
  incoming: readonly string[],
  current: readonly string[],
): string[] => incoming.filter((modality) => current.includes(modality));

/**
 * Fold every catalogue into one model list.
 *
 * Three rules, and all three exist to avoid a confident wrong answer:
 *
 * 1. **A capability beats an inference.** Where a source declares it publishes
 *    a fact, its value wins; where it merely infers one, it fills a gap and
 *    never overwrites. So OpenRouter's explicit `architecture.input_modalities`
 *    replaces the gateway's two-tag guess, while the gateway's `owned_by` keeps
 *    naming `alibaba` where OpenRouter offers only an id prefix.
 * 2. **An ambiguous name is dropped, not resolved.** A model whose folded name
 *    is claimed by two different ids in the SAME catalogue is exactly the case
 *    where a guess routes one vendor's traffic to another's model, so it is
 *    matched by nothing and simply keeps whichever identity it already had.
 * 3. **Where two publishers disagree, the answer every transport can honour
 *    wins** — the smallest size, the intersected modality list. These are the
 *    fields that are not properties of the MODEL but of what a transport will
 *    accept, and a merged value that only one of them honours is a runtime
 *    failure on every turn routed to the other.
 */
export const mergeCatalogues = (
  listings: readonly { source: CatalogueSource; entries: CatalogueEntry[] }[],
): MergedCatalogueEntry[] => {
  const merged = new Map<string, MergedCatalogueEntry>();
  /**
   * Models whose modalities came from a source that DECLARES them. It decides
   * whether the next declaring source narrows the list or replaces it — an
   * inference must not be intersected with, or the gateway's two-tag guess
   * would delete the audio input only one catalogue can see.
   */
  const declaredModalities = new Set<string>();
  for (const { source, entries } of listings) {
    const seen = new Map<string, CatalogueEntry>();
    const ambiguous = new Set<string>();
    for (const entry of entries) {
      const key = catalogueMatchKey(entry.id);
      if (key.length === 0) continue;
      if (seen.has(key)) ambiguous.add(key);
      else seen.set(key, entry);
    }
    for (const key of ambiguous) seen.delete(key);

    const can = source.capabilities;
    for (const [key, entry] of seen) {
      const current = merged.get(key);
      if (current === undefined) {
        if (can.publishesModalities) declaredModalities.add(key);
        merged.set(key, {
          ...entry,
          idsByTransport: { [source.id]: entry.id },
        });
        continue;
      }
      // Narrow against a list another publisher stated; replace one that was
      // only ever inferred.
      const narrows = can.publishesModalities && declaredModalities.has(key);
      if (can.publishesModalities) declaredModalities.add(key);
      merged.set(key, {
        ...current,
        idsByTransport: { ...current.idsByTransport, [source.id]: entry.id },
        name: current.name || entry.name,
        description: current.description || entry.description,
        owner: can.publishesOwner ? entry.owner : current.owner,
        contextWindow: smallest(entry.contextWindow, current.contextWindow),
        maxTokens: smallest(entry.maxTokens, current.maxTokens),
        inputModalities: !can.publishesModalities
          ? current.inputModalities
          : narrows
            ? intersect(entry.inputModalities, current.inputModalities)
            : entry.inputModalities,
        outputModalities: !can.publishesModalities
          ? current.outputModalities
          : narrows
            ? intersect(entry.outputModalities, current.outputModalities)
            : entry.outputModalities,
        // The union: a parameter either catalogue advertises is one some
        // endpoint accepts, and the pool is filtered per endpoint anyway.
        supportedParameters: [
          ...new Set([
            ...current.supportedParameters,
            ...entry.supportedParameters,
          ]),
        ],
        // Taken from a source that publishes contracts, kept otherwise. NOT
        // unioned like the parameter list: a ladder is a closed set the upstream
        // accepts, so merging two would offer rungs one of them rejects — and
        // `require_parameters` turns a rejected rung into an empty pool rather
        // than a dropped field.
        reasoning: can.publishesReasoningContract
          ? (entry.reasoning ?? current.reasoning)
          : current.reasoning,
        // Price is per-transport too, and deliberately NOT reconciled: the
        // first catalogue that quotes one wins, and nothing downstream spends
        // money on it. A row's real price is `computePoolPricing` over the
        // endpoints of ITS OWN transport, which is what the budget cap, the
        // credit multiplier and the cost display all read. What survives here
        // is a coarse discovery band, and inventing a cross-transport average
        // for it would describe a price nobody charges.
        pricing: {
          inputPerMTok: pick(
            false,
            entry.pricing.inputPerMTok,
            current.pricing.inputPerMTok,
          ),
          outputPerMTok: pick(
            false,
            entry.pricing.outputPerMTok,
            current.pricing.outputPerMTok,
          ),
          cacheReadPerMTok: pick(
            false,
            entry.pricing.cacheReadPerMTok,
            current.pricing.cacheReadPerMTok,
          ),
          cacheWritePerMTok: pick(
            false,
            entry.pricing.cacheWritePerMTok,
            current.pricing.cacheWritePerMTok,
          ),
        },
        zdr: can.publishesZdrHint ? entry.zdr : current.zdr,
        releasedAt: can.publishesReleaseDate
          ? (entry.releasedAt ?? current.releasedAt)
          : current.releasedAt,
        isLanguageModel: can.identifiesModelType
          ? entry.isLanguageModel
          : current.isLanguageModel,
        // Retirement is a TRANSPORT's decision, so it takes every serving
        // catalogue to retire a model: one host winding a model down while
        // another still ships it is a reason to route elsewhere, not a reason
        // to stop discovering it. A source that publishes no lifecycle says
        // nothing, and nothing does not agree.
        deprecated:
          (current.deprecated ?? false) && (entry.deprecated ?? false),
      });
    }
  }
  return [...merged.values()];
};
