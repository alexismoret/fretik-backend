/**
 * `dispatchAgent` tool — sub-agent delegation pattern.
 *
 * The chatbot can delegate an encapsulated sub-task to a fresh
 * sub-agent (`primary` = same model, `cheap` = `deepseek/deepseek-v4-flash-0731`)
 * via the `dispatchAgent` tool. The sub-agent runs its own short tool
 * loop in isolation and returns a tight summary as the tool result.
 *
 * What we validate end-to-end here:
 *
 *   - **Positive triggers**: when the user asks for multi-source
 *     synthesis, parallel analysis, or anything that would otherwise
 *     fan-out into a long sequence of intermediate tool calls
 *     polluting the parent context, the agent picks up `dispatchAgent`
 *     instead of inlining everything.
 *
 *   - **Anti-regression**: simple one-shot lookups (a single
 *     `searchKnowledge` or `querySql` would suffice) MUST NOT route
 *     through `dispatchAgent`. Sub-agent dispatch is overhead — a
 *     single LLM call + tool call is always preferred for trivial
 *     intents.
 *
 *   - **No recursion** is NOT probed here anymore: the sub-agent tool
 *     registry structurally omits `dispatchAgent`, and that invariant
 *     is asserted by the cheap deterministic unit test
 *     `tests/integration/agents/sub-agent-registry.test.ts` — an
 *     e2e turn added nothing over it.
 *
 * The LLM is non-deterministic, so positive-trigger cases use a soft
 * judge rubric ("the agent should have considered delegation given the
 * scope") rather than a hard `toolUsed` requirement. Anti-regression
 * uses a hard `toolNotUsed` because the cost of a false positive
 * (dispatching for a 1-shot lookup) is concrete: extra latency +
 * extra tokens.
 *
 * Tagged `dispatch-agent` for filtering / dataset-item metadata.
 */

import type { EvalSuite } from "../types";

const DISPATCH = "dispatchAgent";

export const dispatchAgentSuite: EvalSuite = {
  name: "dispatch-agent",
  summary:
    "Sub-agent delegation via dispatchAgent — fires on multi-source synthesis, stays out of the way for trivial lookups.",
  cases: [
    {
      id: "dispatch-trivial-skip",
      description:
        "Anti-regression: a one-fact lookup answerable by a single tool call MUST NOT route through dispatchAgent. Single LLM step + single tool is always cheaper than spawning a sub-agent.",
      prompt: "Combien de clients avons-nous au total ?",
      tags: ["dispatch-agent", "anti-regression"],
      assertions: [
        { type: "noError" },
        { type: "toolNotUsed", tools: [DISPATCH] },
        {
          type: "judge",
          rubric:
            "The answer states a client count (including zero). It must be a direct number derived from a single tool call (querySql or listObjects), not a meta-explanation about delegation. PASS if a count is given. FAIL if the answer talks about sub-agents, delegation, or refuses to answer.",
        },
      ],
    },

    {
      id: "dispatch-multi-source-synthesis",
      description:
        "Positive trigger: an explicitly multi-source request (web + internal) is a good candidate for delegation, but inline-handling with searchWeb + searchKnowledge is also acceptable. We validate the answer covers both sources, not the specific tool path.",
      prompt:
        "Compare ce que disent nos documents internes sur nos conditions de paiement avec les pratiques standard du marché publiées cette semaine sur le web. Donne-moi une synthèse en 5-8 lignes.",
      tags: ["dispatch-agent", "multi-source"],
      assertions: [
        { type: "noError" },
        {
          type: "toolUsed",
          tools: [DISPATCH, "searchKnowledge", "searchWeb"],
          mode: "any",
        },
        {
          type: "judge",
          rubric:
            "The answer addresses both halves explicitly: (1) what internal documents say about payment terms (or 'no internal data found' if nothing matched), AND (2) what the web sources show. The form must be a synthesis (not a raw dump). PASS if both halves are present. FAIL if only one source is referenced or the answer is empty.",
        },
      ],
    },

    {
      id: "dispatch-explicit-instruction",
      description:
        "Sanity check: when the user EXPLICITLY tells the agent to use dispatchAgent, it MUST invoke the tool. If this case fails the tool is not technically exposed (registry / prepareStep / activeTools issue) and no amount of prompt engineering will help. If this case passes but the soft cases below don't trigger dispatchAgent, the problem is purely prompt engineering / model bias.",
      prompt:
        "Utilise dispatchAgent (model: cheap) pour me faire un résumé en 3 bullets des 3 derniers documents que la team a importés. Le sub-agent doit récupérer la liste via listDocuments, lire chacun, puis renvoyer la synthèse.",
      tags: ["dispatch-agent", "sanity"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: ["dispatchAgent"] },
      ],
    },
  ],
};
