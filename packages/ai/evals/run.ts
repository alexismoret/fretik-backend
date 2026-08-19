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
 *   OPENROUTER_EVAL_JUDGE_MODEL  (opt., default google/gemini-3.7-flash)
 *
 * ── Invocation ─────────────────────────────────────────────────────
 *
 *   cd backend/packages/ai
 *   AI_SERVICE_URL=http://localhost:8083 bun run evals:langfuse   # CORE tier (default baseline)
 *   ...  -- --all                   # + model-gate tier probes (true full suite)
 *   ...  -- --smoke                 # PR smoke subset (both tiers)
 *   ...  -- --capability extraction # one capability stratum (both tiers)
 *   ...  -- --suite doctrine        # one suite (both tiers)
 *   ...  -- --deterministic-only    # skip the judge
 *   ...  -- --run-name <name>       # explicit dataset-run name
 *   ...  -- --candidate <profileKey> # pin turns to a registry profile (C3 gate)
 *   ...  -- --page-build-candidate <profileKey> # pin the PAGE BUILDER's model
 * ==================================================================
 */

import { ROLE_BINDINGS } from "../src/lib/model-registry/profiles";
import { runChatbotExperiment } from "./langfuse/experiment";
import type { Capability } from "./types";
import { CAPABILITIES } from "./types";

interface CliOptions {
  concurrency: number;
  /** PR smoke subset only. */
  smoke: boolean;
  /** One capability stratum. */
  capability?: Capability;
  /** One suite (e.g. "doctrine"). */
  suite?: string;
  /** Skip the judge (deterministic only). */
  deterministicOnly: boolean;
  /** Explicit dataset-run name. */
  runName?: string;
  /** Pin every turn to this registry profile (C3 gate candidate). */
  candidate?: string;
  /**
   * Pin the PAGE BUILDER to this registry profile. Separate from `--candidate`
   * because they are separate models: the candidate pins the turn that decides
   * to build a page, this pins the one that writes it. Omitted → the
   * `page-build` role binding.
   */
  pageBuildCandidate?: string;
  /**
   * Pin the DESIGN CRITIC to this registry profile, for the run only.
   * Mandatory whenever `--page-build-candidate` names a profile in the
   * `page-review` binding's family: builder and critic sharing a family is
   * self-review, and the arm reads high for the wrong reason.
   */
  pageJudgeCandidate?: string;
  /** Run only these case ids — a subset of whatever the other filters select. */
  caseIds?: string[];
  /** Include model-gate tier probes (the true full suite). */
  all: boolean;
}

const isCapability = (v: string): v is Capability =>
  (CAPABILITIES as readonly string[]).includes(v);

const parseArgs = (argv: string[]): CliOptions => {
  const opts: CliOptions = {
    concurrency: 3,
    smoke: false,
    deterministicOnly: false,
    all: false,
  };
  const unknown: string[] = [];
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
    if (flag === "--all") {
      opts.all = true;
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
    if (flag === "--suite" && next) {
      opts.suite = next;
      i++;
      continue;
    }
    if (flag === "--run-name" && next) {
      opts.runName = next;
      i++;
      continue;
    }
    if (flag === "--page-build-candidate" && next) {
      opts.pageBuildCandidate = next;
      i += 1;
      continue;
    }
    if (flag === "--page-judge-candidate" && next) {
      opts.pageJudgeCandidate = next;
      i += 1;
      continue;
    }
    if (flag === "--case" && next) {
      (opts.caseIds ??= []).push(next);
      i += 1;
      continue;
    }
    if (flag === "--candidate" && next) {
      opts.candidate = next;
      i++;
      continue;
    }
    // Anything left is a typo, a flag that lost its value, or — the one that
    // cost a full core run — several flags arriving as ONE argv entry because
    // zsh does not word-split an unquoted `$VAR`. Silently ignoring it meant a
    // selection quietly widened to the whole dataset, which is the expensive
    // direction. Refuse instead.
    unknown.push(flag ?? "");
  }
  if (unknown.length > 0) {
    console.error(
      `[evals] unrecognised argument(s): ${unknown.map((a) => JSON.stringify(a)).join(", ")}\n` +
        `[evals] pass each flag as its own argument (in zsh, write them out or use an array — an unquoted "$VAR" arrives as one).`,
    );
    process.exit(2);
  }
  return opts;
};

const main = async (): Promise<void> => {
  const opts = parseArgs(process.argv.slice(2));
  // ALWAYS pin the turn's model profile. Without a pin, the EVAL team's
  // C8 picker choice silently overrides the code binding — the 2026-07-17
  // runs measured gpt-oss-20b instead of the flagship for exactly that
  // reason. Default = the CODE `chat` binding (the flagship the RUNBOOK
  // holds to 1.000); `--candidate` overrides for gate runs. The
  // memory/recall harnesses (`evals:memory`, `evals:recall`) are separate
  // and keep their own gpt-oss defaults.
  const pinnedProfileKey = opts.candidate ?? ROLE_BINDINGS.chat.profileKey;
  // The critic runs IN this process (unlike the builder, which is pinned
  // through a header on the service call), so the pin travels by env to the
  // one place that builds it — `evals/page-design-judge.ts`.
  if (opts.pageJudgeCandidate) {
    process.env.EVAL_PAGE_JUDGE_PROFILE = opts.pageJudgeCandidate;
  }
  const result = await runChatbotExperiment({
    smoke: opts.smoke,
    deterministicOnly: opts.deterministicOnly,
    includeModelGate: opts.all,
    maxConcurrency: opts.concurrency,
    ...(opts.capability ? { capability: opts.capability } : {}),
    ...(opts.suite ? { suite: opts.suite } : {}),
    ...(opts.runName ? { runName: opts.runName } : {}),
    candidateProfileKey: pinnedProfileKey,
    ...(opts.pageBuildCandidate
      ? { pageBuildProfileKey: opts.pageBuildCandidate }
      : {}),
    ...(opts.caseIds ? { caseIds: opts.caseIds } : {}),
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
