/**
 * `dispatchAgent` tool — sub-agent delegation.
 *
 * The chatbot hands a many-call job to a sub-agent that runs its own tool
 * loop in a fresh context, on the parent's model, and returns a structured
 * report (`{ status, summary, files?, reason?, toolCalls, durationMs,
 * activity }`). Sub-agents dispatched in the same step run in parallel.
 *
 * What we validate end-to-end, in both directions:
 *
 *   - **It fires when it should**: independent angles of one question are
 *     dispatched as several sub-agents IN THE SAME STEP (their windows
 *     overlap), and a multi-source synthesis covers every source.
 *
 *   - **It stays out of the way**: a one-fact lookup never routes through
 *     `dispatchAgent` — delegation costs a whole agent loop.
 *
 *   - **The brief is self-contained**: what the user said reaches the
 *     sub-agent's `task`, since the sub-agent sees nothing else.
 *
 *   - **The right mode**: a mechanical sweep asked for "quick" goes out with
 *     `model: "fast"`; research asked for "in the background" goes out with
 *     `background: true`, and the turn keeps answering instead of waiting.
 *
 * The report being structured is what lets these cases see INSIDE a
 * sub-agent at all: `status` says whether it finished, `activity` which
 * tools it called. What a sub-agent may do (no writes, no recursion) is a
 * registry property, pinned by the deterministic unit test
 * `tests/unit/agents/sub-agent-registry.test.ts` — an e2e turn adds nothing
 * over it.
 *
 * Tagged `dispatch-agent` for filtering / dataset-item metadata.
 */

import type { EvalSuite, ToolCallTrace } from "../types";

const DISPATCH = "dispatchAgent";

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
        "Sanity check: when the user EXPLICITLY asks for a sub-agent, the agent MUST invoke the tool and the sub-agent must come back with a finished report. If this case fails the tool is not technically exposed (registry / prepareStep / activeTools) or the sub-agent cannot run; no amount of prompt engineering will help. If this passes but the soft cases don't trigger dispatchAgent, the problem is doctrine / model bias.",
      prompt:
        "Utilise un sous-agent pour me faire un résumé en 3 bullets des 3 derniers documents que la team a importés. Le sous-agent doit récupérer la liste, lire chacun, puis renvoyer la synthèse.",
      tags: ["dispatch-agent", "sanity"],
      assertions: [
        { type: "noError" },
        { type: "toolUsed", tools: [DISPATCH] },
        {
          type: "custom",
          name: "the sub-agent finished with a report",
          fn: (result) => {
            const reports = dispatchReports(result.toolCalls);
            if (reports.length === 0) return "no dispatchAgent result observed";
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
        "Positive trigger with a hard assertion: three independent angles of one question (internal data, documents, the web) are the canonical fan-out. The agent must dispatch at least two sub-agents, and dispatch them in the SAME step — their execution windows overlap. Sequential dispatches mean the parallelism, which is most of the point, was lost.",
      prompt:
        "Prépare-moi un point complet sur notre principal client : ce que disent nos données (factures, montants, dates), ce que disent nos documents (contrats, comptes rendus), et ce qu'on trouve de public sur le web à son sujet. Travaille les trois pistes en parallèle, puis fais-moi une synthèse structurée.",
      tags: ["dispatch-agent", "parallel"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "≥2 sub-agents dispatched in parallel",
          fn: (result) => {
            const calls = result.toolCalls.filter((c) => c.name === DISPATCH);
            if (calls.length < 2) {
              return `${calls.length.toString()} dispatchAgent call(s) — expected at least 2`;
            }
            return (
              windowsOverlap(calls) ||
              "the dispatchAgent calls ran one after another, not in the same step"
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
      id: "dispatch-background-keeps-working",
      description:
        "Background delegation: the user asks for a long piece of research to run in the background while they get an unrelated answer now. The dispatch must carry `background: true`, and the SAME turn must go on to answer the second question instead of waiting — the report comes back in a later, resumed turn this case does not follow.",
      prompt:
        "Lance en arrière-plan un sous-agent qui fait une veille web sur les pratiques de délais de paiement B2B publiées cette année. En attendant, dis-moi combien de clients nous avons.",
      tags: ["dispatch-agent", "background"],
      assertions: [
        { type: "noError" },
        {
          type: "custom",
          name: "the research is dispatched in the background",
          fn: (result) =>
            result.toolCalls.some(
              (c) =>
                c.name === DISPATCH && fieldOf(c.input, "background") === true,
            ) || "no dispatchAgent call carried background: true",
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

interface DispatchReport {
  status: string;
  summary: string;
}

/** The finished reports of every `dispatchAgent` call, old shapes excluded. */
const dispatchReports = (
  toolCalls: readonly ToolCallTrace[],
): DispatchReport[] =>
  toolCalls
    .filter((call) => call.name === DISPATCH)
    .map((call) => {
      const status = fieldOf(call.output, "status");
      const summary = fieldOf(call.output, "summary");
      return {
        status: typeof status === "string" ? status : "",
        summary: typeof summary === "string" ? summary : "",
      };
    })
    .filter((report) => report.status.length > 0);

/**
 * Whether any two of the calls ran at the same time. A step's tool calls are
 * issued together, so two dispatches in one step overlap; two in successive
 * steps cannot, since the second step waits for the first's results.
 */
const windowsOverlap = (calls: readonly ToolCallTrace[]): boolean => {
  const windows = calls
    .filter(
      (call) => call.startedAtMs !== undefined && call.latencyMs !== undefined,
    )
    .map((call) => ({
      start: call.startedAtMs ?? 0,
      end: (call.startedAtMs ?? 0) + (call.latencyMs ?? 0),
    }))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < windows.length; i += 1) {
    const previous = windows[i - 1];
    const current = windows[i];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.start < previous.end
    ) {
      return true;
    }
  }
  return false;
};
