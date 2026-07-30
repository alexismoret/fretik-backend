/**
 * Experiments API (Langfuse v4) — raw fetch.
 *
 * `@langfuse/client` 5.9.1 covers observations v2, scores v3 and metrics v2,
 * but NOT the experiments API that replaces the dataset-run READ endpoints
 * (`GET /api/public/datasets/:name/runs/:runName` and
 * `GET /api/public/dataset-run-items`, both `404` once the server runs the v4
 * default write mode `events_only`). Until the SDK exposes it, read
 * experiments over HTTP with the same credentials `LangfuseClient` uses.
 *
 * A "dataset run" in v3 vocabulary IS an "experiment" in v4: the run name is
 * the experiment name, and the run-level scores the run evaluators attached
 * come back as experiment-level scores (`fields=scores`).
 *
 * Both endpoints require `fromStartTime`, so reads are bounded to
 * `LOOKBACK_DAYS`. A stored baseline older than that is not comparable to the
 * current curated set anyway (the gate's parity check would reject it).
 */

import { z } from "zod";

/** Widest window a stored baseline run can be reused from. */
const LOOKBACK_DAYS = 365;

const scoreSchema = z.object({
  name: z.string(),
  // v3 scores carry ONE typed value: number for NUMERIC, boolean for
  // BOOLEAN, string for CATEGORICAL / TEXT / CORRECTION.
  value: z.union([z.number(), z.string(), z.boolean()]),
  comment: z.string().nullish(),
});

const experimentSchema = z.object({
  id: z.string(),
  name: z.string(),
  scores: z.array(scoreSchema).nullish(),
});

const experimentsResponseSchema = z.object({
  data: z.array(experimentSchema),
  meta: z.object({ cursor: z.string().nullish() }),
});

const experimentItemsResponseSchema = z.object({
  // `experimentItemId` is the dataset item id for experiments run on a
  // Langfuse dataset — the v4 equivalent of `datasetRunItem.datasetItemId`.
  data: z.array(z.object({ experimentItemId: z.string() })),
  meta: z.object({ cursor: z.string().nullish() }),
});

export type ExperimentScore = z.infer<typeof scoreSchema>;
export type Experiment = z.infer<typeof experimentSchema>;

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
};

const get = async (path: string, params: URLSearchParams): Promise<unknown> => {
  const baseUrl = requireEnv("LANGFUSE_BASE_URL").replace(/\/+$/, "");
  const auth = btoa(
    `${requireEnv("LANGFUSE_PUBLIC_KEY")}:${requireEnv("LANGFUSE_SECRET_KEY")}`,
  );
  const res = await fetch(`${baseUrl}${path}?${params.toString()}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GET ${path} → HTTP ${res.status.toString()}: ${body.slice(0, 300)}`,
    );
  }
  return res.json();
};

const lookbackWindow = (): { fromStartTime: string; toStartTime: string } => {
  const now = Date.now();
  return {
    fromStartTime: new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString(),
    toStartTime: new Date(now + 60_000).toISOString(),
  };
};

/**
 * Find one experiment by its exact name (= the v3 dataset-run name). Returns
 * `null` when no run by that name exists in the lookback window. Experiment
 * (run-level) scores are included.
 */
export const findExperimentByName = async (
  name: string,
): Promise<Experiment | null> => {
  const window = lookbackWindow();
  const params = new URLSearchParams({
    name,
    fields: "core,scores",
    limit: "50",
    fromStartTime: window.fromStartTime,
    toStartTime: window.toStartTime,
  });
  const parsed = experimentsResponseSchema.parse(
    await get("/api/public/experiments", params),
  );
  // `name` is a comma-separated OR filter, not an exact match on the server
  // side for every column — pin the exact name here.
  return parsed.data.find((e) => e.name === name) ?? null;
};

/**
 * Every dataset-item id covered by an experiment, following the cursor to the
 * last page (a curated run can exceed one page).
 */
export const listExperimentItemIds = async (
  experimentId: string,
): Promise<string[]> => {
  const window = lookbackWindow();
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({
      experimentId,
      limit: "100",
      fromStartTime: window.fromStartTime,
      toStartTime: window.toStartTime,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    // Cursor pagination is serial by definition: the next page key comes
    // from the current response.
    // eslint-disable-next-line no-await-in-loop
    const body = await get("/api/public/experiment-items", params);
    const parsed = experimentItemsResponseSchema.parse(body);
    for (const item of parsed.data) ids.push(item.experimentItemId);
    cursor = parsed.meta.cursor ?? undefined;
  } while (cursor !== undefined);
  return ids;
};
