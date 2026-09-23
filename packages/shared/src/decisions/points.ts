import type { DecisionMode } from "../schemas/decisions";
import { FACT_REGISTRY } from "../services/facts/registry";
import type { DecisionPointKey } from "./keys";

/**
 * The decision-point registry — every judgement Fretik asks the decision model
 * to make, declared once, with everything that decides how it is made.
 *
 * It is to the decision model what `role-bindings.ts` is to the chat models:
 * the one hand-written place, because nothing an API publishes can say which
 * bar a verdict must clear, or what happens when no verdict comes. Those are
 * choices about a JOB, and each number below is changed by a reviewed PR,
 * never by an env var someone forgot on one container. The operator's
 * emergency lever is `DECISION_OVERRIDES` (see `./policy.ts`), read in ONE
 * process and echoed back in every answer.
 *
 * What is NOT here, on purpose: anything a team tunes. The criteria a team
 * controls are descriptions it writes on its own elements — a workflow's
 * trigger criterion, a folder's description — and the model is judged against
 * those. A settings page of thresholds would ask people to reason about
 * probabilities; a sentence on the thing itself asks them to say what they
 * mean.
 */

export type { DecisionMode };

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
    /** The admitted keys that reproduce workspace CONTENT rather than
     * describing it. Dropped when content egress is off. */
    content: readonly string[];
    /** Per-value character ceiling (a list counts as one value). Defaults to
     * `MAX_VALUE_CHARS`; a point whose state IS long text (a cluster of
     * episodes, a transcript) raises it and relies on `maxTokens`. */
    maxValueChars?: number;
  };
  /** `content` = the state IS content (a message, a transcript), so the point
   * is skipped outright when content egress is off. `redactable` = content
   * keys are dropped and the rest is asked. `metadata` = no content at all. */
  egress: "metadata" | "redactable" | "content";
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
  defaultMode: DecisionMode;
  /** What proves this point is sound, and where the proof was recorded. A
   * `hot` point may not default to `on` without `evidence`. */
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

