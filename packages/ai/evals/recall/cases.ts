/**
 * Recall eval cases (P5-bis) — the memory block itself is the unit under
 * test, scored directly on `runUnifiedRecall`'s output against the
 * deterministic fixture universe (`fixtures.ts`).
 *
 * Coverage axes (per the chantier brief):
 *  - every provenance: documents, records, episodes, memories, graph;
 *  - imprecise / implicit user phrasing (vague references, short
 *    follow-ups riding on the recent tail);
 *  - vicious cases: homonyms that false-anchor, confusable entities,
 *    private-episode leakage;
 *  - volume: many plausible candidates, selectivity required;
 *  - noise: recall must stay silent (NONE).
 *
 * Expectations are marker substrings resolved against the fixture
 * manifest at runtime — `(record:<id>` / `(episode:<id>` /
 * `(memory:<path>` / `(document:<id>` as emitted by the judge.
 */

import type { RecallFixtures } from "./fixtures";

// Markers match WITHOUT the opening paren: the judge occasionally inverts
// the layout (`- record:<id> (Label)`) — the provenance the main agent
// reads is the `kind:id` pair, which both layouts carry.
export const rec = (id: string): string => `record:${id}`;
export const ep = (id: string): string => `episode:${id}`;
export const mem = (path: string): string => `memory:${path}`;
export const doc = (id: string): string => `document:${id}`;
export const wf = (id: string): string => `workflow:${id}`;

export interface RecallEvalCase {
  id: string;
  description: string;
  message: string;
  recentTail?: string;
  /** false → run in system scope (userId undefined) — the privacy axis. */
  asUser?: boolean;
  /**
   * true → a memory block is required; false → NONE (or gated-to-null) is the
   * correct outcome. Omit ONLY when the memory block is not this case's axis
   * and either outcome is defensible — asserting a guess is how a case stops
   * being ground truth.
   */
  expectBlock?: boolean;
  /** Marker substrings the block MUST contain (all of them). */
  mustCite?: (fx: RecallFixtures) => string[];
  /** Marker substrings the block must NOT contain (any of them fails). */
  mustNotCite?: (fx: RecallFixtures) => string[];
  /** Ceiling on distinct `(record:` markers — the volume/selectivity axis. */
  maxRecordMarkers?: number;
  /**
   * The CAPABILITY channel, asserted separately from the memory block: it is
   * judge-free and has its own budget, so a case can legitimately expect a
   * capability and no memory block, or the reverse. Undefined = not asserted.
   */
  expectCapability?: boolean;
  mustCiteCapability?: (fx: RecallFixtures) => string[];
}

