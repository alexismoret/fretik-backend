#!/usr/bin/env bun
/**
 * Seed the Langfuse-side eval configuration (idempotent):
 *
 * 1. Score configs — only OBJECTIVE, stable metrics. Names match the
 *    experiment evaluators (`evals/langfuse/evaluators.ts`) so scores
 *    link to a config via `configId`. NO failure-mode taxonomy is seeded:
 *    a failure taxonomy must be DISCOVERED via error analysis (open-code
 *    real traces → cluster), never invented a priori — a pre-defined list
 *    causes confirmation bias, and score configs CANNOT be deleted. The
 *    `failed-check` experiment score stays a free categorical (no config).
 * 2. An LLM connection for the judge (Gemini via OpenRouter, an
 *    OpenAI-compatible base URL → one OpenRouter key).
 * 3. A managed LLM-as-a-judge evaluator (shared grading core from
 *    `evals/judge-rubric.md`) — a correctness SIGNAL, not a taxonomy.
 * 4. Evaluation rules:
 *    - ONLINE (`target=observation`) on the `chatbot-turn` agent
 *      observation (its output IS the final answer), SAMPLED — continuous
 *      production-quality monitoring that FEEDS error analysis. 0 data
 *      until prod is deployed; takes over automatically once traces arrive.
 *    - EXPERIMENT (`target=experiment`), DISABLED — the in-process judge
 *      is authoritative on dataset runs (avoids double-scoring). Enable on
 *      demand.
 *
 * MUTATES the live Langfuse project AND stores the OpenRouter key on it.
 * Re-runnable: existing configs/connections/evaluators/rules are skipped.
 *
 * Usage: `bun run langfuse:seed-eval-config` (needs LANGFUSE_* + OPENROUTER_API_KEY).
 */

import { LangfuseClient } from "@langfuse/client";

const JUDGE_MODEL =
  process.env.OPENROUTER_EVAL_JUDGE_MODEL ?? "google/gemini-3.5-flash";
const ONLINE_SAMPLING = Number(
  process.env.LANGFUSE_ONLINE_EVAL_SAMPLING ?? "0.15",
);
const CONNECTION_PROVIDER = "openrouter";
const EVALUATOR_NAME = "chatbot-correctness";
const ONLINE_RULE_NAME = "chatbot-correctness-online";
const EXPERIMENT_RULE_NAME = "chatbot-correctness-experiment";

interface ScoreConfigSeed {
  name: string;
  dataType: "NUMERIC" | "BOOLEAN";
  minValue?: number;
  maxValue?: number;
  description: string;
}

const SCORE_CONFIGS: ScoreConfigSeed[] = [
  {
    name: "correctness",
    dataType: "NUMERIC",
    minValue: 0,
    maxValue: 1,
    description:
      "Partial-credit correctness in [0,1]: mean of a case's assertion scores (judge contributes 1/0.5/0).",
  },
  {
    name: "pass-rate",
    dataType: "NUMERIC",
    minValue: 0,
    maxValue: 1,
    description: "Run-level fraction of cases that passed every assertion.",
  },
  {
    name: "no-error",
    dataType: "BOOLEAN",
    description: "The turn produced no error / non-error finish.",
  },
  {
    name: "latency-ok",
    dataType: "BOOLEAN",
    description: "The turn met its latency budget (when asserted).",
  },
];

const client = new LangfuseClient();

const seedScoreConfigs = async (): Promise<void> => {
  const existing = await client.api.scoreConfigs.get({ limit: 100 });
  const present = new Set(existing.data.map((c) => c.name));
  for (const cfg of SCORE_CONFIGS) {
    if (present.has(cfg.name)) {
      console.log(`✓ score-config ${cfg.name} — exists, skipped`);
      continue;
    }
    await client.api.scoreConfigs.create({
      name: cfg.name,
      dataType: cfg.dataType,
      ...(cfg.minValue !== undefined ? { minValue: cfg.minValue } : {}),
      ...(cfg.maxValue !== undefined ? { maxValue: cfg.maxValue } : {}),
      description: cfg.description,
    });
    console.log(`+ score-config ${cfg.name} — created`);
  }
};

