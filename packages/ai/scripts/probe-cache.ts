/**
 * Two live probes for the things that decide what a turn costs: WHERE a
 * request is routed, and whether the prefix it sends is still cached there.
 *
 * Both run against the ROLE's real resolved model — the same pool, the same
 * `require_parameters` / `zdr` / `max_price` envelope, the same middleware
 * stack — because the question is about production routing, not about a model
 * id. `models:bench` cannot answer either of them: it pins `only: [one host]`
 * per run by design, which is exactly the instrument a routing probe must not
 * use.
 *
 *     bun run probe:cache                      # both probes on `chat`
 *     bun run probe:cache -- --role workflow
 *     bun run probe:cache -- --calls 8 --sticky-only
 *
 * ## Probe A — does the session pin hold?
 *
 * OpenRouter keys sticky routing on `hash(first system message + first
 * non-system message)` unless a `session_id` is supplied, and our system
 * prompt changes every turn, so the default key changes with it. Measured
 * 2026-09-22 on `z-ai/glm-5.3-flash` with `sort: "throughput"` and tools
 * present (so Auto Exacto is active): six calls seeded on Together went
 * CoreWeave ×6 with `cached = 0` every time without a `session_id`, and
 * Together ×6 with 2944/3024 cached (97 %) with one. The pin beats both the
 * throughput sort and Auto Exacto — which is what lets us keep sorting by
 * throughput for the FIRST call of a lane and stop paying for the churn after.
 *
 * ## Probe B — the canary on an undocumented dependency
 *
 * `session_id` reaches the wire only because `@openrouter/ai-sdk-provider`
 * spreads unknown keys of `providerOptions.openrouter` straight into the
 * request body (`doGenerate` and `doStream` both do
 * `{...getArgs(options), ...restOpenrouterOptions}`). Nothing documents that,
 * so it can disappear in a patch release and take the pin with it, silently.
 * Probe B also measures the other half: appending a tool to a request whose
 * prompt is byte-identical dropped the cache from 99 % to 0 % and back to
 * 100 % once the list settled — the tool block is serialized ahead of the
 * messages, so any edit to it invalidates the whole history behind it.
 *
 * Re-run this after every `@openrouter/ai-sdk-provider` bump.
 *
 * Cost: a few cents. Nothing is written anywhere.
 */
import {
  normalizeProviderList,
  normalizeProviderName,
  toWireNames,
  wireNameIndex,
} from "@fretik/shared/model-registry/provider-names";
import { generateText, tool } from "ai";
import { z } from "zod";
import {
  resolveModel,
  warmModelRegistry,
} from "../src/lib/model-registry/resolve";
import { ROLE_BINDINGS } from "../src/lib/model-registry/role-bindings";
import { extractOpenRouterReport } from "../src/lib/model-registry/transports/openrouter";

/**
 * Big enough that every upstream in the pool is willing to cache it. Z.AI
 * caches in blocks and reports nothing at all below its minimum, so a small
 * prefix makes a working provider look like a broken one — measured on a 3 k
 * prompt, CoreWeave reported `cached = 0` on byte-identical repeats that came
 * back 99 % cached at 20 k.
 */
const PREFIX_SENTENCE =
  "You are a careful business assistant. Follow the operating rules precisely and never invent data. ";
const PREFIX_REPEATS = 1_200;

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string): boolean => process.argv.includes(`--${name}`);

// Found by VALUE rather than by key so `binding.role` carries the `ModelRole`
// type — the same reason `check-model-catalog.ts` iterates the values.
const roleArg = flag("role") ?? "chat";
const binding = Object.values(ROLE_BINDINGS).find((b) => b.role === roleArg);
if (binding === undefined) {
  console.error(
    `Unknown role "${roleArg}". Known roles: ${Object.keys(ROLE_BINDINGS).join(", ")}`,
  );
  process.exit(2);
}
const role = binding.role;
const CALLS = Number.parseInt(flag("calls") ?? "6", 10);
/** Long enough that a throughput ranking can move between calls. */
const GAP_MS = Number.parseInt(flag("gap-ms") ?? "12000", 10);

const probeTool = (name: string) =>
  tool({
    description: `Tool ${name} performs a domain operation on business records and returns a structured payload for the agent to reason over.`,
    inputSchema: z.object({
      id: z.string().describe("record identifier"),
      mode: z.string().optional().describe("operation mode"),
    }),
  });

const CORE_TOOLS = Object.fromEntries(
  ["search", "read", "write", "python", "bash"].map((n) => [n, probeTool(n)]),
);
const EXTRA_TOOLS = Object.fromEntries(
  ["invoices", "carriers", "contracts"].map((n) => [n, probeTool(n)]),
);

interface Observation {
  host: string;
  input: number;
  cached: number;
}

