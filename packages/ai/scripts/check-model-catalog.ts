/**
 * Drift check: compares every profile's `catalog` block in
 * `src/lib/model-registry/profiles.ts` against the live OpenRouter
 * models API. Run after any provider announcement, and before a
 * model promotion:
 *
 *     bun run models:check
 *
 * Checked per profile:
 *   - the model id still exists on OpenRouter;
 *   - `contextLength` and `maxCompletionTokens` match exactly;
 *   - `inputModalities` / `outputModalities` match as SETS;
 *   - our `supportedParameters` are a SUBSET of the live list (we
 *     intentionally store only the parameters the product reads).
 *
 * Exit code 1 on any drift — wire it into CI next to the gen:sdk
 * drift check if/when profiles churn becomes a problem.
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
 */
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

const response = await fetch("https://openrouter.ai/api/v1/models");
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
    drift(
      key,
      `maxCompletionTokens ${catalog.maxCompletionTokens} → live ${liveMaxOut}`,
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

if (driftCount > 0) {
  console.error(
    `\n${driftCount} drift(s) found across ${Object.keys(MODEL_PROFILES).length} profiles.`,
  );
  process.exit(1);
}
console.log(
  `OK — ${Object.keys(MODEL_PROFILES).length} profiles match the live OpenRouter catalog.`,
);
