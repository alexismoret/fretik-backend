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
};

export const decisionPoint = (key: DecisionPointKey): DecisionPointSpec =>
  DECISION_POINTS[key];

/** The family a question id belongs to: the prefix before the first `:`. */
export const familyOf = (questionId: string): string => {
  const at = questionId.indexOf(":");
  return at === -1 ? questionId : questionId.slice(0, at);
};