const gateContent = (): string[] => {
  const content = new Set<string>();
  for (const family of Object.values(FACT_REGISTRY)) {
    for (const descriptor of family.facts) {
      if (descriptor.sensitive === true) content.add(descriptor.key);
    }
    if (family.dynamicPrefix?.sensitive === true) {
      content.add(family.dynamicPrefix.prefix);
    }
  }
  return [...content];
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
    state: { maxTokens: 6000, admit: gateAdmit(), content: gateContent() },
    egress: "redactable",
    path: "background",
    timeoutMs: 2500,
    fallbackTransport: true,
    journal: { policy: "all" },
    defaultMode: "on",
    evalGate: { suites: ["jobs unit: workflow-gate"] },
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
      content: ["documentSummary", "mentionedOrganizations"],
    },
    egress: "redactable",
    path: "background",
    timeoutMs: 2500,
    fallbackTransport: true,
    journal: { policy: "all" },
    defaultMode: "on",
    evalGate: { suites: ["shared unit: folder-filing"] },
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
      content: ["episodes", "recentActivity"],
      // The state IS the episodes; the token budget bounds it, not a clip.
      maxValueChars: 24_000,
    },
    egress: "content",
    path: "background",
    timeoutMs: 4000,
    fallbackTransport: true,
    journal: { policy: "all" },
    // Shadow until the evals say otherwise: the judge still runs every time,
    // and each verdict is journaled next to what the judge decided.
    defaultMode: "shadow",
    evalGate: {
      suites: [
        "evals:memory -- --case mem-consolidate-noop,mem-consolidate-merge,mem-consolidate-revise,mem-consolidate-reanchor",
      ],
    },
  },

  "memory.resolve.verify": {
    key: "memory.resolve.verify",
    purpose:
      "Whether a mention the resolver matched in its review band really refers to the record. One question per record in the band, all about the event's text: a confident yes confirms the link, a confident no drops it, anything else leaves it suggested.",
    questionVersion: 1,
    families: {
      // A SYMMETRIC band, one bar for both ends: confirm at or above it,
      // drop at or below 1 minus it. Both ends move a link out of the review
      // band a person would otherwise have to look at, so both are held to
      // the same certainty.
      anc: { kind: "boolean", signal: "probability", threshold: 0.9 },
    },
    noAnswer: "legacy",
    state: {
      maxTokens: 2500,
      admit: ["eventType", "text"],
      content: ["text"],
      maxValueChars: 4000,
    },
    egress: "content",
    path: "background",
    timeoutMs: 2500,
    fallbackTransport: true,
    journal: { policy: "all" },
    defaultMode: "shadow",
    evalGate: { suites: ["jobs unit: memory-resolve-verify"] },
  },

  "graph.link-type-match": {
    key: "graph.link-type-match",
    purpose:
      'Whether a relation name no key or spelling matches means the same as a relation type the team already has (`employed_by` for `works_for`). One choice over the relation types of the same source collection, plus an explicit "none of these".',
    questionVersion: 1,
    families: {
      // A wrong reuse files facts under the wrong meaning, which is worse
      // than one more near-duplicate type a person can merge later. So a
      // reuse needs the filer's certainty.
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
      content: [],
    },
    egress: "metadata",
    path: "background",
    timeoutMs: 2500,
    fallbackTransport: true,
    journal: { policy: "all" },
    defaultMode: "shadow",
    evalGate: { suites: ["shared unit: link-type-match"] },
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
      content: ["transcript"],
      maxValueChars: 32_000,
    },
    egress: "content",
    path: "background",
    timeoutMs: 4000,
    fallbackTransport: true,
    journal: { policy: "all" },
    defaultMode: "shadow",
    evalGate: { suites: ["evals:memory -- --case mem-distill-*"] },
  },

  "memory.promote.support": {
    key: "memory.promote.support",
    purpose:
      "Whether each episode of a promotion cluster actually states the team fact the promoter proposes to store. One question per (proposed fact, episode); the count of supporting episodes decides whether the write happens.",
    questionVersion: 1,
    families: {
      // Per episode, a plain majority reading: the count across episodes is
      // what carries the rule (two for a new fact, one for a correction).
      sup: { kind: "boolean", signal: "probability", threshold: 0.5 },
    },
    noAnswer: "legacy",
    state: {
      maxTokens: 9000,
      admit: ["episodes"],
      content: ["episodes"],
      maxValueChars: 24_000,
    },
    egress: "content",
    path: "background",
    timeoutMs: 4000,
    fallbackTransport: true,
    journal: { policy: "all" },
    defaultMode: "shadow",
    evalGate: { suites: ["evals:memory -- --case mem-promote-*"] },
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
      content: ["documentSummary"],
    },
    egress: "redactable",
    path: "background",
    timeoutMs: 2500,
    fallbackTransport: true,
    journal: { policy: "all" },
    defaultMode: "shadow",
    evalGate: { suites: ["shared unit: entity-match"] },
  },

  "chat.turn.continuation": {
    key: "chat.turn.continuation",
    purpose:
      'Whether the short last message of a turn that did tool work announces an action it never performed ("let me check…" then nothing), so the turn should continue. Runs beside the classifier it would replace; until measured, the classifier decides.',
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
      content: ["message"],
    },
    egress: "content",
    // Inside a person's turn: short deadline, never a second transport.
    path: "hot",
    timeoutMs: 1500,
    fallbackTransport: false,
    journal: { policy: "all" },
    defaultMode: "shadow",
    evalGate: {
      suites: ["evals:langfuse -- --suite doctrine (dead-final-step cases)"],
    },
  },

  "workflow.turn.convergence": {
    key: "workflow.turn.convergence",
    purpose:
      "How close a workflow run's current task is to done, after a turn that called tools but closed no task. A four-level score journaled next to the turn counters that stop a run that no longer converges; measurement only, it changes nothing.",
    questionVersion: 1,
    families: {
      // Read as "stuck" below this position on the 0..3 scale. Shadow only:
      // the counters stay the safety net, and this is what they are compared
      // against once runs' outcomes label it.
      conv: { kind: "score", signal: "score", threshold: 0.5 },
    },
    noAnswer: "skip",
    state: {
      maxTokens: 2500,
      admit: ["task", "turn", "tools"],
      content: ["task", "turn"],
      maxValueChars: 4000,
    },
    egress: "content",
    path: "background",
    timeoutMs: 2500,
    fallbackTransport: true,
    journal: { policy: "all" },
    defaultMode: "shadow",
    evalGate: { suites: ["measurement only: joined to workflow_runs.error"] },
  },

  "chat.recall-select": {
    key: "chat.recall-select",
    purpose:
      "Which retrieved candidates help answer the message, on the turns where retrieval was too weak to serve deterministically (the ones `adaptive` hands to the recall judge). One yes/no per candidate; the kept ones go through the SAME verbatim renderer. Only reached under RECALL_MODE / X-Recall-Mode `decision`.",
    questionVersion: 1,
    families: {
      rel: { kind: "boolean", signal: "probability", threshold: 0.5 },
    },
    noAnswer: "legacy",
    state: {
      maxTokens: 1500,
      admit: ["message", "recent"],
      content: ["message", "recent"],
    },
    egress: "content",
    path: "hot",
    timeoutMs: 1500,
    fallbackTransport: false,
    journal: { policy: "all" },
    // Hot path: `on` needs recorded evidence (`evalGate.evidence`). Until
    // then, the `decision` recall mode journals and falls back to the judge;
    // an A/B that must act sets DECISION_OVERRIDES
    // {"chat.recall-select":{"mode":"on"}} on the AI service it runs against.
    defaultMode: "shadow",
    evalGate: {
      suites: [
        "evals:recall -- --mode decision --repeats 10 (parity 23/23, lower p50)",
        "evals:langfuse -- --suite memory-recall --recall-mode decision",
      ],
    },
  },

  "chat.addressee": {
    key: "chat.addressee",
    purpose:
      "In a conversation with several people, whether a message is addressed to the assistant or to the others. The assistant answers every message today; this measures how often it should not, before anything lets it stay quiet.",
    questionVersion: 1,
    families: {
      addr: { kind: "boolean", signal: "probability", threshold: 0.3 },
    },
    noAnswer: "proceed",
    state: {
      maxTokens: 2000,
      admit: ["participants", "message", "recent"],
      content: ["participants", "message", "recent"],
      maxValueChars: 3000,
    },
    egress: "content",
    // Fire-and-forget from the stream route: never waited on, so background.
    path: "background",
    timeoutMs: 2500,
    fallbackTransport: true,
    journal: { policy: "all" },
    // Shadow for good until a person can see "Fretik did not answer" and
    // ask it to: staying quiet with no way back would be the invisible
    // failure every other point here is built to avoid.
    defaultMode: "shadow",
    evalGate: { suites: ["measurement only"] },
  },
};

export const decisionPoint = (key: DecisionPointKey): DecisionPointSpec =>
  DECISION_POINTS[key];

/** The family a question id belongs to: the prefix before the first `:`. */
export const familyOf = (questionId: string): string => {
  const at = questionId.indexOf(":");
  return at === -1 ? questionId : questionId.slice(0, at);
};