const callOnce = async (params: {
  tools: Record<string, ReturnType<typeof probeTool>>;
  sessionId?: string;
  /** Mimics our own per-turn system-prompt churn. */
  variant: number;
  /**
   * Seed-only: force ONE host so the session is pinned somewhere the ordinary
   * envelope would not have chosen. Overrides the role's whole `provider`
   * block (the provider spreads `providerOptions.openrouter` after the built
   * args), so it is used for the seed call and never for the calls under test.
   */
  pinTo?: string;
}): Promise<Observation> => {
  const { model } = resolveModel(role);
  const openrouter = {
    ...(params.sessionId === undefined ? {} : { session_id: params.sessionId }),
    ...(params.pinTo === undefined
      ? {}
      : {
          provider: {
            only: [params.pinTo],
            allow_fallbacks: false,
            require_parameters: true,
          },
        }),
  };
  const result = await generateText({
    model,
    tools: params.tools,
    maxOutputTokens: 1,
    instructions: `${PREFIX_SENTENCE.repeat(PREFIX_REPEATS)}\nThe current time is 12:${String(10 + params.variant).padStart(2, "0")}.`,
    prompt: "Say OK.",
    ...(Object.keys(openrouter).length > 0
      ? { providerOptions: { openrouter } }
      : {}),
  });
  // Read off the STEP rather than the result: the top-level `providerMetadata`
  // is deprecated in v7, and the step is where `summarizeStep` reads it too.
  const step = result.steps.at(-1);
  return {
    host:
      extractOpenRouterReport(step?.providerMetadata).servingProvider ?? "?",
    input: result.usage.inputTokens ?? 0,
    cached: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
  };
};

const pct = (o: Observation): string =>
  o.input > 0
    ? `${Math.round((o.cached / o.input) * 100)}%`.padStart(4)
    : "   -";

