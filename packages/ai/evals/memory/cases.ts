/**
 * Memory-generation eval cases — the LLM calls of the unified-memory plan
 * other than recall. Each case runs the REAL service (with the bake-off's
 * `modelProfileKey` override) against the fixture universe and scores the
 * generated text deterministically; the runner also prints every output for
 * human quality analysis ("the text must be perfect", the chantier brief).
 *
 * Coverage:
 *  - distill-conversation (P4): faithful episode summary + right salient record;
 *  - distill-record-activity (P6): faithful rolling digest of an event log;
 *  - consolidate (P6): the MERGE / REVISE / NOOP judge, the most objective —
 *    a discrete action + non-lossy survivor;
 *  - extract-mentions (P3): honest entity recall over explicit / messy / noise;
 *  - extract-relations (P8.4): typed edges from asserted relations, non-
 *    destructive supersession, and no edge from mere co-occurrence — the two
 *    autonomous writers to team-shared stores, so their nets matter most;
 *  - promote-episodes (P8.5): durable facts lifted to semantic memory, one-off
 *    facts NOT over-generalized, and the Mem0 dedup gate holding.
 */

import db from "@fretik/shared/db";
import { consolidateEpisodes } from "../../src/services/memory/consolidate-episodes";
import { distillConversation } from "../../src/services/memory/distill-conversation";
import { distillRecordActivity } from "../../src/services/memory/distill-record-activity";
import { extractMentions } from "../../src/services/memory/extract-mentions";
import { extractRelations } from "../../src/services/memory/extract-relations";
import { promoteEpisodes } from "../../src/services/memory/promote-episodes";
import {
  learnedMemoriesFor,
  makeConsolidationCluster,
  makePromotionCluster,
  makeRelationScenario,
  type MemoryFixtures,
  SENSITIVE_API_KEY,
} from "./fixtures";

export type MemoryTask =
  | "distill-conversation"
  | "distill-record-activity"
  | "consolidate"
  | "extract-mentions"
  | "extract-relations"
  | "promote-episodes";

export interface MemoryCaseResult {
  /** Full generated text, printed for human analysis. */
  text: string;
  /** Empty = pass. */
  failures: string[];
}

export interface MemoryEvalCase {
  id: string;
  task: MemoryTask;
  description: string;
  run: (
    fx: MemoryFixtures,
    profileKey: string | undefined,
  ) => Promise<MemoryCaseResult>;
}

const scope = (fx: MemoryFixtures) => ({
  teamId: fx.teamId,
  organizationId: fx.organizationId,
});

/** Case-insensitive, accent-loose "does the text contain this fact". */
const has = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle.toLowerCase());

const requireAll = (
  text: string,
  needles: string[],
  failures: string[],
): void => {
  for (const n of needles) {
    if (!has(text, n)) failures.push(`missing "${n}"`);
  }
};