const seedLlmConnection = async (): Promise<void> => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY env");
  await client.api.llmConnections.upsert({
    provider: CONNECTION_PROVIDER,
    adapter: "openai",
    secretKey: apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    customModels: [JUDGE_MODEL],
    withDefaultModels: false,
  });
  console.log(
    `✓ llm-connection ${CONNECTION_PROVIDER} — upserted (${JUDGE_MODEL})`,
  );
};

const seedEvaluator = async (): Promise<void> => {
  const list = await client.api.unstable.evaluators.list({ limit: 100 });
  if (list.data.some((e) => e.name === EVALUATOR_NAME)) {
    console.log(`✓ evaluator ${EVALUATOR_NAME} — exists, skipped`);
    return;
  }
  const core = (
    await Bun.file(`${import.meta.dir}/../evals/judge-rubric.md`).text()
  ).trim();
  const prompt = `${core}

Criterion: the assistant's final answer is correct, grounded in the tool outputs / conversation, and free of invented data.

User input:
{{input}}

Assistant final answer:
{{output}}`;
  await client.api.unstable.evaluators.create({
    name: EVALUATOR_NAME,
    prompt,
    outputDefinition: {
      dataType: "CATEGORICAL",
      reasoning: { description: "One sentence justifying the grade." },
      score: {
        description: "Grade: correct, partial, or incorrect.",
        categories: ["correct", "partial", "incorrect"],
        shouldAllowMultipleMatches: false,
      },
    },
    modelConfig: { provider: CONNECTION_PROVIDER, model: JUDGE_MODEL },
  });
  console.log(`+ evaluator ${EVALUATOR_NAME} — created`);
};

const seedRules = async (): Promise<void> => {
  const rules = await client.api.unstable.evaluationRules.list({ limit: 100 });
  const present = new Set(rules.data.map((r) => r.name));
  const mapping = [
    { variable: "input", source: "input" as const },
    { variable: "output", source: "output" as const },
  ];
  // ONLINE rule = the only BILLING piece. Gated behind SEED_ONLINE_RULE=1
  // and OFF by default: the right observation filter must be picked
  // against REAL data (the root `chatbot-turn` span is the TRACE name, not
  // necessarily an observation `name` the API filters on) — create this in
  // the Langfuse UI where the filter previews live observations. Set
  // LANGFUSE_ONLINE_EVAL_SAMPLING to tune the rate.
  if (process.env.SEED_ONLINE_RULE === "1") {
    if (!present.has(ONLINE_RULE_NAME)) {
      await client.api.unstable.evaluationRules.create({
        name: ONLINE_RULE_NAME,
        evaluator: { name: EVALUATOR_NAME, scope: "project" },
        target: "observation",
        enabled: true,
        sampling: ONLINE_SAMPLING,
        filter: [
          {
            type: "string",
            column: "name",
            operator: "=",
            value: "chatbot-turn",
          },
        ],
        mapping,
      });
      console.log(
        `+ rule ${ONLINE_RULE_NAME} — online (observation, sampling=${ONLINE_SAMPLING})`,
      );
    } else {
      console.log(`✓ rule ${ONLINE_RULE_NAME} — exists, skipped`);
    }
  } else {
    console.log(
      `· rule ${ONLINE_RULE_NAME} — SKIPPED (set SEED_ONLINE_RULE=1; better: create it in the UI to verify the observation filter against live data)`,
    );
  }
  if (!present.has(EXPERIMENT_RULE_NAME)) {
    await client.api.unstable.evaluationRules.create({
      name: EXPERIMENT_RULE_NAME,
      evaluator: { name: EVALUATOR_NAME, scope: "project" },
      target: "experiment",
      enabled: false, // in-process judge is authoritative on dataset runs
      mapping,
    });
    console.log(`+ rule ${EXPERIMENT_RULE_NAME} — experiment (disabled)`);
  } else {
    console.log(`✓ rule ${EXPERIMENT_RULE_NAME} — exists, skipped`);
  }
};

const main = async (): Promise<void> => {
  await seedScoreConfigs();
  await seedLlmConnection();
  await seedEvaluator();
  await seedRules();
  console.log("\n[seed] eval config done.");
};

await main();
