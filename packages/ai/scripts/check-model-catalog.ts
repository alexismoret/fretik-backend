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