export const MEMORY_CASES: MemoryEvalCase[] = [
  {
    id: "mem-distill-conversation",
    task: "distill-conversation",
    description:
      "A negotiation conversation → the episode summary must capture the decisions and anchor on the right supplier record.",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const result = await distillConversation({
        conversationId: fx.conversationId,
        ...scope(fx),
        modelProfileKey: profileKey,
      });
      if (!result.distilled || !result.episodeId) {
        return { text: "(not distilled)", failures: ["not distilled"] };
      }
      const ep = await db.query.aiEpisodes.findFirst({
        where: { id: result.episodeId },
        with: { episodeRecords: { columns: { recordId: true } } },
      });
      if (!ep)
        return { text: "(episode vanished)", failures: ["no episode row"] };
      const salient = ep.episodeRecords.map((r) => r.recordId);
      // The decisions the summary must carry (final terms + open point + contact).
      requireAll(ep.summary, ["8", "30", "800", "Clara"], failures);
      if (!has(ep.summary, "juridique") && !has(ep.summary, "révision")) {
        failures.push("missing the open point (juridique/révision)");
      }
      if (!salient.includes(fx.records.meridian)) {
        failures.push("salient records omit Meridian");
      }
      if (ep.title.length === 0) failures.push("empty title");
      const text = `TITLE: ${ep.title}\nSALIENT: ${salient.length.toString()} record(s)\nSUMMARY:\n${ep.summary}`;
      return { text, failures };
    },
  },
  {
    id: "mem-distill-record-activity",
    task: "distill-record-activity",
    description:
      "A 6-event activity log → the digest must capture the progression and the notable values, without inventing anything.",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const result = await distillRecordActivity({
        recordId: fx.activityRecordId,
        ...scope(fx),
        modelProfileKey: profileKey,
      });
      if (!result.distilled || !result.episodeId) {
        return { text: "(not distilled)", failures: ["not distilled"] };
      }
      const ep = await db.query.aiEpisodes.findFirst({
        where: { id: result.episodeId },
        columns: { title: true, summary: true },
      });
      if (!ep)
        return { text: "(episode vanished)", failures: ["no episode row"] };
      // Notable values from the event payloads + the end state.
      requireAll(ep.summary, ["Yannis Roche", "128", "signé"], failures);
      const text = `TITLE: ${ep.title}\nSUMMARY:\n${ep.summary}`;
      return { text, failures };
    },
  },
  {
    id: "mem-consolidate-merge",
    task: "consolidate",
    description:
      "Two redundant retellings of the SAME concluded negotiation → MERGE, superseding both, losing no fact.",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const episodeIds = await makeConsolidationCluster(fx, "merge");
      const result = await consolidateEpisodes({
        episodeIds,
        ...scope(fx),
        modelProfileKey: profileKey,
      });
      if (result.action !== "MERGE") {
        failures.push(`action ${result.action}, expected MERGE`);
      }
      if ((result.supersededIds?.length ?? 0) !== 2) {
        failures.push(
          `superseded ${(result.supersededIds?.length ?? 0).toString()}, expected 2`,
        );
      }
      let summary = "";
      if (result.episodeId) {
        const ep = await db.query.aiEpisodes.findFirst({
          where: { id: result.episodeId },
          columns: { title: true, summary: true },
        });
        summary = ep ? `${ep.title}\n${ep.summary}` : "";
        requireAll(summary, ["8", "30", "800", "Clara"], failures);
      } else if (result.action !== "NOOP") {
        failures.push("no survivor episode");
      }
      return {
        text: `ACTION: ${result.action}\nSURVIVOR:\n${summary || "(none)"}`,
        failures,
      };
    },
  },
  {
    id: "mem-consolidate-revise",
    task: "consolidate",
    description:
      "An older episode (weekly delivery) contradicted by a newer one (monthly, option dropped) → REVISE, superseding only the outdated one.",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const episodeIds = await makeConsolidationCluster(fx, "revise");
      const [outdated] = episodeIds;
      const result = await consolidateEpisodes({
        episodeIds,
        ...scope(fx),
        modelProfileKey: profileKey,
      });
      if (result.action === "NOOP") {
        failures.push("action NOOP, expected REVISE (or MERGE)");
      }
      if (outdated && !(result.supersededIds ?? []).includes(outdated)) {
        failures.push(
          "the outdated (weekly-delivery) episode was not superseded",
        );
      }
      let summary = "";
      if (result.episodeId) {
        const ep = await db.query.aiEpisodes.findFirst({
          where: { id: result.episodeId },
          columns: { title: true, summary: true },
        });
        summary = ep ? `${ep.title}\n${ep.summary}` : "";
        // The corrected episode must state the WINNING fact (monthly).
        if (!has(summary, "mensuel")) {
          failures.push(
            "survivor does not state the corrected fact (mensuelle)",
          );
        }
      }
      return {
        text: `ACTION: ${result.action}\nSUPERSEDED: ${(result.supersededIds ?? []).length.toString()}\nSURVIVOR:\n${summary || "(none)"}`,
        failures,
      };
    },
  },
  {
    id: "mem-distill-sensitivity",
    task: "distill-conversation",
    description:
      "A conversation handing over a live API key → the stored episode never carries the secret value (P8.2: the `redactSecrets` net under the prompt guard). PII omission (the divorce aside) is a prompt-only best-effort on the utility model, printed for review but not asserted.",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const result = await distillConversation({
        conversationId: fx.sensitiveConversationId,
        ...scope(fx),
        modelProfileKey: profileKey,
      });
      if (!result.distilled || !result.episodeId) {
        return { text: "(not distilled)", failures: ["not distilled"] };
      }
      const ep = await db.query.aiEpisodes.findFirst({
        where: { id: result.episodeId },
        columns: { title: true, summary: true },
      });
      if (!ep)
        return { text: "(episode vanished)", failures: ["no episode row"] };
      const blob = `${ep.title}\n${ep.summary}`;
      // Check the key BODY (invariant to hyphen/space reformatting), not just
      // the ASCII form — the model rewrites `sk-live-…` with fancy hyphens.
      const keyBody = SENSITIVE_API_KEY.replace(/[^a-z0-9]/gi, "");
      const blobBody = blob.replace(/[^a-z0-9]/gi, "");
      if (blobBody.includes(keyBody) || has(blob, "sk-live")) {
        failures.push("LEAKED the API key into the summary");
      }
      const piiNote = has(blob, "divorce") ? " [note: PII aside kept]" : "";
      return {
        text: `TITLE: ${ep.title}${piiNote}\nSUMMARY:\n${ep.summary}`,
        failures,
      };
    },
  },
  {
    id: "mem-consolidate-reanchor",
    task: "consolidate",
    description:
      "An episode framing a delivery as still upcoming on a now-past date, plus a sibling stating it was delivered → REVISE, superseding the stale future-framed one (P8.2 temporal re-anchoring against <today>).",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const episodeIds = await makeConsolidationCluster(fx, "reanchor");
      const [stale] = episodeIds;
      const result = await consolidateEpisodes({
        episodeIds,
        ...scope(fx),
        modelProfileKey: profileKey,
      });
      if (result.action === "NOOP") {
        failures.push("action NOOP, expected REVISE (or MERGE)");
      }
      if (stale && !(result.supersededIds ?? []).includes(stale)) {
        failures.push("the stale future-dated episode was not superseded");
      }
      let summary = "";
      if (result.episodeId) {
        const ep = await db.query.aiEpisodes.findFirst({
          where: { id: result.episodeId },
          columns: { title: true, summary: true },
        });
        summary = ep ? `${ep.title}\n${ep.summary}` : "";
      }
      return {
        text: `ACTION: ${result.action}\nSUPERSEDED: ${(result.supersededIds ?? []).length.toString()}\nSURVIVOR:\n${summary || "(none)"}`,
        failures,
      };
    },
  },
  {
    id: "mem-consolidate-noop",
    task: "consolidate",
    description:
      "Two genuinely distinct matters that merely share a record (price negotiation vs record data-cleanup) → NOOP.",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const episodeIds = await makeConsolidationCluster(fx, "noop");
      const result = await consolidateEpisodes({
        episodeIds,
        ...scope(fx),
        modelProfileKey: profileKey,
      });
      if (result.action !== "NOOP") {
        failures.push(`action ${result.action}, expected NOOP`);
      }
      return { text: `ACTION: ${result.action}`, failures };
    },
  },
  {
    id: "mem-extract-explicit",
    task: "extract-mentions",
    description:
      "Text naming two records explicitly → both surfaced as mentions.",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const mentions = await extractMentions({
        text: "Compte-rendu : on a bien avancé avec Meridian Textiles sur les tarifs 2027, et Volta Energie doit nous renvoyer son devis signé cette semaine.",
        teamId: fx.teamId,
        modelProfileKey: profileKey,
      });
      const labels = mentions.map((m) => m.label.toLowerCase());
      if (!labels.some((l) => l.includes("meridian"))) {
        failures.push("Meridian not extracted");
      }
      if (!labels.some((l) => l.includes("volta"))) {
        failures.push("Volta not extracted");
      }
      return {
        text: mentions
          .map((m) => `- ${m.label} (conf ${m.confidence.toFixed(2)})`)
          .join("\n"),
        failures,
      };
    },
  },
  {
    id: "mem-extract-messy",
    task: "extract-mentions",
    description:
      "Lowercase + typo'd names → still surfaced (the funnel matches downstream; the extractor must recall them).",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const mentions = await extractMentions({
        text: "note perso: relancer meridian textils pour le contrat, et caler un point avec volta energie sur l'audit",
        teamId: fx.teamId,
        modelProfileKey: profileKey,
      });
      const labels = mentions.map((m) => m.label.toLowerCase());
      if (!labels.some((l) => l.includes("meridian"))) {
        failures.push("meridian (typo) not extracted");
      }
      if (!labels.some((l) => l.includes("volta"))) {
        failures.push("volta not extracted");
      }
      return {
        text: mentions
          .map((m) => `- ${m.label} (conf ${m.confidence.toFixed(2)})`)
          .join("\n"),
        failures,
      };
    },
  },
  {
    id: "mem-extract-noise",
    task: "extract-mentions",
    description:
      "A generic how-to question with no named entity → no mention (no hallucinated entities).",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const mentions = await extractMentions({
        text: "Quelle est la formule pour calculer la marge brute d'une commande ?",
        teamId: fx.teamId,
        modelProfileKey: profileKey,
      });
      const labels = mentions.map((m) => m.label.toLowerCase());
      if (labels.some((l) => l.includes("meridian") || l.includes("volta"))) {
        failures.push("hallucinated a fixture entity on noise");
      }
      if (mentions.length > 1) {
        failures.push(
          `${mentions.length.toString()} mentions on pure noise (>1)`,
        );
      }
      return {
        text:
          mentions.length === 0
            ? "(no mentions — correct)"
            : mentions.map((m) => `- ${m.label}`).join("\n"),
        failures,
      };
    },
  },
  {
    id: "mem-relation-explicit",
    task: "extract-relations",
    description:
      "A text explicitly asserting a supplier relationship between two records → at least one canonical typed edge between them (direction/predicate free; the trust band is printed, not asserted). Runs on the utility model (gpt-oss-20b).",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const { text, recordIds } = await makeRelationScenario(fx, "explicit");
      const [a, b] = recordIds;
      const r = await extractRelations({
        text,
        recordIds,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        modelProfileKey: profileKey,
      });
      if (r.created < 1) {
        failures.push(`created ${r.created.toString()} edges, expected ≥1`);
      }
      const edges = await db.query.links.findMany({
        where: {
          teamId: fx.teamId,
          source: "ai_inference",
          invalidatedAt: { isNull: true },
          OR: [
            { fromRecordId: a, toRecordId: b },
            { fromRecordId: b, toRecordId: a },
          ],
        },
        columns: { status: true, confidence: true },
        with: { linkType: { columns: { key: true } } },
      });
      if (edges.length === 0) {
        failures.push("no active ai_inference edge between the two records");
      }
      if (edges.length > 2) {
        failures.push(
          `predicate sprawl: ${edges.length.toString()} edges for one pair`,
        );
      }
      const desc = edges
        .map(
          (e) =>
            `${e.linkType?.key ?? "?"} [${e.status}] conf ${e.confidence ?? "?"}`,
        )
        .join(", ");
      return {
        text: `created=${r.created.toString()} suggested=${r.suggested.toString()}\nEDGES: ${desc || "(none)"}`,
        failures,
      };
    },
  },
  {
    id: "mem-relation-supersession",
    task: "extract-relations",
    description:
      "A text moving a subsidiary from one parent to another, against a seeded active edge → a NEW edge plus non-destructive invalidation of the stale one (invalidatedAt + invalidatedByLinkId set). The critical stale-edge guard, on gpt-oss-20b.",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const { text, recordIds, seededLinkId } = await makeRelationScenario(
        fx,
        "supersession",
      );
      if (!seededLinkId) {
        return { text: "(seed failed)", failures: ["seed link not created"] };
      }
      const r = await extractRelations({
        text,
        recordIds,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        modelProfileKey: profileKey,
      });
      if (r.created < 1) {
        failures.push(`created ${r.created.toString()} edges, expected ≥1 new`);
      }
      if (r.invalidated < 1) {
        failures.push(
          `invalidated ${r.invalidated.toString()}, expected the stale edge superseded`,
        );
      }
      const seed = await db.query.links.findFirst({
        where: { id: seededLinkId },
        columns: { invalidatedAt: true, invalidatedByLinkId: true },
      });
      if (!seed?.invalidatedAt) {
        failures.push("seeded edge not invalidated (invalidatedAt null)");
      }
      if (!seed?.invalidatedByLinkId) {
        failures.push(
          "seeded edge has no invalidatedByLinkId (not pointed at its replacement)",
        );
      }
      return {
        text: `created=${r.created.toString()} invalidated=${r.invalidated.toString()}\nseed.invalidatedAt=${seed?.invalidatedAt ? "set" : "null"} invalidatedBy=${seed?.invalidatedByLinkId ? "set" : "null"}`,
        failures,
      };
    },
  },
  {
    id: "mem-relation-noise",
    task: "extract-relations",
    description:
      "Two records co-mentioned in one note but with NO relation asserted between them → zero edges (no hallucination from co-occurrence). On gpt-oss-20b.",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const { text, recordIds } = await makeRelationScenario(fx, "noise");
      const r = await extractRelations({
        text,
        recordIds,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        modelProfileKey: profileKey,
      });
      if (r.created !== 0) {
        failures.push(
          `created ${r.created.toString()} edge(s) from co-occurrence (expected 0)`,
        );
      }
      return {
        text: `created=${r.created.toString()} suggested=${r.suggested.toString()}`,
        failures,
      };
    },
  },
  {
    id: "mem-promote-durable",
    task: "promote-episodes",
    description:
      "Three episodes across different conversations restating the same standing supplier convention (signed PO before shipping) → one generalized `learned/` semantic memory, carrying episode provenance. On the consolidation model (gpt-oss-120b).",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const { episodeIds } = await makePromotionCluster(fx, "durable");
      const r = await promoteEpisodes({
        episodeIds,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        modelProfileKey: profileKey,
      });
      if (r.added < 1) {
        failures.push(
          `added ${r.added.toString()}, expected ≥1 learned memory`,
        );
      }
      const learned = await learnedMemoriesFor(fx.teamId);
      if (learned.length === 0) {
        failures.push("no learned/ memory written");
      } else if (
        !learned.some((m) => m.content.includes("Sources: episode:"))
      ) {
        failures.push("learned memory missing 'Sources: episode:' provenance");
      }
      const dump = learned
        .map(
          (m) =>
            `- ${m.path}:\n    ${m.content.slice(0, 240).replace(/\n/g, "\n    ")}`,
        )
        .join("\n");
      return {
        text: `added=${r.added.toString()} updated=${r.updated.toString()} noop=${r.noop.toString()}\n${dump || "(no learned memory)"}`,
        failures,
      };
    },
  },
  {
    id: "mem-promote-oneoff",
    task: "promote-episodes",
    description:
      "Two episodes of unrelated one-off facts (an invoice payment, a record data fix) with no durable pattern → NOOP, nothing promoted (the over-generalization guard). On gpt-oss-120b.",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const { episodeIds } = await makePromotionCluster(fx, "oneoff");
      const r = await promoteEpisodes({
        episodeIds,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        modelProfileKey: profileKey,
      });
      if (r.added !== 0 || r.updated !== 0) {
        failures.push(
          `promoted a one-off fact (added ${r.added.toString()}, updated ${r.updated.toString()}) — expected NOOP`,
        );
      }
      const learned = await learnedMemoriesFor(fx.teamId);
      if (learned.length !== 0) {
        failures.push(
          `${learned.length.toString()} learned memory written on one-off facts`,
        );
      }
      return {
        text:
          `added=${r.added.toString()} updated=${r.updated.toString()} noop=${r.noop.toString()}` +
          (learned.length
            ? `\nLEAKED: ${learned.map((m) => m.path).join(", ")}`
            : ""),
        failures,
      };
    },
  },
  {
    id: "mem-promote-dedup",
    task: "promote-episodes",
    description:
      "The durable convention is ALREADY stored as a learned memory → the Mem0-style gate must NOOP or UPDATE in place, never add a second copy. Idempotence of promotion. On gpt-oss-120b.",
    run: async (fx, profileKey) => {
      const failures: string[] = [];
      const { episodeIds, seededMemoryPath } = await makePromotionCluster(
        fx,
        "dedup",
      );
      const r = await promoteEpisodes({
        episodeIds,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        modelProfileKey: profileKey,
      });
      if (r.added !== 0) {
        failures.push(
          `added ${r.added.toString()} — the gate duplicated instead of NOOP/UPDATE`,
        );
      }
      const learned = await learnedMemoriesFor(fx.teamId);
      if (learned.length !== 1) {
        failures.push(
          `${learned.length.toString()} learned memories (expected exactly 1 — the seeded one, possibly updated in place)`,
        );
      }
      return {
        text: `added=${r.added.toString()} updated=${r.updated.toString()} noop=${r.noop.toString()}\nseeded=${seededMemoryPath ?? "?"}\nfinal: ${learned.map((m) => m.path).join(", ") || "(none)"}`,
        failures,
      };
    },
  },
];
