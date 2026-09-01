import type { TransportId } from "../../../model-registry/types";
import { fetchJson } from "../sync/sources/wire";

/**
 * Does this upstream mutilate an answer that ends in a tool call?
 *
 * The one question no catalogue answers and the one that decides pool
 * membership. Every agent turn ends exactly like this — some prose, then a
 * tool call — and a host that truncates the prose at that boundary does not
 * error: it returns a valid response with the last sentence cut. Measured on
 * Together in 2026-08, which is why `intact` is the bench column that overrides
 * every other one.
 *
 * ## Why this exists when the detectors already watch for it
 *
 * On a PUBLISHED model it would be redundant: `truncated-at-tool-call` is
 * detected on real traffic by `lib/model-detectors.ts` and the breaker
 * quarantines on four corroborating generations. That signal is strictly
 * better than a synthetic one — it is free, continuous, and measures the exact
 * prompts customers send.
 *
 * CANDIDATES are the gap, and it is the gap that matters. A candidate is never
 * called, so nothing watches it, and the moment somebody needs to know is
 * PROMOTION — the one decision this system deliberately leaves to a person.
 * Sending them to that decision with no evidence is what made a bench a manual
 * errand nobody ran; the point of probing here is that the evidence is already
 * on the scorecard when they arrive.
 *
 * ## What it costs
 *
 * A handful of tokens. One short completion per run, `max_tokens` in the low
 * hundreds, three runs per upstream. That is the whole reason this half of the
 * bench can be automated while the decode and cache measurements — 4096-token
 * generations and 75k-token prefixes, dollars per model — cannot.
 */

/**
 * The sentence and the call. Deliberately short and fully specified so the
 * check is an EQUALITY rather than a judgement: a probe that needed a model to
 * grade it would inherit that model's failure modes.
 *
 * Kept byte-identical to the one `models:bench` uses, so a scheduled probe and
 * a hand-run bench produce comparable rows rather than two dialects of the
 * same column.
 */
export const INTEGRITY_SENTENCE = "Je vérifie la météo de Paris maintenant.";

const INTEGRITY_PROMPT = `Écris exactement cette phrase, mot pour mot, sans rien ajouter : « ${INTEGRITY_SENTENCE} » Puis appelle l'outil get_weather avec city=Paris.`;

const INTEGRITY_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

/**
 * Runs per upstream. Three, because one truncation is a fluke and this decides
 * whether a host is offered to teams; and only three, because the cost of the
 * probe is what makes it schedulable at all.
 */
export const INTEGRITY_RUNS = 3;

const PROBE_TIMEOUT_MS = 30_000;

/** How each transport spells "serve this from exactly this host". */
interface PinnedChat {
  url: string;
  apiKeyEnv: string;
  /** The routing envelope, merged into the request body. */
  envelope: (wireName: string) => Record<string, unknown>;
}

const PINNED_CHAT: Partial<Record<TransportId, PinnedChat>> = {
  gateway: {
    url: "https://ai-gateway.vercel.sh/v1/chat/completions",
    apiKeyEnv: "AI_GATEWAY_API_KEY",
    envelope: (wireName) => ({
      providerOptions: { gateway: { only: [wireName] } },
    }),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    apiKeyEnv: "OPENROUTER_API_KEY",
    // `allow_fallbacks: false` is what makes the pin binding. Without it
    // OpenRouter treats `only` as a preference, so a refusing host would be
    // silently replaced by a working one and every upstream would score
    // perfectly — a probe that cannot fail.
    envelope: (wireName) => ({
      provider: { only: [wireName], allow_fallbacks: false },
    }),
  },
  // scaleway is absent on purpose: one host serves every model, so there is
  // nothing to pin and nothing to compare. Its integrity is watched the same
  // way a published model's is — on real traffic, by the detectors.
};

/** Whether a transport can be probed per upstream at all. */
export const canProbeIntegrity = (transport: TransportId): boolean =>
  PINNED_CHAT[transport] !== undefined;

export interface IntegrityResult {
  provider: string;
  passed: number;
  total: number;
  /** Runs that never produced a verdict — refusals, timeouts, rate limits. */
  inconclusive: number;
  note?: string;
}

const contentOf = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null || !("choices" in body)) {
    return undefined;
  }
  const { choices } = body;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null || !("message" in first)) {
    return undefined;
  }
  const { message } = first;
  if (
    typeof message !== "object" ||
    message === null ||
    !("content" in message)
  ) {
    return undefined;
  }
  return typeof message.content === "string" ? message.content : "";
};

/**
 * Probe one upstream. Never throws: this runs in a budgeted sweep, and one
 * unreachable host may not cost the others their measurement.
 *
 * `inconclusive` is separate from a failure on purpose, and it is the same
 * distinction the release re-probe makes: a 429 or a timeout says nothing
 * about whether the host truncates, and scoring it as a failure would exclude
 * a good host on the strength of a bad minute.
 */
export const probeIntegrity = async (input: {
  transport: TransportId;
  modelId: string;
  provider: string;
  wireName: string;
  runs?: number;
}): Promise<IntegrityResult | undefined> => {
  const dialect = PINNED_CHAT[input.transport];
  if (dialect === undefined) return undefined;
  const apiKey = Bun.env[dialect.apiKeyEnv];
  if (!apiKey) return undefined;

  const total = input.runs ?? INTEGRITY_RUNS;
  let passed = 0;
  let inconclusive = 0;
  let note: string | undefined;

  for (let run = 0; run < total; run += 1) {
    const result = await fetchJson(dialect.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: input.modelId,
        messages: [{ role: "user", content: INTEGRITY_PROMPT }],
        tools: INTEGRITY_TOOLS,
        max_tokens: 300,
        ...dialect.envelope(input.wireName),
      }),
      timeoutMs: PROBE_TIMEOUT_MS,
    });

    if (!result.ok) {
      inconclusive += 1;
      note ??= `${result.status.toString()}: ${result.detail.slice(0, 120)}`;
      continue;
    }
    const content = contentOf(result.body);
    if (content === undefined) {
      inconclusive += 1;
      note ??= "unexpected response shape";
      continue;
    }
    // An EQUALITY on a fixed sentence: the failure being measured is a
    // truncated tail, so "does the whole sentence survive" is the question,
    // and anything fuzzier would start grading style.
    if (content.includes(INTEGRITY_SENTENCE)) passed += 1;
  }

  return {
    provider: input.provider,
    passed,
    total,
    inconclusive,
    ...(note === undefined ? {} : { note }),
  };
};
