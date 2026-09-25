import type { DecisionQuestion } from "@fretik/shared/schemas/decisions";
import { APICallError } from "ai";
import { beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mockModule } from "../../lib/mock-module";
import { redisDouble, resetRedisDouble } from "../../lib/redis-double";

/**
 * The decision engine, against a fake evaluation model behind the REAL
 * `experimental_evaluate`.
 *
 * Only the transports are doubled. The SDK call in between stays real, so
 * its own checks (one answer per question, a choice among the options, a
 * probability in [0, 1]) run on every path these tests take, and a drift in
 * how we build its input fails here rather than in production.
 *
 * What is pinned is the contract every caller falls open on: a call that
 * fails yields a `missing` entry per question, never a throw; a request the
 * provider refuses never retries elsewhere; an outage retries once on the
 * other transport; and several calls in one request fail independently.
 */

interface CallOptions {
  state: unknown;
  questions: Record<string, { type: string }>;
  abortSignal?: AbortSignal;
  providerOptions?: Record<string, unknown>;
}

interface Call {
  transport: "openrouter" | "gateway";
  modelId: string;
  settings: unknown;
  state: unknown;
  questionIds: string[];
  providerOptions: Record<string, unknown> | undefined;
}

type Behaviour = (options: CallOptions) => Promise<unknown>;

const calls: Call[] = [];
const behaviour: { openrouter: Behaviour; gateway: Behaviour } = {
  openrouter: () => Promise.reject(new Error("no behaviour set")),
  gateway: () => Promise.reject(new Error("no behaviour set")),
};

const fakeModel = (
  transport: "openrouter" | "gateway",
  modelId: string,
  settings?: unknown,
) => ({
  specificationVersion: "v4",
  provider: transport,
  modelId,
  supportedQuestionTypes: ["boolean", "choice", "score"],
  doEvaluate: (options: CallOptions) => {
    calls.push({
      transport,
      modelId,
      settings,
      state: options.state,
      questionIds: Object.keys(options.questions),
      providerOptions: options.providerOptions,
    });
    return behaviour[transport](options);
  },
});

await mockModule("../../../src/lib/model-registry/transports/openrouter", {
  openrouterClient: () => ({
    evaluationModel: (id: string, settings: unknown) =>
      fakeModel("openrouter", id, settings),
  }),
});
await mockModule("../../../src/lib/model-registry/transports/gateway", {
  gatewayClient: () => ({
    evaluationModel: (id: string) => fakeModel("gateway", id),
  }),
});

const { classifyFailure, evaluateChunk } =
  await import("../../../src/services/decisions/evaluate");
const { decidePoint, decisionRequestError } =
  await import("../../../src/services/decisions/decide-point");
const { takeRateBudget } =
  await import("../../../src/services/decisions/rate-budget");

/** Every question answered, booleans at `probability`. */
const answerAll =
  (probability: number, extras: Record<string, unknown> = {}): Behaviour =>
  (options) =>
    Promise.resolve({
      answers: Object.fromEntries(
        Object.keys(options.questions).map((id) => [
          id,
          { type: "boolean", probability },
        ]),
      ),
      warnings: [],
      usage: { inputTokens: 120 },
      ...extras,
    });

const failWith =
  (statusCode: number): Behaviour =>
  () =>
    Promise.reject(
      new APICallError({
        message: `HTTP ${statusCode.toString()}`,
        url: "https://example.test/decisions",
        requestBodyValues: {},
        statusCode,
        isRetryable: false,
      }),
    );

const boolean: DecisionQuestion = {
  type: "boolean",
  instructions: "Does the event meet the condition?",
};

const later = (ms: number): number => Date.now() + ms;

beforeEach(() => {
  calls.length = 0;
  behaviour.openrouter = answerAll(0.9);
  behaviour.gateway = answerAll(0.9);
  resetRedisDouble();
});

