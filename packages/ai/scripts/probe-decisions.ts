/**
 * One live call per decision transport, for what no unit test can check: that
 * the providers still answer the way `services/decisions/evaluate.ts` reads
 * them.
 *
 *     bun run probe:decisions
 *
 * Three things are verified, each on a surface that is experimental on both
 * sides (the SDK's `experimental_evaluate`, OpenRouter's `/alpha/decisions`)
 * and can move in a patch release:
 *
 * 1. The OpenRouter route. `only: ["typesafe"]` with `zdr: true` is the pool;
 *    a renamed provider slug empties it, and the call 404s.
 * 2. The metadata paths. The engine reads a choice's or a score's
 *    `confidence` at `providerMetadata.openrouter.answers[id]`, and the cost
 *    at `providerMetadata.openrouter.usage.cost`. If either moves, the Drive
 *    filer silently files nothing and every decision reads as free.
 * 3. The Gateway fallback. It must accept `zeroDataRetention` and answer the
 *    same three question types, or the fallback falls open on every outage.
 *
 * Then one pass through `evaluateChunk` itself, to show what the engine makes
 * of the same answer.
 *
 * Re-run after every bump of `ai`, `@openrouter/ai-sdk-provider` or
 * `@ai-sdk/gateway`.
 *
 * Cost: about $0.00002 in total. Nothing is written anywhere.
 */
import type { DecisionQuestion } from "@fretik/shared/schemas/decisions";
import { experimental_evaluate as evaluate } from "ai";
import { extractGatewayReport } from "../src/lib/model-registry/transports/gateway";
import { extractOpenRouterReport } from "../src/lib/model-registry/transports/openrouter";
import {
  evaluateChunk,
  GATEWAY_PROVIDER_OPTIONS,
  gatewayModel,
  openrouterModel,
} from "../src/services/decisions/evaluate";

const STATE = {
  filename: "invoice-2026-09.pdf",
  documentSummary:
    "A supplier invoice for office furniture, 12 chairs and 3 desks, payable within 30 days.",
};

const QUESTIONS: Record<string, DecisionQuestion> = {
  invoice: {
    type: "boolean",
    instructions: "Is this document an invoice?",
    criteria: {
      true: "The document is an invoice.",
      false: "The document is not an invoice.",
    },
  },
  folder: {
    type: "choice",
    instructions: "Which folder, as described, holds documents like this one?",
    criteria: {
      invoices: "/Accounting/Invoices: supplier invoices awaiting payment.",
      contracts: "/Legal/Contracts: signed agreements with clients.",
      __root__:
        "None of these folders is clearly right for this document, or it belongs in none of them.",
    },
  },
  urgency: {
    type: "score",
    instructions: "How soon does this document need someone to act on it?",
    criteria: ["No action", "Within the month", "This week", "Today"],
  },
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const confidenceAt = (metadata: unknown, id: string): unknown =>
  asRecord(asRecord(asRecord(asRecord(metadata)?.openrouter)?.answers)?.[id])
    ?.confidence;

let failures = 0;
const check = (label: string, ok: boolean, detail: string): void => {
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`,
  );
};

const probe = async (transport: "openrouter" | "gateway"): Promise<void> => {
  console.log(`\n== ${transport}`);
  const started = Date.now();
  try {
    const raw = await evaluate({
      model:
        transport === "openrouter"
          ? openrouterModel("probe:decisions")
          : gatewayModel(),
      state: STATE,
      questions: QUESTIONS,
      maxRetries: 0,
      ...(transport === "gateway"
        ? { providerOptions: GATEWAY_PROVIDER_OPTIONS }
        : {}),
    });
    const report =
      transport === "openrouter"
        ? extractOpenRouterReport(raw.providerMetadata)
        : extractGatewayReport(raw.providerMetadata);

    console.log(`  model ${raw.response.modelId}, ${Date.now() - started} ms`);
    console.log(`  answers ${JSON.stringify(raw.answers)}`);
    console.log(`  providerMetadata ${JSON.stringify(raw.providerMetadata)}`);

    check(
      "cost is reported",
      report.costUsd !== undefined && report.costUsd > 0,
      String(report.costUsd),
    );
    check(
      "input tokens are reported",
      raw.usage.inputTokens !== undefined,
      String(raw.usage.inputTokens),
    );
    const folderConfidence = confidenceAt(raw.providerMetadata, "folder");
    const urgencyConfidence = confidenceAt(raw.providerMetadata, "urgency");
    if (transport === "openrouter") {
      check(
        "choice confidence where the engine reads it",
        typeof folderConfidence === "number",
        String(folderConfidence),
      );
      check(
        "score confidence where the engine reads it",
        typeof urgencyConfidence === "number",
        String(urgencyConfidence),
      );
    } else {
      // Not a failure: the filer reads a missing confidence as "do not file",
      // which is the safe outcome. Printed so a change is noticed.
      console.log(
        `  info choice confidence on the gateway: ${String(folderConfidence)}`,
      );
    }
  } catch (error) {
    check(
      "the call succeeded",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
};

await probe("openrouter");
await probe("gateway");

console.log("\n== evaluateChunk (openrouter, no fallback)");
const chunk = await evaluateChunk({
  state: STATE,
  questions: QUESTIONS,
  sessionId: "probe:decisions",
  deadline: Date.now() + 5_000,
  fallback: false,
  trace: { point: "probe" },
});
console.log(`  ${JSON.stringify(chunk)}`);
check("no question missing", chunk.missing.length === 0, "");
check(
  "the folder answer carries its confidence",
  chunk.answers["folder"]?.type === "choice" &&
    chunk.answers["folder"].confidence !== undefined,
  "",
);

console.log(
  failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
