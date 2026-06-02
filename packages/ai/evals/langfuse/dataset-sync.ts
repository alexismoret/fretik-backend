#!/usr/bin/env bun
/**
 * Sync the curated eval cases into the Langfuse `chatbot-eval` dataset.
 *
 * The code is the source of truth (assertions/seed/cleanup are
 * functions); this mirror carries only what the UI + experiment runner
 * need, keyed by `caseId`. Only CURATED cases sync — a case is curated
 * once it has a `capability` (assigned during triage + human validation,
 * `scripts/triage-eval-cases.ts`). Uncurated/dropped cases lack
 * `capability` and are skipped, so triage gates the dataset.
 *
 * Idempotent: `createDatasetItem` upserts on `id` (= caseId). Re-run
 * after editing/curating cases.
 *
 * `promoteTrace` is the steady-state path: turn a failing PRODUCTION
 * trace into a permanent regression case (`origin: "prod"`,
 * `sourceTraceId` links it back), so the dataset grows with real usage.
 *
 * Usage: `bun run langfuse:sync-datasets` (needs LANGFUSE_* in `.env`).
 */

import { langfuseClient } from "../../src/lib/langfuse";
import { allSuites } from "../cases";
import { CURATED, type CuratedCase } from "../curation";
import type { EvalCase } from "../types";
import type { DatasetItemMetadata, DatasetOrigin } from "./types";

export const DATASET_NAME = "chatbot-eval";

const DATASET_DESCRIPTION =
  "Curated chatbot eval cases (synthetic seed + promoted prod failures), stratified by capability. Source of truth = backend/packages/ai/evals/cases.";

/** Curated cases only — those listed in `CURATED` (the triage gate). */
const curatedCases = (): {
  suite: string;
  case: EvalCase;
  curated: CuratedCase;
}[] => {
  const out: { suite: string; case: EvalCase; curated: CuratedCase }[] = [];
  for (const suite of allSuites) {
    for (const c of suite.cases) {
      const curated = CURATED[c.id];
      if (curated) out.push({ suite: suite.name, case: c, curated });
    }
  }
  return out;
};

const toMetadata = (
  suite: string,
  c: EvalCase,
  curated: CuratedCase,
): DatasetItemMetadata => ({
  caseId: c.id,
  suite,
  capability: curated.capability,
  tags: c.tags ?? [],
  fixtures: c.fixtures ?? [],
  description: c.description,
  origin: "synthetic",
  smoke: curated.smoke ?? false,
});

const ensureDataset = async (): Promise<void> => {
  if (!langfuseClient) return;
  try {
    await langfuseClient.dataset.get(DATASET_NAME);
  } catch {
    await langfuseClient.api.datasets.create({
      name: DATASET_NAME,
      description: DATASET_DESCRIPTION,
    });
    console.log(`+ dataset ${DATASET_NAME} created`);
  }
};

/** Upsert every curated case as a dataset item. Returns the count. */
export const syncDataset = async (): Promise<number> => {
  if (!langfuseClient) {
    console.warn("[langfuse] not configured — sync skipped");
    return 0;
  }
  await ensureDataset();
  const cases = curatedCases();
  for (const { suite, case: c, curated } of cases) {
    await langfuseClient.api.datasetItems.create({
      datasetName: DATASET_NAME,
      id: c.id,
      input: c.prompt,
      metadata: toMetadata(suite, c, curated),
    });
  }
  console.log(`✓ ${DATASET_NAME} — ${cases.length} curated items upserted`);
  return cases.length;
};

/**
 * Promote a (failing) production trace into the dataset as a permanent
 * regression case. `caseId` becomes the item id (upsert); the failing
 * trace is linked via `sourceTraceId`.
 */
export const promoteTrace = async (args: {
  caseId: string;
  traceId: string;
  prompt: string;
  capability: DatasetItemMetadata["capability"];
  description: string;
  smoke?: boolean;
}): Promise<boolean> => {
  if (!langfuseClient) return false;
  await ensureDataset();
  const metadata: DatasetItemMetadata = {
    caseId: args.caseId,
    suite: "prod",
    capability: args.capability,
    tags: [],
    fixtures: [],
    description: args.description,
    origin: "prod" satisfies DatasetOrigin,
    smoke: args.smoke ?? false,
  };
  await langfuseClient.api.datasetItems.create({
    datasetName: DATASET_NAME,
    id: args.caseId,
    input: args.prompt,
    sourceTraceId: args.traceId,
    metadata,
  });
  return true;
};

if (import.meta.main) {
  await syncDataset();
}