describe("evaluateChunk", () => {
  test("the primary is the pinned model on the zero-retention route", () => {
    return evaluateChunk({
      state: { filename: "a.pdf" },
      questions: { "wf:1": boolean },
      sessionId: "workflow-gate:e1",
      deadline: later(2_000),
      fallback: true,
      trace: { point: "workflow.gate" },
    }).then((result) => {
      expect(calls).toHaveLength(1);
      expect(calls[0]?.modelId).toBe("typesafe/jev-1.13");
      expect(calls[0]?.settings).toEqual({
        provider: { zdr: true, only: ["typesafe"], allow_fallbacks: false },
        session_id: "workflow-gate:e1",
      });
      expect(result.transport).toBe("openrouter");
      expect(result.answers["wf:1"]).toEqual({
        type: "boolean",
        probability: 0.9,
      });
      expect(result.inputTokens).toBe(120);
    });
  });

  test("confidence and cost are read where OpenRouter actually puts them", async () => {
    // The first version read cost off the top of the metadata and never
    // looked for confidence at all: every filing decision then saw "not
    // reported" and filed nothing, with no error anywhere.
    behaviour.openrouter = () =>
      Promise.resolve({
        answers: {
          folder: {
            type: "choice",
            choice: "f1",
            probabilities: { f1: 0.8, __root__: 0.2 },
          },
        },
        warnings: [],
        providerMetadata: {
          openrouter: {
            answers: { folder: { confidence: 0.91 } },
            usage: { cost: 0.00004 },
          },
        },
      });
    const result = await evaluateChunk({
      state: { documentSummary: "An invoice." },
      questions: {
        folder: {
          type: "choice",
          instructions: "Which folder?",
          criteria: { f1: "/Invoices", __root__: "None." },
        },
      },
      deadline: later(2_000),
      fallback: true,
      trace: { point: "drive.file" },
    });
    expect(result.answers["folder"]).toEqual({
      type: "choice",
      choice: "f1",
      probabilities: { f1: 0.8, __root__: 0.2 },
      confidence: 0.91,
    });
    expect(result.costUsd).toBe(0.00004);
  });

  test("a request the provider refuses never falls back", async () => {
    // A 400 is our bug. Every transport would refuse it the same way, and
    // read as an outage it would fall open silently forever.
    behaviour.openrouter = failWith(400);
    const result = await evaluateChunk({
      state: {},
      questions: { "wf:1": boolean, "wf:2": boolean },
      deadline: later(2_000),
      fallback: true,
      trace: { point: "workflow.gate" },
    });
    expect(calls.map((c) => c.transport)).toEqual(["openrouter"]);
    expect(result.transport).toBeNull();
    expect(result.missing).toEqual([
      { id: "wf:1", reason: "invalid_request" },
      { id: "wf:2", reason: "invalid_request" },
    ]);
  });

  test("an outage retries once on the gateway, zero-retention asked for", async () => {
    behaviour.openrouter = failWith(503);
    const result = await evaluateChunk({
      state: { filename: "a.pdf" },
      questions: { "wf:1": boolean },
      deadline: later(2_000),
      fallback: true,
      trace: { point: "workflow.gate" },
    });
    expect(calls.map((c) => c.transport)).toEqual(["openrouter", "gateway"]);
    expect(calls[1]?.modelId).toBe("typesafe-ai/jev");
    expect(calls[1]?.providerOptions).toEqual({
      gateway: { zeroDataRetention: true },
    });
    expect(result.transport).toBe("gateway");
    expect(result.missing).toEqual([]);
  });

  test("a point that may not fall back reports the outage instead", async () => {
    behaviour.openrouter = failWith(503);
    const result = await evaluateChunk({
      state: {},
      questions: { "wf:1": boolean },
      deadline: later(2_000),
      fallback: false,
      trace: { point: "workflow.gate" },
    });
    expect(calls.map((c) => c.transport)).toEqual(["openrouter"]);
    expect(result.missing).toEqual([{ id: "wf:1", reason: "unavailable" }]);
  });

  test("when both transports fail, the second one's reason is reported", async () => {
    behaviour.openrouter = failWith(503);
    behaviour.gateway = failWith(429);
    const result = await evaluateChunk({
      state: {},
      questions: { "wf:1": boolean },
      deadline: later(2_000),
      fallback: true,
      trace: { point: "workflow.gate" },
    });
    expect(result.missing).toEqual([{ id: "wf:1", reason: "rate_limited" }]);
  });

  test("a call past its deadline is a timeout, with no time left to retry", async () => {
    behaviour.openrouter = (options) =>
      new Promise((_, reject) => {
        options.abortSignal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    const result = await evaluateChunk({
      state: {},
      questions: { "wf:1": boolean },
      deadline: later(40),
      fallback: true,
      trace: { point: "workflow.gate" },
    });
    expect(calls.map((c) => c.transport)).toEqual(["openrouter"]);
    expect(result.missing).toEqual([{ id: "wf:1", reason: "timeout" }]);
  });

  test("an answer the SDK rejects is a failure, not a partial result", async () => {
    // The SDK checks every answer before we see any. One that names an option
    // the question never offered must not become a filing.
    behaviour.openrouter = () =>
      Promise.resolve({
        answers: { "wf:1": { type: "boolean", probability: 1.4 } },
        warnings: [],
      });
    behaviour.gateway = failWith(503);
    const result = await evaluateChunk({
      state: {},
      questions: { "wf:1": boolean },
      deadline: later(2_000),
      fallback: true,
      trace: { point: "workflow.gate" },
    });
    expect(result.answers).toEqual({});
    expect(result.missing).toHaveLength(1);
  });
});

describe("classifyFailure", () => {
  test("the status code is found on the error, its cause, or the last retry", () => {
    expect(classifyFailure({ statusCode: 422 }, false)).toBe("invalid_request");
    expect(classifyFailure({ cause: { statusCode: 413 } }, false)).toBe(
      "invalid_request",
    );
    expect(classifyFailure({ lastError: { statusCode: 429 } }, false)).toBe(
      "rate_limited",
    );
    expect(classifyFailure(new Error("socket hang up"), false)).toBe(
      "unavailable",
    );
  });

  test("an abort is a timeout whatever the error says", () => {
    expect(classifyFailure({ statusCode: 400 }, true)).toBe("timeout");
  });
});

describe("decidePoint", () => {
  const gateQuestions = (n: number): Record<string, DecisionQuestion> =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`wf:${i.toString()}`, boolean]),
    );

  test("41 questions are two calls against the same state", async () => {
    const response = await decidePoint(
      {
        point: "workflow.gate",
        state: { filename: "a.pdf", eventType: "document.processed" },
        questions: gateQuestions(41),
      },
      { teamId: "team-1" },
    );
    expect(calls).toHaveLength(2);
    expect(
      calls.map((c) => c.questionIds.length).sort((a, b) => a - b),
    ).toEqual([1, 40]);
    expect(calls[0]?.state).toEqual(calls[1]?.state);
    expect(response.status).toBe("answered");
    if (response.status !== "answered") return;
    expect(Object.keys(response.answers)).toHaveLength(41);
    expect(response.inputTokens).toBe(240);
  });

  test("a failed call leaves ITS questions missing and its sibling's answered", async () => {
    // One workflow's answer must not depend on another's call succeeding.
    behaviour.openrouter = (options) =>
      "wf:40" in options.questions
        ? failWith(503)(options)
        : answerAll(0.9)(options);
    behaviour.gateway = failWith(503);
    const response = await decidePoint(
      {
        point: "workflow.gate",
        state: { filename: "a.pdf" },
        questions: gateQuestions(41),
      },
      { teamId: "team-1" },
    );
    if (response.status !== "answered") throw new Error("expected answered");
    expect(Object.keys(response.answers)).toHaveLength(40);
    expect(response.missing).toEqual([{ id: "wf:40", reason: "unavailable" }]);
    expect(response.transport).toBe("openrouter");
  });

  test("one gateway answer labels the whole request gateway", async () => {
    // Calibration only trusts the pinned model; a mixed request is out.
    behaviour.openrouter = (options) =>
      "wf:40" in options.questions
        ? failWith(503)(options)
        : answerAll(0.9)(options);
    const response = await decidePoint(
      {
        point: "workflow.gate",
        state: {},
        questions: gateQuestions(41),
      },
      { teamId: "team-1" },
    );
    if (response.status !== "answered") throw new Error("expected answered");
    expect(response.transport).toBe("gateway");
  });

  test("nothing outside the point's allow-list reaches the model", async () => {
    await decidePoint(
      {
        point: "workflow.gate",
        state: {
          filename: "a.pdf",
          documentId: "0199-abc",
          internalNote: "never sent",
        },
        questions: gateQuestions(1),
      },
      { teamId: "team-1" },
    );
    expect(calls[0]?.state).toEqual({ filename: "a.pdf" });
  });

  test("the answer carries the policy it was decided under", async () => {
    const response = await decidePoint(
      { point: "workflow.gate", state: {}, questions: gateQuestions(1) },
      { teamId: "team-1" },
    );
    if (response.status !== "answered") throw new Error("expected answered");
    expect(response.policy).toEqual({
      questionVersion: 2,
      thresholds: { wf: 0.15 },
      minChosenProbability: {},
    });
  });

  test("an exhausted budget skips the point before any call", async () => {
    setSystemTime(new Date("2026-09-23T10:00:30Z"));
    try {
      const key = `decisions:rpm:${Math.floor(Date.now() / 60_000).toString()}`;
      await redisDouble.set(key, "800");
      const response = await decidePoint(
        { point: "workflow.gate", state: {}, questions: gateQuestions(1) },
        { teamId: "team-1" },
      );
      expect(response).toEqual({
        status: "skipped",
        point: "workflow.gate",
        reason: "rate_limited",
      });
      expect(calls).toHaveLength(0);
    } finally {
      setSystemTime();
    }
  });
});

