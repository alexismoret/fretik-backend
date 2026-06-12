/**
 * ==================================================================
 *   Fretik Chatbot — Live LLM Eval Harness (Langfuse experiments)
 * ==================================================================
 *
 * This is NOT a unit test. Tests live in `../tests/` and run via
 * `bun test` — deterministic, mocked, CI-safe.
 *
 * This harness calls the REAL chatbot stack end-to-end and records the
 * outcome as a Langfuse dataset run (experiment). Each case:
 *   1. Posts a prompt to `POST AI_SERVICE_URL/internal/agents/chatbot/invoke`
 *   2. Consumes the returned UIMessage stream
 *   3. Scores it (deterministic checks + graded LLM judge)
 *   4. Pushes the result to the Langfuse `chatbot-eval` dataset run,
 *      with per-capability + cost run-level scores
 *
 * Non-deterministic by nature — same prompt can produce different tool
 * traces and wording across runs. That's the point: we validate model
 * behaviour, not code behaviour. Compare runs in the Langfuse UI.
 *
 * Only the CURATED cases (`curation.ts` → the `chatbot-eval` dataset)
 * run here. The gold set grows from production via `promoteTrace` — see
 * `evals/RUNBOOK.md`.
 *
 * ── Required environment ───────────────────────────────────────────
 *
 *   AI_SERVICE_URL            e.g. http://localhost:8083 (NOT in .env)
 *   INTERNAL_KEY              same value the @fretik/ai process uses
 *   EVAL_TEAM_ID              UUID of the team to eval against
 *   EVAL_ORGANIZATION_ID      parent organization UUID
 *   EVAL_USER_ID    (opt.)    forwarded as X-Context-User-Id
 *   LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL
 *   OPENROUTER_API_KEY                 (judge)
 *   OPENROUTER_EVAL_JUDGE_MODEL  (opt., default google/gemini-3.5-flash)
 *
 * ── Invocation ─────────────────────────────────────────────────────
 *
 *   cd backend/packages/ai
 *   AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse
 *   ...  -- --smoke                 # PR smoke subset
 *   ...  -- --capability extraction # one capability stratum
 *   ...  -- --deterministic-only    # skip the judge
 *   ...  -- --run-name <name>       # explicit dataset-run name
 *   ...  -- --candidate <profileKey> # pin turns to a registry profile (C3 gate)
 * ==================================================================
 */

import { runChatbotExperiment } from "./langfuse/experiment";
import type { Capability } from "./types";
import { CAPABILITIES } from "./types";

interface CliOptions {
  concurrency: number;
  /** PR smoke subset only. */
  smoke: boolean;
  /** One capability stratum. */
  capability?: Capability;
  /** Skip the judge (deterministic only). */
  deterministicOnly: boolean;
  /** Explicit dataset-run name. */
  runName?: string;
  /** Pin every turn to this registry profile (C3 gate candidate). */
  candidate?: string;
}

const isCapability = (v: string): v is Capability =>
  (CAPABILITIES as readonly string[]).includes(v);

const parseArgs = (argv: string[]): CliOptions => {
  const opts: CliOptions = {
    concurrency: 3,
    smoke: false,
    deterministicOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === "--concurrency" && next) {
      const n = parseInt(next, 10);
      if (!Number.isNaN(n) && n > 0) opts.concurrency = n;
      i++;
      continue;
    }
    if (flag === "--smoke") {
      opts.smoke = true;
      continue;
    }
    if (flag === "--deterministic-only") {
      opts.deterministicOnly = true;
      continue;
    }
    if (flag === "--capability" && next && isCapability(next)) {
      opts.capability = next;
      i++;
      continue;
    }
    if (flag === "--run-name" && next) {
      opts.runName = next;
      i++;
      continue;
    }
    if (flag === "--candidate" && next) {
      opts.candidate = next;
      i++;
      continue;
    }
  }
  return opts;
};

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));
  const result = await runChatbotExperiment({
    smoke: opts.smoke,
    deterministicOnly: opts.deterministicOnly,
    maxConcurrency: opts.concurrency,
    ...(opts.capability ? { capability: opts.capability } : {}),
    ...(opts.runName ? { runName: opts.runName } : {}),
    ...(opts.candidate ? { candidateProfileKey: opts.candidate } : {}),
    metadata: {
      release: process.env.LANGFUSE_RELEASE ?? "(dev)",
      smoke: opts.smoke,
      deterministicOnly: opts.deterministicOnly,
    },
  });
  console.log(await result.format({ includeItemResults: true }));
  if (result.datasetRunUrl)
    console.log(`\n[evals] dataset run: ${result.datasetRunUrl}`);
  process.exit(0);
};

main().catch((err) => {
  console.error("[evals] fatal:", err);
  process.exit(3);
});