export const RECALL_CASES: RecallEvalCase[] = [
  {
    id: "rec-episode-decision",
    description:
      "Explicit ask about a past decision → the contract episode's substance must surface.",
    message: "Qu'est-ce qu'on avait décidé pour le contrat Nordwind ?",
    expectBlock: true,
    mustCite: (fx) => [ep(fx.episodes.contract)],
    mustNotCite: (fx) => [ep(fx.episodes.privateBail)],
  },
  {
    id: "rec-episode-right-one",
    description:
      "Two episodes mention Nordwind (contract vs old pricing benchmark) — a delivery question must pull the CONTRACT episode.",
    message:
      "Pour les livraisons Nordwind, on était partis sur quel rythme déjà ?",
    expectBlock: true,
    mustCite: (fx) => [ep(fx.episodes.contract)],
  },
  {
    id: "rec-graph-usage-vs-relevance",
    description:
      "Three heavily-recalled routine episodes vs one fresh, directly relevant one on the same anchor (Callisto) — the fresh episode must reach the judge and be cited. Guards the recall-boost cap in graph.ts: unbounded, +60 recalls outrank content freshness and evict the relevant episode from the 3 graph slots (measured 2026-08-05: a 67×-recalled fixture episode monopolised the arm).",
    message: "Qui est notre contact support chez Callisto Systems ?",
    expectBlock: true,
    mustCite: (fx) => [ep(fx.episodes.callistoFresh)],
  },
  {
    id: "rec-record-exact",
    description: "Exact record name → GRAPH/record recall with the right id.",
    message: "Fais-moi un point sur Nordwind GmbH.",
    expectBlock: true,
    mustCite: (fx) => [rec(fx.records.nordwind)],
  },
  {
    id: "rec-record-vague",
    description:
      "Vague description, no name ('le fournisseur allemand ajouté récemment pour les écrans') → semantic records arm must find it.",
    message:
      "C'est quoi déjà le fournisseur allemand qu'on a ajouté récemment pour les écrans ?",
    expectBlock: true,
    mustCite: (fx) => [rec(fx.records.nordwind)],
    mustNotCite: (fx) => [rec(fx.records.nordwindConsulting)],
  },
  {
    id: "rec-memory-implicit",
    description:
      "Terse command where a saved team process applies ('prépare le récap hebdo') → FACTS citing the memory.",
    message: "Prépare le récap hebdo des fournisseurs.",
    expectBlock: true,
    mustCite: (fx) => [mem(fx.memoryPaths.recapHebdo)],
  },
  {
    id: "rec-document-content",
    description:
      "Question answerable from an indexed document → document marker cited.",
    message: "Quel est le montant de la caution dans le bail Sirius ?",
    expectBlock: true,
    mustCite: (fx) => [doc(fx.documents.bail)],
  },
  {
    id: "rec-noise-general",
    description:
      "General-knowledge question → NONE. Hard on purpose: the corpus DOES contain an ambient invoice whose VAT amount lexically dominates the ranking — the judge must refuse a dominant but non-responsive candidate. Retrieval is byte-identical across repeats; the residual is judge-side selectivity.",
    message:
      "Quelle est la différence entre la TVA collectée et la TVA déductible ?",
    expectBlock: false,
  },
  {
    id: "rec-noise-smalltalk",
    description: "Small talk (too long for the trivial skip) → NONE.",
    message: "Salut, tu vas bien aujourd'hui ?",
    expectBlock: false,
  },
  {
    id: "rec-vicious-homonym",
    description:
      "'horizon' is a project record AND a common word — used here in a subject with ZERO overlap with the project (cash placement), the anchor false-positives and the judge must stay silent. (An earlier wording, 'quel horizon pour lancer un MVP', was thematically ambiguous with the project's own scoping phase — a defensible include, not a clean ground truth.)",
    message:
      "Quel horizon de placement recommandes-tu pour la trésorerie excédentaire ?",
    expectBlock: false,
    mustNotCite: (fx) => [rec(fx.records.horizon)],
  },
  {
    id: "rec-vicious-confusable",
    description:
      "Nordwind Consulting vs Nordwind GmbH — a Consulting question must not drag the GmbH contract episode in.",
    message:
      "Prépare un point de suivi de la mission avec Nordwind Consulting.",
    expectBlock: true,
    mustCite: (fx) => [rec(fx.records.nordwindConsulting)],
    mustNotCite: (fx) => [ep(fx.episodes.contract)],
  },
  {
    id: "rec-volume-selectivity",
    description:
      "Broad supplier question over a 16-record corpus — the block must stay selective (bullet caps), not dump the catalogue.",
    message: "Fais le point sur nos fournisseurs actifs.",
    expectBlock: true,
    maxRecordMarkers: 6,
  },
  {
    id: "rec-multi-domain",
    description:
      "One message pulling THREE distinct provenances at once: the relance-style memory (FACTS), the contract episode (EPISODES), and the graph neighbourhood (GRAPH: Nordwind → Horizon). The third domain is the graph edge, not a standalone record card — the episode already carries Nordwind, so the judge represents the link via GRAPH (citing the neighbour Horizon).",
    message: "Rédige la relance pour Nordwind comme convenu.",
    expectBlock: true,
    mustCite: (fx) => [
      mem(fx.memoryPaths.relanceStyle),
      ep(fx.episodes.contract),
      "Horizon",
    ],
  },
  {
    id: "rec-privacy-hidden",
    description:
      "A PRIVATE episode (another scope) anchored to Sirius must NOT leak into a system-scope recall.",
    message: "Prépare la renégociation du bail avec Sirius Immobilier.",
    asUser: false,
    expectBlock: true,
    mustNotCite: (fx) => [ep(fx.episodes.privateBail)],
  },
  {
    id: "rec-privacy-visible",
    description:
      "The same private episode MUST surface for its owner (the eval user).",
    message: "Prépare la renégociation du bail avec Sirius Immobilier.",
    expectBlock: true,
    mustCite: (fx) => [ep(fx.episodes.privateBail)],
  },
  {
    id: "rec-followup-tail",
    description:
      "Ultra-short follow-up ('et pour la caution ?') — the recent tail carries the subject; recall must ride it.",
    message: "Et pour la caution ?",
    recentTail:
      "User: Regarde le bail Sirius et dis-moi le loyer mensuel\nAssistant: Le loyer est de 4 200 € HT par mois (bail Sirius Immobilier, locaux de Lyon).",
    expectBlock: true,
    mustCite: (fx) => [doc(fx.documents.bail)],
  },
  {
    id: "rec-typo-record",
    description:
      "Typo in the record name ('Norwind Gmbh') → trigram anchor still lands.",
    message: "Fais un point rapide sur Norwind Gmbh.",
    expectBlock: true,
    mustCite: (fx) => [rec(fx.records.nordwind)],
  },
  {
    id: "rec-crosslingual",
    description:
      "Message in ENGLISH about French-stored data — semantic bridging must still pull the (French) contract episode. Probes the no-language-heuristic claim: a weaker judge that keys on lexical overlap misses it.",
    message: "What did we agree on for the Nordwind supply contract?",
    expectBlock: true,
    mustCite: (fx) => [ep(fx.episodes.contract)],
  },
  {
    id: "rec-graph-link",
    description:
      "A relationship question — the answer lives in the graph EDGE (Nordwind → project Horizon via the 'fournit' link), not in any single record's text. Probes the graph arm's 1-hop traversal AND that the judge cites the NEIGHBOUR's id (Horizon), the record the agent would open next — not the anchor's.",
    message:
      "Sur quel projet interne est-ce qu'on travaille avec Nordwind GmbH ?",
    expectBlock: true,
    mustCite: (fx) => [rec(fx.records.horizon)],
  },
  {
    id: "rec-abstention-insufficient",
    description:
      "P8.1 abstention: the message shares vocabulary with the corpus ('fournisseurs') but asks for something no candidate holds (a password) — the semantic arm can drag the supplier-process memory, yet nothing genuinely answers it. The judge must abstain (NONE) rather than inject a topically-adjacent but useless block.",
    message: "Rappelle-moi le mot de passe du portail fournisseurs.",
    expectBlock: false,
    mustNotCite: (fx) => [mem(fx.memoryPaths.recapHebdo)],
  },
  {
    id: "rec-freshness-conflict",
    description:
      "P8.1 freshness/conflict: two dated episodes state Vega's delivery lead time (48h in March, 24h in June — the later supersedes). Asking the CURRENT lead time, recall must surface the recent value (24) as current — noting the change (`24h, was 48h`) is fine, presenting 48h as current is not. Probes that the `As of` dates now reach the judge and drive most-recent-wins.",
    message: "C'est quoi le délai de livraison actuel de Vega Logistics ?",
    expectBlock: true,
    mustCite: () => ["24"],
  },
  {
    id: "rec-workflow-outcome",
    description:
      "The capability axis: the user asks for the OUTCOME, never saying 'workflow' — the card of the workflow that already produces it must surface, so the assistant can offer to run it instead of doing the work by hand.",
    message:
      "Tu peux me sortir la liste des livraisons fournisseurs qui ont du retard ?",
    // `expectBlock` deliberately unasserted: the supplier-process memory is
    // topically adjacent without answering this, so both a block and NONE are
    // defensible. The capability is the axis under test.
    expectCapability: true,
    mustCiteCapability: (fx) => [wf(fx.workflows.lateDeliveries)],
  },
  {
    id: "rec-workflow-not-a-catch-all",
    description:
      "A workflow card must not answer everything it shares vocabulary with: a question about ONE supplier's identity is not a request to run the late-delivery recap. The card is deliberately worded around suppliers and deliveries, so this is the false positive the capability gate has to refuse.",
    message: "Fais-moi un point sur Nordwind GmbH.",
    expectBlock: true,
    expectCapability: false,
  },
];
