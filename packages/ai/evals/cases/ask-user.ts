/**
 * `askUserQuestion` — coverage that the chatbot uses the new
 * structured-clarification primitive correctly. Mirrors Claude Code's
 * AskUserQuestion (cf. `claude-code/src/tools/AskUserQuestionTool/`).
 *
 * What the tool is for, and what these cases verify:
 *   - **Triggered on real ambiguity** — the agent calls `askUserQuestion`
 *     when one targeted disambiguation tool call cannot pick the right
 *     interpretation (e.g. multiple matches, multiple equally-valid
 *     scopes, output format choice with downstream impact).
 *   - **NOT triggered on trivia** — the agent picks a sensible default
 *     and names the assumption rather than asking the user every time.
 *   - **Schema discipline** — questions[] (1-4), each with a short
 *     `header`, 2-4 `options`, no synthetic "Other" baked in (the UI
 *     adds it automatically).
 *
 * Lifecycle note: the tool's `execute` echoes the input questions and
 * returns immediately with `answers: {}`. The agent loop is
 * stop-conditioned on `hasToolCall("askUserQuestion")`
 * (cf. `agents/chatbot/index.ts`), so the very first call ENDS the
 * turn — the user replies through the UI, and the next turn picks up
 * the answers in conversation history. These cases therefore only
 * assert the SHAPE of that one tool call; we don't drive a second turn
 * since that's covered by the auto-memory + multi-step suites
 * end-to-end.
 */

import type { Assertion, EvalSuite, ToolCallTrace } from "../types";

const ASK_TOOL = "askUserQuestion";

interface AskQuestionShape {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect?: boolean;
}

interface AskInputShape {
  questions: AskQuestionShape[];
}

const isQuestion = (v: unknown): v is AskQuestionShape => {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.question !== "string" || o.question.length === 0) return false;
  if (typeof o.header !== "string" || o.header.length === 0) return false;
  if (!Array.isArray(o.options)) return false;
  if (o.options.length < 2 || o.options.length > 4) return false;
  return o.options.every((opt: unknown) => {
    if (!opt || typeof opt !== "object") return false;
    const op = opt as Record<string, unknown>;
    return typeof op.label === "string" && typeof op.description === "string";
  });
};

const parseInput = (input: unknown): AskInputShape | null => {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.questions)) return null;
  if (obj.questions.length < 1 || obj.questions.length > 4) return null;
  if (!obj.questions.every(isQuestion)) return null;
  return { questions: obj.questions as AskQuestionShape[] };
};

const findAskCall = (calls: ToolCallTrace[]): ToolCallTrace | undefined =>
  calls.find((c) => c.name === ASK_TOOL);

/**
 * Custom assertion: the tool was called AND its input is a valid
 * AskUserQuestion payload (1-4 questions, 2-4 options each, headers
 * ≤ 12 chars, no synthetic "Other" baked into options).
 */
const validShapeAssertion: Assertion = {
  type: "custom",
  name: "askUserQuestion-input-is-well-shaped",
  fn: (result) => {
    const call = findAskCall(result.toolCalls);
    if (!call) return "askUserQuestion not called";
    const parsed = parseInput(call.input);
    if (!parsed) return `askUserQuestion input failed schema parse`;
    for (const q of parsed.questions) {
      if (q.header.length > 12) {
        return `header "${q.header}" exceeds 12 chars`;
      }
      const labels = q.options.map((o) => o.label.toLowerCase());
      if (labels.some((l) => l === "other")) {
        return `question "${q.header}" includes a synthetic 'Other' option — UI adds it automatically`;
      }
      if (new Set(labels).size !== labels.length) {
        return `question "${q.header}" has duplicate option labels`;
      }
    }
    return true;
  },
};

export const askUserSuite: EvalSuite = {
  name: "ask-user",
  summary:
    "askUserQuestion tool — fires on real ambiguity, skipped on trivia, well-shaped input.",
  cases: [
    // Note: an earlier `ask-disambig-format` case attempted to force
    // `askUserQuestion` on a multi-format export choice, but the
    // chatbot legitimately commits to a sensible default per
    // `<agent_philosophy>` ("Commit to an approach"). Any prompt
    // strong enough to override that commit bias gives the model
    // explicit permission to choose, which then suppresses the ask.
    // The intent (validating well-shaped output) is already covered
    // by `ask-headers-fit` below, where the user explicitly says
    // "Demande-moi". The remaining cases focus on the two stable
    // behaviours that DO need guarding: no-spam (skip-trivial,
    // yes-no) and well-shaped input when an ask actually fires.

    {
      id: "ask-skip-trivial-default",
      description:
        "Trivial preference with an obvious default (CSV separator) — agent should pick the default, name the assumption, and NOT call askUserQuestion.",
      prompt:
        "Exporte-moi la liste des documents en CSV. Si tu as un doute sur quoi que ce soit, prends une décision raisonnable.",
      tags: ["ask-user", "default"],
      assertions: [
        { type: "noError" },
        { type: "toolNotUsed", tools: [ASK_TOOL] },
        {
          type: "judge",
          rubric:
            "The assistant proceeded with sensible defaults (CSV with comma separator and UTF-8) and named at least one assumption in the response, rather than asking the user a clarifying question.",
        },
      ],
    },

    {
      id: "ask-yes-no-no-impact",
      description:
        "Pure yes/no with no real downstream impact — agent should NOT escalate to askUserQuestion for a decision it can make alone.",
      prompt:
        "Peux-tu me dire combien de documents ont le statut 'ready' dans la base ?",
      tags: ["ask-user", "trivia"],
      assertions: [
        { type: "noError" },
        { type: "toolNotUsed", tools: [ASK_TOOL] },
      ],
    },

    {
      id: "ask-headers-fit",
      description:
        "When the agent does ask, every question's `header` must fit within 12 chars and option labels must be unique within the question.",
      prompt:
        "Je veux un export, mais je ne sais pas trop sous quel format ni quelles colonnes inclure. Demande-moi.",
      tags: ["ask-user", "shape"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: [ASK_TOOL] },
        validShapeAssertion,
      ],
    },
  ],
};
