/**
 * Drift check: compares every profile's `catalog` block in
 * `src/lib/model-registry/profiles.ts` against the live OpenRouter
 * models API. Run after any provider announcement, and before a
 * model promotion:
 *
 *     bun run models:check
 *
 * Two severities, because a catalog mirror that fails on cosmetic
 * churn stops being read:
 *
 * DRIFT (exit 1) — a field the PRODUCT reads, so being wrong changes
 * behaviour:
 *   - the model id still exists on OpenRouter (else every request 404s);
 *   - `contextLength` matches exactly (compaction budgets off it);
 *   - `inputModalities` / `outputModalities` match as SETS (native
 *     attachment routing off them);
 *   - our `supportedParameters` are a SUBSET of the live list (we
 *     intentionally store only the parameters the product reads) — a
 *     parameter the pool does not advertise EMPTIES it.
 *
 * STALE (exit 0, advisory) — `maxCompletionTokens`. Nothing reads it:
 * it is documentation for whoever compares profiles. And it cannot be
 * kept accurate, because OpenRouter reports it from `top_provider` —
 * whichever upstream currently LEADS the routing — so on any model with
 * many endpoints it tracks routing, not the model. GLM 5.2 alone moved
 * 131 072 → 128 000 → 131 072 → 262 144 → 131 072 over three weeks
 * across its 34 endpoints. Failing CI on that trains everyone to ignore
 * the check, which is how a real `supportedParameters` drift ships. Same
 * reasoning as the 50 % tolerance on --prices below. Re-sync these when
 * you are in the file anyway.
 *
 * NOTE: no API key needed — /api/v1/models is public.
 *
 * Live routing probe:
 *
 *     bun run models:check --probe        # needs OPENROUTER_API_KEY
 *
 * For every ROLE, makes a minimal completion with the role's REAL
 * provider block + `temperature: 0` and reports whether it routes. This
 * is the only check that catches an EMPTY routing pool — a catalog diff
 * can't see it, because the model id exists and its parameters are on
 * *some* endpoint, just not on the one the role's data policy allows
 * (the class of failure behind "No endpoints found matching your data
 * policy": Gemini's ZDR endpoint omits `temperature`, so ZDR +
 * `require_parameters` empties the pool). Runs the probe and exits;
 * without the flag, the catalog drift check runs as before.
 *
 * Price drift:
 *
 *     bun run models:check --prices      # needs OPENROUTER_API_KEY
 *
 * Compares each profile's `assessment.pricing` against the endpoint it
 * ACTUALLY routes to. This block is not part of the catalog mirror, so
 * nothing validated it until 2026-08-03 — when an audit found three
 * profiles wrong, `deepseek-v4-pro` by 3× on input and 28× on cached
 * input because it was priced at DeepSeek's first-party endpoint, which
 * the ZDR pool excludes. Tolerates 15 % to absorb routing variance.
 */
import { OPENROUTER_API_BASE_URL } from "@fretik/shared/lib/openrouter";
import { MODEL_PROFILES } from "../src/lib/model-registry/profiles";

