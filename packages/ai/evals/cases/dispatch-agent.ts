/**
 * `dispatchAgent` tool — sub-agent delegation.
 *
 * The chatbot starts a sub-agent on a many-call job: the call answers at once
 * (`{ status: "started", agentId }`), the sub-agent runs its own tool loop on
 * a queue worker, in a fresh context, on the parent's model, and its
 * structured report (`{ status, summary, files?, reason?, toolCalls }`)
 * comes back through `manageAgents` — or through the resumed turn when the
 * parent ends its turn to wait, which these single-turn cases do not follow.
 *
 * What we validate end-to-end, in both directions:
 *
 *   - **It fires when it should**: independent angles of one question are
 *     ALL started before the parent waits on any, and a multi-source
 *     synthesis covers every source.
 *
 *   - **It stays out of the way**: a one-fact lookup never routes through
 *     `dispatchAgent` — delegation costs a whole agent loop.
 *
 *   - **The brief is self-contained**: what the user said reaches the
 *     sub-agent's `task`, since the sub-agent sees nothing else.
 *
 *   - **The right mode**: a mechanical sweep asked for "quick" goes out with
 *     `model: "fast"`; research the user does not want to wait for is started
 *     and the turn goes on answering instead of blocking on it.
 *
 *   - **The whole path runs**: launch → queue → worker → task row → `wait` →
 *     report, in the one case that asks the parent to wait.
 *
 * The report being structured is what lets these cases see INSIDE a
 * sub-agent at all: `status` says whether it finished. What a sub-agent may
 * do (no writes, no recursion) is a registry property, pinned by the
 * deterministic unit test `tests/unit/agents/sub-agent-registry.test.ts` — an
 * e2e turn adds nothing over it.
 *
 * Tagged `dispatch-agent` for filtering / dataset-item metadata.
 */

import type { EvalSuite, ToolCallTrace } from "../types";

const DISPATCH = "dispatchAgent";
const MANAGE = "manageAgents";

