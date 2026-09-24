import { FACT_REGISTRY } from "../services/facts/registry";
import type { DecisionPointKey } from "./keys";

/**
 * The decision-point registry — every judgement Fretik asks the decision model
 * to make, declared once, with everything that decides how it is made.
 *
 * It is to the decision model what `role-bindings.ts` is to the chat models:
 * the one hand-written place, because nothing an API publishes can say which
 * bar a verdict must clear, or what happens when no verdict comes. Those are
 * choices about a JOB, and each number below is changed by a reviewed PR with
 * the measurement that justifies it — there is no env var to set one on a
 * single container. Every point here decides; there is no dormant mode. What
 * stands between a wrong verdict and the product is the bar, and what stands
 * between an outage and the product is `noAnswer`.
 *
 * What is NOT here, on purpose: anything a team tunes. The criteria a team
 * controls are descriptions it writes on its own elements — a workflow's
 * trigger criterion, a folder's description — and the model is judged against
 * those. A settings page of thresholds would ask people to reason about
 * probabilities; a sentence on the thing itself asks them to say what they
 * mean.
 */

/**
 * One family of questions inside a point, keyed by the question-id prefix
 * before the first `:` (`wf:<workflowId>` → family `wf`), or by the whole id
 * when there is no colon.
 */
export interface QuestionFamily {
  kind: "boolean" | "choice" | "score";
  /**
   * What the verdict is read from. `probability` is P(true) on a boolean, and
   * on a choice the chosen option's own probability. `confidence` is the
   * model's certainty over the whole distribution — the signal TypeSafe
   * recommends routing on, and the only one that sees a runner-up close
   * behind the winner.
   */
  signal: "probability" | "confidence" | "score";
  /** A multiple of 0.01: answers are rounded to two decimals, so a finer bar
   * is a bar no answer can sit on. */
  threshold: number;
  /** Choice only: the chosen option must ALSO carry at least this much. */
  minChosenProbability?: number;
}

export interface DecisionPointSpec {
  key: DecisionPointKey;
  /** Developer-facing. User-facing wording lives in i18n, if at all. */
  purpose: string;
  /**
   * Bumped on ANY change to a question's wording. Two versions of a question
   * are two different instruments: their probabilities do not share a scale,
   * so calibration never mixes them.
   */
  questionVersion: number;
  families: Readonly<Record<string, QuestionFamily>>;
  /**
   * What the caller does when there is no answer — by construction the
   * behaviour that shipped before the point existed. `proceed`: act as if
   * the gate were absent. `legacy`: run the path this point replaces. `skip`:
   * leave things as they are.
   */
  noAnswer: "proceed" | "legacy" | "skip";
  state: {
    /** Token budget for the state alone. Accuracy falls as the state fills
     * with material the question does not need, so this is a quality bound
     * before it is a context bound. */
    maxTokens: number;
    /**
     * The keys admitted into the state, in the order they are KEPT when the
     * budget binds. An entry ending in `.` admits every key under that prefix.
     * A state is an allow-list, never a pass-through: a key nobody listed
     * never reaches the vendor.
     */
    admit: readonly string[];
    /** Per-value character ceiling (a list counts as one value). Defaults to
     * `MAX_VALUE_CHARS`; a point whose state IS long text (a cluster of
     * episodes, a transcript) raises it and relies on `maxTokens`. */
    maxValueChars?: number;
  };
  /** `hot` runs inside a user's turn: short timeout, never a second transport. */
  path: "hot" | "background";
  timeoutMs: number;
  /** Retry on the gateway when OpenRouter is unavailable. Never on `hot`. */
  fallbackTransport: boolean;
  /** Which decisions reach `decision_log`: every one, only those that changed
   * what happened, a random sample, or none. */
  journal: {
    policy: "all" | "consequential" | "sampled" | "none";
    sampleRate?: number;
  };
  /** What proves this point is sound: the suites to re-run when its question,
   * state or bar changes, and the last run that passed them. */
  evalGate: {
    suites: readonly string[];
    evidence?: {
      command: string;
      runName: string;
      date: string;
      result: string;
    };
  };
}

// ==================== //
// WORKFLOW GATE        //
// ==================== //