describe("decisionRequestError", () => {
  test("a question outside the point's families is refused before any call", () => {
    expect(
      decisionRequestError({
        point: "workflow.gate",
        state: {},
        questions: { "folder:1": boolean },
      }),
    ).toContain('belongs to no question family of "workflow.gate"');
  });

  test("a question of the wrong kind for its family is refused", () => {
    expect(
      decisionRequestError({
        point: "workflow.gate",
        state: {},
        questions: {
          "wf:1": {
            type: "score",
            instructions: "How well?",
            criteria: ["no", "yes"],
          },
        },
      }),
    ).toContain("asks a boolean there");
  });

  test("a well-formed request passes", () => {
    expect(
      decisionRequestError({
        point: "workflow.gate",
        state: {},
        questions: { "wf:1": boolean },
      }),
    ).toBeNull();
  });
});

describe("takeRateBudget", () => {
  test("background work stops at 80 % of the minute; a user waiting does not", async () => {
    setSystemTime(new Date("2026-09-23T10:00:30Z"));
    try {
      expect(await takeRateBudget(800, "background")).toBe(true);
      expect(await takeRateBudget(1, "background")).toBe(false);
      expect(await takeRateBudget(1, "hot")).toBe(true);
    } finally {
      setSystemTime();
    }
  });

  test("a new minute is a new budget", async () => {
    setSystemTime(new Date("2026-09-23T10:00:30Z"));
    try {
      expect(await takeRateBudget(900, "background")).toBe(false);
      setSystemTime(new Date("2026-09-23T10:01:00Z"));
      expect(await takeRateBudget(1, "background")).toBe(true);
    } finally {
      setSystemTime();
    }
  });
});