interface ApiModel {
  id: string;
  context_length?: number;
  top_provider?: { max_completion_tokens?: number | null };
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  supported_parameters?: string[];
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

if (process.argv.includes("--probe")) {
  // Dynamic imports: resolve.ts constructs the OpenRouter client (reads the
  // API key), which the key-less drift path must not require.
  const { resolveModel } = await import("../src/lib/model-registry/resolve");
  const { ROLE_BINDINGS } = await import("../src/lib/model-registry/profiles");
  const { generateText } = await import("ai");

  // Iterate the binding VALUES so `binding.role` carries the ModelRole type
  // (Object.keys would widen to string and force a cast).
  const bindings = Object.values(ROLE_BINDINGS);
  const results = await Promise.all(
    bindings.map(async (binding) => {
      const { model, profile } = resolveModel(binding.role);
      try {
        // No hardcoded `temperature`: the resolved model already carries the
        // role's EXACT provider block (zdr, require_parameters where set), which
        // is what governs routing. Adding temperature here would probe a param
        // no role sends — and on the Gemini vision/extract role the Vertex ZDR
        // route doesn't advertise it, so it would only muddy the signal.
        await generateText({
          model,
          prompt: "Reply with the single word: ok.",
          maxOutputTokens: 8,
        });
        return {
          role: binding.role,
          id: profile.catalog.id,
          ok: true as const,
        };
      } catch (err) {
        return {
          role: binding.role,
          id: profile.catalog.id,
          ok: false as const,
          reason:
            err instanceof Error ? err.message.slice(0, 160) : String(err),
        };
      }
    }),
  );

  let failures = 0;
  for (const r of results.sort((a, b) => a.role.localeCompare(b.role))) {
    if (r.ok) {
      console.log(`OK   ${r.role.padEnd(22)} ${r.id}`);
    } else {
      failures += 1;
      console.error(`FAIL ${r.role.padEnd(22)} ${r.id} — ${r.reason}`);
    }
  }
  if (failures > 0) {
    console.error(`\n${failures}/${bindings.length} role(s) could not route.`);
    process.exit(1);
  }
  console.log(`\nOK — all ${bindings.length} roles route a minimal request.`);
  process.exit(0);
}

if (process.argv.includes("--prices")) {
  // Dynamic import for the same reason as --probe: this path needs the key.
  const { fetchOpenRouterRouting } =
    await import("../src/services/model-metrics/fetch-openrouter-routing");
  const routing = await fetchOpenRouterRouting();
  if (routing.size === 0) {
    console.error("No routing resolved — is OPENROUTER_API_KEY set?");
    process.exit(2);
  }

  // This is a SMOKE ALARM for "priced at an endpoint we never reach", not a
  // precision audit. The bug it exists to catch was 3× on input and 28× on
  // cached input; meanwhile the pool itself is genuinely fuzzy — GLM 5.2 has 34
  // endpoints spanning 8× in price, and two consecutive enumerations of it
  // produced medians 27 % apart. A tight bound would cry wolf every run.
  // Precision costs little anyway: the curated price is only ever used when
  // OpenRouter is unreachable, since the live value overrides it at runtime.
  const TOLERANCE = 0.5;
  let priceDrift = 0;
  for (const [key, profile] of Object.entries(MODEL_PROFILES)) {
    const routed = routing.get(key);
    if (!routed) {
      console.warn(`SKIP  ${key}: no endpoint resolved`);
      continue;
    }
    const ours = profile.assessment.pricing;
    const off = (curated: number | undefined, live: number | undefined) => {
      if (curated === undefined || live === undefined) return curated !== live;
      if (curated === 0) return live !== 0;
      return Math.abs(live - curated) / curated > TOLERANCE;
    };
    const fields: [string, number | undefined, number | undefined][] = [
      ["input", ours.inputPerMTok, routed.pricing.inputPerMTok],
      ["output", ours.outputPerMTok, routed.pricing.outputPerMTok],
      ["cacheRead", ours.cacheReadPerMTok, routed.pricing.cacheReadPerMTok],
    ];
    const bad = fields.filter(([, c, l]) => off(c, l));
    if (bad.length > 0) {
      priceDrift += 1;
      const detail = bad
        .map(([name, c, l]) => `${name} ${c ?? "none"} → live ${l ?? "none"}`)
        .join(", ");
      console.error(`DRIFT ${key} (served by ${routed.provider}): ${detail}`);
    }
  }
  if (priceDrift > 0) {
    console.error(
      `\n${priceDrift} profile(s) priced against an endpoint we do not reach.`,
    );
    process.exit(1);
  }
  console.log(
    `OK — ${routing.size} profiles priced at the endpoint they actually route to.`,
  );
  process.exit(0);
}

const response = await fetch(`${OPENROUTER_API_BASE_URL}/models`);
if (!response.ok) {
  console.error(`OpenRouter API returned ${response.status}`);
  process.exit(2);
}
const body: { data: ApiModel[] } = await response.json();
const liveById = new Map(body.data.map((m) => [m.id, m]));

let driftCount = 0;
const drift = (key: string, message: string) => {
  driftCount += 1;
  console.error(`DRIFT ${key}: ${message}`);
};

// Advisory: reported, never fatal. See the severity split at the top.
let staleCount = 0;
const stale = (key: string, message: string) => {
  staleCount += 1;
  console.warn(`STALE ${key}: ${message}`);
};

for (const profile of Object.values(MODEL_PROFILES)) {
  const { key, catalog } = profile;
  const live = liveById.get(catalog.id);
  if (!live) {
    drift(key, `model id "${catalog.id}" no longer listed on OpenRouter`);
    continue;
  }

  if (live.context_length !== catalog.contextLength) {
    drift(
      key,
      `contextLength ${catalog.contextLength} → live ${live.context_length}`,
    );
  }

  const liveMaxOut = live.top_provider?.max_completion_tokens ?? undefined;
  if (liveMaxOut !== catalog.maxCompletionTokens) {
    stale(
      key,
      `maxCompletionTokens ${catalog.maxCompletionTokens ?? "none"} → live ${liveMaxOut ?? "none"}`,
    );
  }

  const liveIn = live.architecture?.input_modalities ?? [];
  if (!sameSet(catalog.inputModalities, liveIn)) {
    drift(
      key,
      `inputModalities [${catalog.inputModalities}] → live [${liveIn}]`,
    );
  }
  const liveOut = live.architecture?.output_modalities ?? [];
  if (!sameSet(catalog.outputModalities, liveOut)) {
    drift(
      key,
      `outputModalities [${catalog.outputModalities}] → live [${liveOut}]`,
    );
  }

  const liveParams = new Set(live.supported_parameters ?? []);
  const missing = catalog.supportedParameters.filter((p) => !liveParams.has(p));
  if (missing.length > 0) {
    drift(key, `supportedParameters not on live model: [${missing}]`);
  }
}

const profileCount = Object.keys(MODEL_PROFILES).length;

if (staleCount > 0) {
  console.warn(
    `\n${staleCount} advisory difference(s) — nothing reads these, re-sync when convenient.`,
  );
}
if (driftCount > 0) {
  console.error(
    `\n${driftCount} drift(s) found across ${profileCount} profiles.`,
  );
  process.exit(1);
}
console.log(
  `OK — ${profileCount} profiles match the live OpenRouter catalog on every field the product reads.`,
);