/**
 * The facts a trigger criterion is judged against, most telling first.
 *
 * Ids are left out: a uuid carries nothing a criterion can be about, and
 * every token of noise in the state costs accuracy on the tokens that matter.
 * `eventType` leads because it is the one fact that tells "a file arrived"
 * from "a file changed", which criteria like "only new contracts" turn on.
 */
const GATE_HEAD = [
  "eventType",
  "documentSummary",
  "filename",
  "folderPath",
  "customFields.",
  "mentionedOrganizations",
  "collectionName",
  "label",
  "changedFields",
  "fields.",
  "linkTypeKey",
  "fromLabel",
  "toLabel",
  "name",
  "fullPath",
  "providerKey",
  "eventKind",
  "payload.",
] as const;

const isIdKey = (key: string): boolean => /Id$/.test(key);

const gateAdmit = (): string[] => {
  const admitted = new Set<string>(GATE_HEAD);
  for (const family of Object.values(FACT_REGISTRY)) {
    for (const descriptor of family.facts) {
      if (!isIdKey(descriptor.key)) admitted.add(descriptor.key);
    }
    if (family.dynamicPrefix) admitted.add(family.dynamicPrefix.prefix);
  }
  return [...admitted];
};

// ==================== //
// THE REGISTRY         //
// ==================== //

export const DECISION_POINTS: Readonly<
  Record<DecisionPointKey, DecisionPointSpec>
