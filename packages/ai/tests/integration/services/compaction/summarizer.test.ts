import { describe, expect, test } from "bun:test";

/**
 * The summariser reads its model id, max_tokens, and timeout from the
 * environment at module load time. Importing with a fresh query-string
 * suffix gives each case its own snapshot so we can assert the
 * resolved values without global state leakage.
 *
 * Note: actual `streamText` calls are NOT exercised here — that path
 * touches OpenRouter and lives in `evals/cases/compaction.ts`. These
 * tests cover module configuration + the soft-fail contract on empty
 * input.
 */
const importSummarizerWithEnv = async (
  env: Partial<Record<string, string | undefined>>,
) => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const suffix = Date.now().toString() + Math.random().toString();
  return await import(
    `../../../src/services/compaction/summarizer.ts?stamp=${suffix}`
  );
};

describe("summarizer — module configuration", () => {
  test("module loads with default env (deepseek/deepseek-v4-flash, 20000 max tokens)", async () => {
    const mod = await importSummarizerWithEnv({
      OPENROUTER_COMPACTION_MODEL: undefined,
      COMPACTION_SUMMARIZER_MAX_TOKENS: undefined,
      COMPACTION_SUMMARIZER_TIMEOUT_MS: undefined,
    });
    expect(typeof mod.summariseMessages).toBe("function");
    expect(mod.SUMMARISER_MAX_TOKENS).toBe(20_000);
  });

  test("OPENROUTER_COMPACTION_MODEL override is accepted", async () => {
    const mod = await importSummarizerWithEnv({
      OPENROUTER_COMPACTION_MODEL: "anthropic/claude-haiku-4-5",
    });
    expect(typeof mod.summariseMessages).toBe("function");
  });

  test("COMPACTION_SUMMARIZER_MAX_TOKENS override is honoured", async () => {
    const mod = await importSummarizerWithEnv({
      COMPACTION_SUMMARIZER_MAX_TOKENS: "12000",
    });
    expect(mod.SUMMARISER_MAX_TOKENS).toBe(12_000);
  });

  test("COMPACTION_SUMMARIZER_MAX_TOKENS clamps at the upper bound (32k)", async () => {
    const mod = await importSummarizerWithEnv({
      COMPACTION_SUMMARIZER_MAX_TOKENS: "999999",
    });
    expect(mod.SUMMARISER_MAX_TOKENS).toBe(32_000);
  });

  test("COMPACTION_SUMMARIZER_MAX_TOKENS clamps at the lower bound (2k)", async () => {
    const mod = await importSummarizerWithEnv({
      COMPACTION_SUMMARIZER_MAX_TOKENS: "50",
    });
    expect(mod.SUMMARISER_MAX_TOKENS).toBe(2_000);
  });

  test("COMPACTION_SUMMARIZER_TIMEOUT_MS override is accepted (module loads)", async () => {
    const mod = await importSummarizerWithEnv({
      COMPACTION_SUMMARIZER_TIMEOUT_MS: "60000",
    });
    expect(typeof mod.summariseMessages).toBe("function");
  });
});

describe("summarizer — empty input contract", () => {
  test("empty message list returns null without hitting the provider", async () => {
    const { summariseMessages } = await importSummarizerWithEnv({});
    const result = await summariseMessages([]);
    expect(result).toBeNull();
  });
});