const line = (label: string, obs: readonly Observation[]): void => {
  console.log(
    `  ${label.padEnd(26)} ${obs.map((o) => `${o.host}(${pct(o)})`).join(" ")}`,
  );
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Seed the lane on `seedHost`, then let the ROLE'S OWN envelope route the rest.
 *
 * The seed is what makes this probe discriminating. Sorted by throughput, the
 * ranking does not move over the half-minute an arm takes, so an unseeded probe
 * answers "one distinct host" whether or not anything is pinning it — a green
 * that survives deleting the mechanism under test. Seeding somewhere the sort
 * would NOT have gone means the arms disagree exactly when the pin works.
 */
const runArm = async (
  seedHost: string,
  sessionId: string | undefined,
): Promise<{ seed: Observation; rest: Observation[] }> => {
  const seed = await callOnce({
    tools: CORE_TOOLS,
    sessionId,
    variant: 0,
    pinTo: seedHost,
  });
  const rest: Observation[] = [];
  for (let i = 1; i <= CALLS; i++) {
    await sleep(GAP_MS);
    rest.push(await callOnce({ tools: CORE_TOOLS, sessionId, variant: i }));
  }
  return { seed, rest };
};

await warmModelRegistry();
const { profile, transport } = resolveModel(role);
console.log(
  `\nprobe:cache — role=${role} model=${profile.catalog.id} transport=${transport}`,
);
if (transport !== "openrouter") {
  console.error(
    `\nThis probe reads OpenRouter routing metadata; role "${role}" resolves to "${transport}".`,
  );
  process.exit(2);
}

let failures = 0;

if (!has("tools-only")) {
  console.log(
    `\n== Probe A — session pin (${CALLS.toString()} calls, ${(GAP_MS / 1000).toString()}s apart, system prompt varies each call) ==`,
  );

  // What the role's own envelope picks when nothing steers it. The seed must
  // differ from this, or the probe proves nothing.
  const natural = await callOnce({ tools: CORE_TOOLS, variant: 0 });
  console.log(`  unsteered pick: ${natural.host}`);

  const { live } = resolveModel(role);
  const endpoints = live?.endpointStats ?? [];
  const index = wireNameIndex(endpoints, "openrouter");
  const pool =
    live?.providerPool.openrouter?.only ?? endpoints.map((e) => e.provider);

  /**
   * A host can hold a pin only if its cache-READ price is below its prompt
   * price — that is the condition OpenRouter activates a sticky session on.
   *
   * ADVERTISED pricing is not enough, and the gap is the whole point of the
   * cache-aware pool work: measured 2026-09-22, `morph` publishes a cache-read
   * price for this model and returned 0 % cache read over seven days of our own
   * traffic, so a seed there never pinned — while the same run seeded on
   * `together` held 3/3 at 99 % cached. Until measured cache behaviour reaches
   * `EndpointStat`, the ordering below is the best proxy available: a host that
   * publishes a cache price AND is actually serving traffic fast enough to be
   * ranked. A candidate that fails to hold is reported as a fact about the
   * HOST; only a run where no candidate holds indicts the mechanism.
   */
  const publishesCacheRead = (provider: string): boolean => {
    const endpoint = endpoints.find((e) => e.provider === provider);
    if (endpoint === undefined) return false;
    const read = endpoint.pricing.cacheReadPerMTok;
    return read !== undefined && read < endpoint.pricing.inputPerMTok;
  };
  const throughputOf = (provider: string): number =>
    endpoints.find((e) => e.provider === provider)?.throughputP50 ?? 0;
  const eligible = normalizeProviderList(pool)
    .filter(publishesCacheRead)
    .sort((a, b) => throughputOf(b) - throughputOf(a));
  const seedCandidates = toWireNames(
    eligible.length > 0 ? eligible : normalizeProviderList(pool),
    index,
    "drop",
  ).names.filter((wire) => normalizeProviderName(wire) !== natural.host);

  if (seedCandidates.length === 0) {
    console.log(
      "  SKIP — this role's pool has no second host, so nothing can compete with the\n" +
        "         pin and the probe cannot discriminate.",
    );
  } else {
    /** `--seed <wire-name>` pins the probe to one host instead of searching. */
    const forced = flag("seed");
    const ordered =
      forced === undefined ? seedCandidates.slice(0, 3) : [forced];
    const refused: string[] = [];
    let proven = false;

    for (const candidate of ordered) {
      let control: { seed: Observation; rest: Observation[] };
      try {
        control = await runArm(candidate, undefined);
      } catch {
        // The host refused outright (no ZDR route, quantization filter,
        // capacity). It was only ever scaffolding; try the next.
        refused.push(`${candidate} (refused the seed)`);
        continue;
      }
      const pinned = await runArm(
        candidate,
        `probe-cache-${Date.now().toString()}`,
      );
      const drifted = control.rest.filter(
        (o) => o.host !== control.seed.host,
      ).length;
      const held = pinned.rest.filter(
        (o) => o.host === pinned.seed.host,
      ).length;

      console.log(`\n  seeded on ${candidate}:`);
      line("no session_id", control.rest);
      line("with session_id", pinned.rest);
      console.log(
        `    drifted off the seed without the pin: ${drifted.toString()}/${control.rest.length.toString()}` +
          `  ·  stayed on it with the pin: ${held.toString()}/${pinned.rest.length.toString()}`,
      );

      if (drifted === 0) {
        refused.push(`${candidate} (control never drifted — nothing to prove)`);
        continue;
      }
      if (held < pinned.rest.length) {
        // Not a mechanism failure on its own: a host that never populates a
        // cache cannot hold a pin, whatever its published prices say.
        refused.push(`${candidate} (could not hold a pin)`);
        continue;
      }
      console.log(
        "\n  OK — the control drifted off the seeded host and the pinned arm did not.",
      );
      proven = true;
      break;
    }

    if (!proven) {
      failures += 1;
      console.error(
        `\n  FAIL — no host in this pool held a session pin.\n` +
          `         tried: ${refused.join(", ")}\n` +
          "         Either the provider package stopped forwarding `session_id`, or a\n" +
          "         `provider.order` crept into this role's pool (an explicit order\n" +
          "         disables OpenRouter's sticky routing), or every candidate tried is a\n" +
          "         host that does not populate a cache — which is its own finding.",
      );
    } else if (refused.length > 0) {
      console.log(
        `  (hosts that could not demonstrate it: ${refused.join(", ")})`,
      );
    }
  }
}

if (!has("sticky-only")) {
  console.log("\n== Probe B — does the tool list sit in the cached prefix? ==");
  const session = `probe-tools-${Date.now().toString()}`;
  const steps: { label: string; obs: Observation }[] = [];
  for (const [label, tools] of [
    ["5 tools (write)", CORE_TOOLS],
    ["5 tools (repeat)", CORE_TOOLS],
    ["8 tools (+3)", { ...CORE_TOOLS, ...EXTRA_TOOLS }],
    ["8 tools (repeat)", { ...CORE_TOOLS, ...EXTRA_TOOLS }],
  ] as const) {
    // Same `variant` throughout: only the tool list may move, so a drop here
    // cannot be blamed on the prompt.
    const obs = await callOnce({ tools, sessionId: session, variant: 0 });
    steps.push({ label, obs });
    console.log(
      `  ${label.padEnd(18)} ${obs.host.padEnd(12)} in=${String(obs.input).padStart(6)} cached=${String(obs.cached).padStart(6)} ${pct(obs)}`,
    );
    await sleep(2_000);
  }
  const warm = steps[1]?.obs;
  const afterAppend = steps[2]?.obs;
  if (warm && afterAppend && warm.cached > 0 && afterAppend.cached === 0) {
    console.log(
      "\n  CONFIRMED — appending a tool to an otherwise identical request drops the\n" +
        "  cache to zero. The tool block is part of the cached prefix, so Progressive\n" +
        "  Disclosure pays a full re-prefill on every activation.",
    );
  } else if (warm && warm.cached === 0) {
    failures += 1;
    console.error(
      "\n  FAIL — a byte-identical repeat was not cached at all. Nothing downstream of\n" +
        "  this probe can be trusted until that is explained (wrong host? prefix under\n" +
        "  the upstream's minimum? `session_id` not reaching the wire?).",
    );
  } else {
    console.log(
      "\n  NOT REPRODUCED — the tool list no longer invalidates the prefix on this\n" +
        "  upstream. Re-measure before acting on any tool-menu plan.",
    );
  }
}

process.exit(failures > 0 ? 1 : 0);