> = {
  "workflow.gate": {
    key: "workflow.gate",
    purpose:
      "Whether a trigger firing deserves a run of a workflow that carries a trigger criterion. One question per workflow, all asked about the event's one fact sheet.",
    // v2: neutral criteria. v1 told the model to "prefer true on doubt" AND
    // sat behind a low threshold — asymmetric twice, which left P(true)
    // meaning nothing calibratable. The asymmetry now lives in the threshold
    // alone.
    questionVersion: 2,
    families: {
      // LOW, on purpose. A run that should not have started is visible — it
      // lands as `not_applicable` and anyone can count it. A run that should
      // have started and did not is invisible until a client asks why their
      // document was never processed. So the gate refuses only on a
      // confident "no".
      wf: { kind: "boolean", signal: "probability", threshold: 0.15 },
    },
    noAnswer: "proceed",
    state: { maxTokens: 6000, admit: gateAdmit() },
    path: "background",
    timeoutMs: 2500,
    fallbackTransport: true,
    journal: { policy: "all" },
    evalGate: { suites: ["jobs unit: workflow-gate", "evals:decisions"] },
  },

  "workflow.criterion.lint": {
    key: "workflow.criterion.lint",
    purpose:
      "Whether a trigger criterion, as written, can gate anything: does it name one particular item, does it need a comparison or a count, does it let every input through. Asked when a criterion is saved on a live workflow, activated, tested, or written by the assistant. It replaced three regexes that each knew a few phrasings in two languages.",
    questionVersion: 1,
    families: {
      // Each bar sits mid-gap between the two sides as measured, because
      // both errors cost: a verdict here REFUSES a sentence someone wrote,
      // and a flawed criterion let through refuses real firings (visible as
      // `filtered` runs, which is why no answer lets it through). Measured
      // 2026-09-24 (`evals:decisions`, 23 cases × 5, in English, French,
      // Spanish and German): sound criteria at most one 0.38, cmp 0.64 (a
      // year named), open 0.40; flawed ones one 0.84–0.93, cmp 0.97–0.98,
      // open 0.87–0.91.
      one: { kind: "boolean", signal: "probability", threshold: 0.7 },
      cmp: { kind: "boolean", signal: "probability", threshold: 0.8 },
      open: { kind: "boolean", signal: "probability", threshold: 0.65 },
    },
    noAnswer: "proceed",
    state: { maxTokens: 500, admit: ["criterion"] },
    // The assistant writes criteria inside a person's turn.
    path: "hot",
    timeoutMs: 1500,
    fallbackTransport: false,
    // Nothing to journal against: a draft has no id yet, and no later event
    // labels a lint verdict right or wrong.
    journal: { policy: "none" },
    evalGate: {
      suites: [
        "shared unit: criterion-lint",
        "evals:decisions",
        "evals:langfuse -- --suite descriptions",
      ],
    },
  },

  "workflow.criterion.missing": {
    key: "workflow.criterion.missing",
    purpose:
      "Whether an event workflow the assistant created WITHOUT a trigger criterion is, by its goal, meant for only one kind of the inputs its trigger delivers. A yes adds a hint to the tool result asking for the criterion; it never refuses anything.",
    questionVersion: 1,
    families: {
      // Mid-gap. A wrong hint pushes a criterion onto a workflow meant for
      // every input, and the gate then refuses what that criterion does not
      // name; a missed one leaves the playbook sorting its own inputs.
      // Measured 2026-09-24 (`evals:decisions`, 7 cases × 5): goals for one
      // kind 0.75–0.94, goals for every input 0.26–0.36 — including one
      // whose trigger already narrows the inputs (0.28).
      narrow: { kind: "boolean", signal: "probability", threshold: 0.55 },
    },
    noAnswer: "skip",
    state: {
      maxTokens: 1200,
      admit: ["name", "goal", "description", "trigger"],
    },
    path: "hot",
    timeoutMs: 1500,
    fallbackTransport: false,
    journal: { policy: "none" },
    evalGate: {
      suites: ["evals:decisions", "evals:langfuse -- --suite descriptions"],
    },
  },

  "drive.file": {
    key: "drive.file",
    purpose:
      "Which folder a document that arrived with no destination belongs in, or none. One choice over the team's busiest folders plus an explicit root option.",
    questionVersion: 2,
    families: {
      // HIGH — the inverse of the gate. A misfiled document is worse than an
      // unfiled one: unfiled, the person sees it at the root and moves it;
      // misfiled, they do not know it exists and have nowhere to look.
      // Confidence, not the winner's probability alone: a 0.55 winner with a
      // 0.40 runner-up is a coin toss, and only the distribution says so.
      folder: {
        kind: "choice",
        signal: "confidence",
        threshold: 0.75,
        minChosenProbability: 0.5,
      },
    },
    noAnswer: "skip",
    state: {
      maxTokens: 3000,
      // No custom fields: extracted values are the noise here, not the
      // signal — the summary already says what the document IS.
      admit: [
        "documentSummary",
        "filename",
        "mentionedOrganizations",
        "documentLanguage",
        "extension",
      ],
    },
    path: "background",
    timeoutMs: 2500,
    fallbackTransport: true,
    journal: { policy: "all" },
    evalGate: { suites: ["shared unit: folder-filing", "evals:decisions"] },
  },

  "memory.consolidate.prescreen": {
    key: "memory.consolidate.prescreen",
    purpose:
      "Whether a cluster of episodes needs the nightly consolidation judge at all. Two questions about the same cluster: do two episodes tell the same story, and does anything contradict or outdate one of them. Both clearly no means the cluster stays as it is without an LLM call.",
    questionVersion: 1,
    families: {
      // Skipping is the only thing a verdict can cause, and a wrong skip
      // leaves a duplicate or a stale fact standing for another night. So the
      // bar is LOW on both: only a confident double "no" skips.
      same: { kind: "boolean", signal: "probability", threshold: 0.1 },
      conflict: { kind: "boolean", signal: "probability", threshold: 0.1 },
    },
    noAnswer: "legacy",
    state: {
      maxTokens: 9000,
      admit: ["today", "episodes", "recentActivity"],
      // The state IS the episodes; the token budget bounds it, not a clip.
      maxValueChars: 24_000,
    },
    path: "background",
    timeoutMs: 4000,
    fallbackTransport: true,
    journal: { policy: "all" },
    evalGate: {
      suites: [
        "evals:memory -- --case mem-consolidate-noop,mem-consolidate-merge,mem-consolidate-revise,mem-consolidate-reanchor",
        "evals:decisions",
      ],
    },
  },

  "memory.resolve.verify": {
    key: "memory.resolve.verify",
    purpose:
      "Whether a mention the resolver matched in its review band really refers to the record. One question per record in the band, all about the event's text: a confident yes confirms the link, a confident no drops it, anything else leaves it suggested.",
    // v2 names what a false match looks like (an ordinary word, someone
    // else) instead of "nothing specific".
    questionVersion: 2,
    families: {
      // A SYMMETRIC band, one bar for both ends: confirm at or above it,
      // drop at or below 1 minus it. Both ends move a link out of the review
      // band a person would otherwise have to look at, so both are held to
      // the same certainty. Measured 2026-09-24 on v2 (`evals:decisions`, 8
      // cases × 5): true references 0.82–0.95, ordinary words and namesakes
      // 0.02–0.11. At the old 0.90 half of each side stayed in the band and
      // the point decided nothing; 0.75 decides all of them, 0.07 and 0.14
      // clear of the nearest answer.
      anc: { kind: "boolean", signal: "probability", threshold: 0.75 },
    },
    noAnswer: "legacy",
    state: {
      maxTokens: 2500,
      admit: ["eventType", "text"],
      maxValueChars: 4000,
    },
    path: "background",
    timeoutMs: 2500,
    fallbackTransport: true,
    journal: { policy: "all" },
    evalGate: {
      suites: ["shared unit: anchor-verify", "evals:decisions"],
    },
  },

  "graph.link-type-match": {
    key: "graph.link-type-match",
    purpose:
      'Whether a relation name no key or spelling matches means the same as a relation type the team already has (`employed_by` for `works_for`). One choice over the relation types of the same source collection, plus an explicit "none of these".',
    // v2 writes every option as the same sentence about the same two
    // records, and drops the inverse readings v1 showed: with them, the
    // model took `subsidiary_of` for `owns`.
    questionVersion: 2,
    families: {
      // A wrong reuse files facts under the wrong meaning, which is worse
      // than one more near-duplicate type a person can merge later. So a
      // reuse needs the filer's certainty. Measured 2026-09-24 on v2
      // (`evals:decisions`, 9 cases × 5): synonyms at confidence 0.92–0.99,
      // inverse-direction and unrelated names answered "none" at 0.93+, and
      // the one wrong pick left (`invested_in` → `owns`) at 0.36.
      type: {
        kind: "choice",
        signal: "confidence",
        threshold: 0.8,
        minChosenProbability: 0.5,
      },
    },
    noAnswer: "legacy",
    state: {
      maxTokens: 500,
      admit: ["relation", "from", "to"],
    },
    path: "background",
    timeoutMs: 2500,
    fallbackTransport: true,
    journal: { policy: "all" },
    evalGate: { suites: ["shared unit: link-type-match", "evals:decisions"] },
  },

  "memory.distill.worth": {
    key: "memory.distill.worth",
    purpose:
      "Whether a conversation holds anything worth remembering before the distiller writes it up as an episode. Asked once, for a conversation that has no episode yet.",
    questionVersion: 1,
    families: {
      // An episode not written is a memory the team never gets back, while
      // one written for small talk costs one retrieval slot. So only an
      // unmistakable "nothing here" skips.
      worth: { kind: "boolean", signal: "probability", threshold: 0.05 },
    },
    noAnswer: "legacy",
    state: {
      maxTokens: 8000,
      admit: ["transcript"],
      maxValueChars: 32_000,
    },
    path: "background",
    timeoutMs: 4000,
    fallbackTransport: true,
    journal: { policy: "all" },
    evalGate: {
      suites: ["evals:memory -- --case mem-distill-*", "evals:decisions"],
    },
  },

  "memory.promote.support": {
    key: "memory.promote.support",
    purpose:
      "Whether each episode of a promotion cluster actually states the team fact the promoter proposes to store. One question per (proposed fact, episode); the count of supporting episodes decides whether the write happens.",
    // v2: an episode that SETS the fact (a decision, a rule, a standing
    // request) supports it too.
    questionVersion: 2,
    families: {
      // Per episode, a plain majority reading: the count across episodes is
      // what carries the rule (two for a new fact, one for a correction).
      sup: { kind: "boolean", signal: "probability", threshold: 0.5 },
    },
    noAnswer: "legacy",
    state: {
      maxTokens: 9000,
      admit: ["episodes"],
      maxValueChars: 24_000,
    },
    path: "background",
    timeoutMs: 4000,
    fallbackTransport: true,
    journal: { policy: "all" },
    evalGate: {
      suites: ["evals:memory -- --case mem-promote-*", "evals:decisions"],
    },
  },

  "graph.entity-match": {
    key: "graph.entity-match",
    purpose:
      'Whether a party a document mentions is a record the team already has, when its name is close to existing records but not close enough for spelling to decide. One choice per such mention over its nearest records, plus "another one".',
    questionVersion: 1,
    families: {
      // A wrong link attaches a document to the wrong client, which every
      // later answer about that client repeats. A missed link costs a
      // suggested duplicate a person merges. So linking needs certainty.
      ent: {
        kind: "choice",
        signal: "confidence",
        threshold: 0.8,
        minChosenProbability: 0.5,
      },
    },
    noAnswer: "legacy",
    state: {
      maxTokens: 1500,
      admit: ["filename", "documentSummary"],
    },
    path: "background",
    timeoutMs: 2500,
    fallbackTransport: true,
    journal: { policy: "all" },
    evalGate: { suites: ["shared unit: entity-match", "evals:decisions"] },
  },

  "chat.turn.continuation": {
    key: "chat.turn.continuation",
    purpose:
      'Whether the short last message of a turn that did tool work announces an action it never performed ("let me check…" then nothing), so the turn should continue. The classifier it replaced answers only when this one cannot.',
    questionVersion: 1,
    families: {
      // A wrong "continue" re-runs work the person already has; a wrong
      // "stop" leaves a turn that says "let me check" and never does. The
      // old classifier's rule was "unsure → stop", so the bar is high.
      announce: { kind: "boolean", signal: "probability", threshold: 0.7 },
    },
    noAnswer: "legacy",
    state: {
      maxTokens: 800,
      admit: ["message"],
    },
    // Inside a person's turn: short deadline, never a second transport.
    path: "hot",
    timeoutMs: 1500,
    fallbackTransport: false,
    journal: { policy: "all" },
    evalGate: {
      suites: [
        "evals:langfuse -- --suite doctrine (dead-final-step cases)",
        "evals:decisions",
      ],
    },
  },

  "chat.recall-select": {
    key: "chat.recall-select",
    purpose:
      "Which retrieved candidates help answer the message, on the turns where retrieval was too weak to serve deterministically (the ones `adaptive` used to hand straight to the recall judge). One yes/no per candidate, and one per record the message's words matched; the kept ones go through the SAME verbatim renderer, and the judge answers only when this one cannot.",
    // v2 asks about the matched records too (`anc`, the resolve-verify
    // question): the renderer passed them through, and a homonym's graph made
    // a block out of a message nothing answered.
    questionVersion: 2,
    families: {
      rel: { kind: "boolean", signal: "probability", threshold: 0.5 },
      // The resolve-verify bar for the same question (true references
      // 0.82–0.95). Not mid-gap: "quel horizon de placement…" scored the
      // project Horizon at 0.62 here, and a kept homonym IS the block.
      anc: { kind: "boolean", signal: "probability", threshold: 0.75 },
    },
    noAnswer: "legacy",
    state: {
      maxTokens: 1500,
      admit: ["message", "recent"],
    },
    path: "hot",
    timeoutMs: 1500,
    fallbackTransport: false,
    journal: { policy: "all" },
    evalGate: {
      suites: [
        "evals:recall -- --repeats 10 (23/23)",
        "evals:langfuse -- --suite memory-recall",
        "evals:decisions",
      ],
    },
  },

  "external-apps.mcp.suggest-kind": {
    key: "external-apps.mcp.suggest-kind",
    purpose:
      "What an MCP tool does when its server did not say: only reads, writes, deletes, or depends on an argument. One choice per un-annotated tool, asked once per tool snapshot. A suggestion an admin accepts or rejects, never a classification: the tool stays gated until an admin decides.",
    questionVersion: 1,
    families: {
      // HIGH: an admin reads this before lifting an approval gate, and a
      // wrong "only reads" invites a write onto the ungated path. The
      // suggestion shows only when the whole distribution is decided.
      kind: {
        kind: "choice",
        signal: "confidence",
        threshold: 0.8,
        minChosenProbability: 0.6,
      },
    },
    noAnswer: "skip",
    state: {
      maxTokens: 600,
      admit: ["server", "serverDescription"],
    },
    path: "background",
    timeoutMs: 5000,
    fallbackTransport: true,
    journal: { policy: "all" },
    evalGate: {
      suites: [
        "shared unit: mcp-suggest-kinds",
        "evals:decisions",
        "labels: admin accept/reject",
      ],
    },
  },
};

export const decisionPoint = (key: DecisionPointKey): DecisionPointSpec =>
  DECISION_POINTS[key];

/** The family a question id belongs to: the prefix before the first `:`. */
export const familyOf = (questionId: string): string => {
  const at = questionId.indexOf(":");
  return at === -1 ? questionId : questionId.slice(0, at);
};