export const dispatchAgentSuite: EvalSuite = {
  name: "dispatch-agent",
  summary:
    "Sub-agent delegation via dispatchAgent — fans out independent angles in parallel, briefs self-contained tasks, stays out of the way for trivial lookups.",
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
            "The answer states a client count (including zero). It must be a direct number derived from a single tool call (querySql or listRecords), not a meta-explanation about delegation. PASS if a count is given. FAIL if the answer talks about sub-agents, delegation, or refuses to answer.",
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
        "Sanity check of the whole path: when the user EXPLICITLY asks for a sub-agent and to wait for it, the agent MUST start one, wait with `manageAgents`, and the sub-agent must come back with a finished report — launch, queue, worker, task row and wait all ran. If this case fails the tools are not technically exposed (registry / prepareStep / activeTools) or the sub-agent cannot run (no queue worker); no amount of prompt engineering will help. If this passes but the soft cases don't trigger dispatchAgent, the problem is doctrine / model bias.",
      prompt:
        "Utilise un sous-agent pour me faire un résumé en 3 bullets des 3 derniers documents que la team a importés. Le sous-agent doit récupérer la liste, lire chacun, puis renvoyer la synthèse. Attends son rapport et donne-moi le résumé dans cette réponse.",
      tags: ["dispatch-agent", "sanity"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: [DISPATCH, MANAGE], mode: "all" },
        {
          type: "custom",
          name: "the sub-agent finished with a report",
          fn: (result) => {
            const reports = collectedReports(result.toolCalls);
            if (reports.length === 0) return "no report was collected";
            const finished = reports.some(
              (report) =>
                report.status !== "failed" && report.summary.trim().length > 0,
            );
            return (
              finished ||
              `no sub-agent came back with a report (statuses: ${reports.map((r) => r.status).join(", ")})`
            );
          },
        },
      ],
    },

    {
      id: "dispatch-parallel-angles",
      description:
        "Positive trigger with a hard assertion: three independent angles of one question (internal data, documents, the web) are the canonical fan-out. The agent must start at least two sub-agents, ALL of them before it waits on any — a sub-agent started after a wait ran alone, and the parallelism, which is most of the point, was lost.",
      prompt:
        "Prépare-moi un point complet sur notre principal client : ce que disent nos données (factures, montants, dates), ce que disent nos documents (contrats, comptes rendus), et ce qu'on trouve de public sur le web à son sujet. Travaille les trois pistes en parallèle, attends les résultats, puis fais-moi une synthèse structurée dans cette réponse.",
      tags: ["dispatch-agent", "parallel"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "≥2 sub-agents started before any wait",
          fn: (result) => {
            const calls = result.toolCalls.filter((c) => c.name === DISPATCH);
            if (calls.length < 2) {
              return `${calls.length.toString()} dispatchAgent call(s) — expected at least 2`;
            }
            return (
              allStartedBeforeWaiting(result.toolCalls) ||
              "a sub-agent was started after the agent had waited on another"
            );
          },
        },
        {
          type: "judge",
          rubric:
            "The answer is a structured synthesis covering three angles: internal data (figures, dates), internal documents, and public web information — each either with findings or an explicit 'nothing found'. PASS if all three angles are addressed and the synthesis reads as one answer, not three pasted reports. FAIL if an angle is missing or the answer is a raw dump.",
        },
      ],
    },

    {
      id: "dispatch-brief-self-contained",
      description:
        "The sub-agent sees nothing of the conversation, so every constraint the user stated must travel in `task`. The prompt carries a period and an output shape; both must appear in the brief. A brief that says 'do what the user asked' sends the sub-agent in blind.",
      prompt:
        "Délègue à un sous-agent la recherche suivante : dans nos documents, tout ce qui concerne des pénalités de retard, en te limitant à la période de janvier à mars, et renvoie-moi le résultat sous forme de tableau (document, clause, montant).",
      tags: ["dispatch-agent", "brief"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: [DISPATCH] },
        {
          type: "custom",
          name: "the brief carries the period and the table shape",
          fn: (result) => {
            const tasks = result.toolCalls
              .filter((c) => c.name === DISPATCH)
              .map((c) => {
                const task = fieldOf(c.input, "task");
                return typeof task === "string" ? task : "";
              })
              .join("\n")
              .toLowerCase();
            const missing = ["janvier", "mars", "tableau"].filter(
              (word) => !tasks.includes(word),
            );
            return (
              missing.length === 0 ||
              `the task never mentions: ${missing.join(", ")}`
            );
          },
        },
      ],
    },

    {
      id: "dispatch-fast-mechanical",
      description:
        'Exposure check for `model: "fast"`: the user asks for a quick sub-agent on a mechanical sweep (the same two fields out of many documents). The dispatch must carry `model: "fast"` — if it never does, the parameter is not reaching the model or the doctrine does not name the case.',
      prompt:
        "Envoie un sous-agent rapide relever, dans chacun des 10 derniers documents importés, la date et le montant total, et renvoie-moi un tableau (document, date, montant).",
      tags: ["dispatch-agent", "fast"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: [DISPATCH] },
        {
          type: "custom",
          name: "the dispatch asks for the fast model",
          fn: (result) =>
            result.toolCalls.some(
              (c) =>
                c.name === DISPATCH && fieldOf(c.input, "model") === "fast",
            ) || 'no dispatchAgent call carried model: "fast"',
        },
      ],
    },

    {
      id: "dispatch-keeps-working",
      description:
        "Asynchrony: the user wants a long piece of research started while they get an unrelated answer now. The research must be started with `dispatchAgent`, and the SAME turn must go on to answer the second question instead of waiting on it — no `manageAgents` `wait`. The report comes back in a later, resumed turn this case does not follow.",
      prompt:
        "Lance un sous-agent qui fait une veille web sur les pratiques de délais de paiement B2B publiées cette année, je n'ai pas besoin du résultat tout de suite. En attendant, dis-moi combien de clients nous avons.",
      tags: ["dispatch-agent", "async"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: [DISPATCH] },
        {
          type: "custom",
          name: "the turn does not block on the research",
          fn: (result) =>
            !result.toolCalls.some(
              (c) => c.name === MANAGE && fieldOf(c.input, "action") === "wait",
            ) || "the turn waited on the sub-agent instead of answering",
        },
        {
          type: "judge",
          rubric:
            "The answer gives a client count (including zero) AND says the web research is running and will come back later. PASS if both are present. FAIL if it withholds the count until the research is done, claims research findings it does not have, or never mentions the research.",
        },
      ],
    },
  ],
};

/** A field of an untyped tool payload, read without trusting its shape. */
const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

interface CollectedReport {
  status: string;
  summary: string;
}

/** Every report `manageAgents` handed over during the turn. */
const collectedReports = (
  toolCalls: readonly ToolCallTrace[],
): CollectedReport[] =>
  toolCalls
    .filter((call) => call.name === MANAGE)
    .flatMap((call) => {
      const finished = fieldOf(call.output, "finished");
      return Array.isArray(finished) ? (finished as unknown[]) : [];
    })
    .map((report) => {
      const status = fieldOf(report, "status");
      const summary = fieldOf(report, "summary");
      return {
        status: typeof status === "string" ? status : "",
        summary: typeof summary === "string" ? summary : "",
      };
    })
    .filter((report) => report.status.length > 0);

/**
 * Whether every sub-agent was started before the first `manageAgents` call
 * that waited — tool calls arrive in the order the model issued them.
 */
const allStartedBeforeWaiting = (
  toolCalls: readonly ToolCallTrace[],
): boolean => {
  const firstWait = toolCalls.findIndex(
    (call) => call.name === MANAGE && fieldOf(call.input, "action") === "wait",
  );
  if (firstWait === -1) return true;
  return !toolCalls.slice(firstWait + 1).some((call) => call.name === DISPATCH);
};
