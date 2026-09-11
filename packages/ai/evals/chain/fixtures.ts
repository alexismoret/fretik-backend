/**
 * Chain-eval fixtures — a universe owned by THIS suite, deliberately disjoint
 * from `evals/memory` and `evals/recall` (own collection, own labels), so a
 * chain run never decides a case in another suite.
 *
 * Same isolation trap as the memory suite: these rows live in the shared eval
 * team, so run `bun run evals:chain -- --cleanup` before a recall run.
 *
 * Everything is seeded through REAL writes (conversations with `ai_messages`
 * and a `chat.turn` carrying resolved record links, episodes through
 * `upsertEpisode`) — the point of this suite is that the production pipeline
 * runs end to end, so a fixture that shortcut a stage would defeat it.
 */

import db from "@fretik/shared/db";
import {
  aiConversationMembers,
  aiConversations,
  aiEpisodes,
  aiMemories,
  aiMessages,
} from "@fretik/shared/db/schema";
import { deleteMemoryVectorsBulk } from "@fretik/shared/services/ai-memory/vector-refresh";
import { bulkDeleteCollectionRecords } from "@fretik/shared/services/collection-records/bulk-delete";
import { deleteRecordCardVectors } from "@fretik/shared/services/collection-records/card-vectors";
import { createCollectionRecord } from "@fretik/shared/services/collection-records/create";
import { createCollectionWithFields } from "@fretik/shared/services/collections/create-with-fields";
import { deleteCollection } from "@fretik/shared/services/collections/delete";
import { emitDomainEventsBulk } from "@fretik/shared/services/domain-events/emit-bulk";
import { upsertEpisode } from "@fretik/shared/services/episodes/upsert";
import { deleteEpisodeVectors } from "@fretik/shared/services/episodes/vectors";
import { inArray } from "drizzle-orm";

export interface ChainScope {
  organizationId: string;
  teamId: string;
  userId: string;
}

export interface ChainFixtures extends ChainScope {
  /** The supplier every chain case revolves around. */
  calliopeId: string;
  /** Conversation whose DECISION must survive distill → recall. */
  decisionConversationId: string;
}

const TYPE_KEY = "chain_eval_supplier";
const RECORD_LABEL = "Calliope Verre";
const CONVERSATION_TITLE = "[chain-eval] négociation Calliope Verre";

const ensureType = async (scope: ChainScope): Promise<string> => {
  const existing = await db.query.collections.findFirst({
    where: { teamId: scope.teamId, key: TYPE_KEY },
    columns: { id: true },
  });
  if (existing) return existing.id;
  const created = await createCollectionWithFields({
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    key: TYPE_KEY,
    label: "Fournisseur (chain-eval)",
    description: "Fixture du chain-eval — ne pas utiliser.",
    fields: [
      { label: "Nom", type: "text", isTitle: true },
      { label: "Secteur", type: "text", vectorizeInclude: true },
    ],
  });
  return created.id;
};

const ensureRecord = async (
  scope: ChainScope,
  collectionId: string,
): Promise<string> => {
  const existing = await db.query.collectionRecords.findFirst({
    where: { teamId: scope.teamId, collectionId, label: RECORD_LABEL },
    columns: { id: true },
  });
  if (existing) return existing.id;
  const created = await createCollectionRecord({
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    collectionId,
    data: { nom: RECORD_LABEL, secteur: "verrerie industrielle" },
    labelOverride: RECORD_LABEL,
    status: "confirmed",
  });
  return created.id;
};

/**
 * A real conversation whose substance is ONE decision. Distill has to carry it
 * into the episode, and recall has to bring it back for a question that never
 * repeats its wording — the whole chain in one case.
 */
const ensureDecisionConversation = async (
  scope: ChainScope,
  recordId: string,
): Promise<string> => {
  const existing = await db.query.aiConversations.findFirst({
    where: { teamId: scope.teamId, title: CONVERSATION_TITLE },
    columns: { id: true },
  });
  if (existing) return existing.id;

  const [conv] = await db
    .insert(aiConversations)
    .values({
      organizationId: scope.organizationId,
      teamId: scope.teamId,
      userId: scope.userId,
      title: CONVERSATION_TITLE,
    })
    .returning({ id: aiConversations.id });
  if (!conv) throw new Error("chain conversation insert failed");

  // One member → the distiller writes a PRIVATE episode owned by that user,
  // and the recall stage below runs in the same user's scope, so it is visible.
  // Team visibility would need a second real member; it is not what this suite
  // measures, and `evals/recall` already covers the privacy rule on both sides.
  await db.insert(aiConversationMembers).values({
    conversationId: conv.id,
    userId: scope.userId,
    role: "owner",
  });

  const turns: { role: "user" | "assistant"; text: string }[] = [
    {
      role: "user",
      text: "Où on en est avec Calliope Verre sur les conditions de règlement ?",
    },
    {
      role: "assistant",
      text: "Ils sont partis sur 60 jours fin de mois. Notre standard interne est 30 jours net.",
    },
    {
      role: "user",
      text: "On ne bouge pas : 30 jours net, sinon on ne signe pas. Et on garde la remise volume à 4 %.",
    },
    {
      role: "assistant",
      text: "Acté : règlement à 30 jours net, remise volume 4 %, position ferme sur le délai. Reste à faire valider la clause de pénalité de retard par le juridique.",
    },
  ];
  const now = Date.now();
  await db.insert(aiMessages).values(
    turns.map((t, i) => ({
      conversationId: conv.id,
      authorId: t.role === "user" ? scope.userId : null,
      role: t.role,
      parts: [{ type: "text" as const, text: t.text }],
      createdAt: new Date(now - (turns.length - i) * 60_000),
    })),
  );

  // The journal event the resolver would have written — it is what gives the
  // distiller its candidate record list.
  await emitDomainEventsBulk({
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    actor: {
      actorType: "user",
      actorUserId: scope.userId,
      conversationId: conv.id,
    },
    events: [
      {
        type: "chat.turn",
        payload: { userMessagePreview: turns[0]?.text ?? "" },
        dedupKey: `chain_eval.chatturn:${conv.id}`,
        recordLinks: [{ recordId, role: "mentioned" }],
      },
    ],
  });

  return conv.id;
};

const seedEpisode = async (
  scope: ChainScope,
  recordId: string,
  title: string,
  summary: string,
  daysAgo: number,
): Promise<string> => {
  const occurred = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const { episode } = await upsertEpisode({
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    userId: null,
    kind: "conversation",
    title,
    summary,
    occurredFrom: occurred,
    occurredTo: occurred,
    recordIds: [recordId],
  });
  return episode.id;
};

export const ensureChainFixtures = async (
  scope: ChainScope,
): Promise<ChainFixtures> => {
  const typeId = await ensureType(scope);
  const calliopeId = await ensureRecord(scope, typeId);
  const decisionConversationId = await ensureDecisionConversation(
    scope,
    calliopeId,
  );

  return { ...scope, calliopeId, decisionConversationId };
};

/**
 * The stages under test CONSUME their inputs — consolidation supersedes its
 * members, promotion writes a `learned/` memory that makes the next repeat
 * NOOP on its own dedup gate. So the destructive cases rebuild their cluster
 * per repeat, exactly like `makeConsolidationCluster` in the memory suite.
 * Titles carry a nonce so a rebuild is a NEW episode rather than an upsert.
 */
let nonce = 0;

/**
 * Wipe every episode anchored on the fixture record before a case rebuilds its
 * cluster.
 *
 * Without this the suite degrades itself: each repeat adds episodes and never
 * removes them, and after four runs the record carried 194 ACTIVE episodes with
 * one of them recalled 67 times (measured 2026-08-04). The graph arm keeps
 * `MAX_EPISODES` = 3, ranked on `updatedAt + recallCount × 1 day`, so a
 * much-recalled leftover sits ~67 days ahead of a survivor written two seconds
 * ago and takes its slot. Three of ten repeats failed that way, attributed to
 * `recall`, and none of it was a product defect.
 */
const clearAnchoredEpisodes = async (fx: ChainFixtures): Promise<void> => {
  const edges = await db.query.aiEpisodeRecords.findMany({
    where: { recordId: fx.calliopeId },
    columns: { episodeId: true },
  });
  const ids = [...new Set(edges.map((e) => e.episodeId))];
  if (ids.length === 0) return;
  await deleteEpisodeVectors(ids);
  await db.delete(aiEpisodes).where(inArray(aiEpisodes.id, ids));
};
const freshEpisode = (
  fx: ChainFixtures,
  title: string,
  summary: string,
  daysAgo: number,
): Promise<string> =>
  seedEpisode(
    fx,
    fx.calliopeId,
    `[chain-eval] ${title} #${(++nonce).toString()}`,
    summary,
    daysAgo,
  );

/** Two episodes stating an incompatible production lead time; the later wins. */
export const makeContradictionPair = async (
  fx: ChainFixtures,
): Promise<{ staleId: string; freshId: string }> => {
  await clearAnchoredEpisodes(fx);
  return {
    staleId: await freshEpisode(
      fx,
      "Délai de production Calliope",
      "Calliope Verre annonce un délai de production de 8 semaines pour les séries spéciales.",
      120,
    ),
    freshId: await freshEpisode(
      fx,
      "Délai de production Calliope revu",
      "Calliope Verre a ouvert une seconde ligne : le délai de production des séries spéciales passe à 3 semaines.",
      5,
    ),
  };
};

/** Purge whatever a previous repeat promoted, so the dedup gate starts clean. */
const clearLearned = async (fx: ChainFixtures): Promise<void> => {
  const rows = await db.query.aiMemories.findMany({
    where: { teamId: fx.teamId, path: { like: "learned/%" } },
    columns: { id: true, content: true },
  });
  const ids = rows
    .filter((m) => m.content.includes("Calliope"))
    .map((m) => m.id);
  if (ids.length === 0) return;
  await deleteMemoryVectorsBulk(ids);
  await db.delete(aiMemories).where(inArray(aiMemories.id, ids));
};

/** One convention restated three times — the recurrence promotion looks for. */
export const makeConventionCluster = async (
  fx: ChainFixtures,
): Promise<string[]> => {
  await clearAnchoredEpisodes(fx);
  await clearLearned(fx);
  const texts = [
    "Commande passée à Calliope Verre : le bon de commande a été envoyé en double exemplaire signé, comme pour chaque commande.",
    "Nouvelle commande Calliope Verre : envoi du bon de commande en double exemplaire signé, procédure habituelle de l'équipe achats.",
    "Commande de rattrapage Calliope Verre : bon de commande émis en double exemplaire signé, conformément à la règle interne.",
  ];
  const ids: string[] = [];
  for (const [i, text] of texts.entries()) {
    ids.push(await freshEpisode(fx, "Commande Calliope", text, 30 - i * 5));
  }
  return ids;
};

/**
 * Block until a promoted memory is actually RETRIEVABLE.
 *
 * `createMemory` / `overwriteMemory` fire their vector refresh and return
 * (`void triggerMemoryVectorRefresh(...)`) — correct for the user-facing write,
 * which must never block or roll back on an embedding call, but it means the
 * row exists before the vector does. Without this wait the chain cases measure
 * that race instead of the chain: 2/5 and 4/5 on a fully deterministic
 * pipeline, purely on whether the embedding landed first (2026-08-04).
 */
export const waitForMemoryVectors = async (
  teamId: string,
  contains: string,
  timeoutMs = 20_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.query.aiMemories.findMany({
      where: { teamId, path: { like: "learned/%" } },
      columns: { id: true, content: true },
    });
    const ids = rows
      .filter((m) => m.content.includes(contains))
      .map((m) => m.id);
    if (ids.length > 0) {
      const vectors = await db.query.aiVectors.findMany({
        where: { sourceType: "memories", sourceId: { in: ids } },
        columns: { id: true },
        limit: 1,
      });
      if (vectors.length > 0) return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

/** Two unrelated one-offs about the same entity — no rule hides in them. */
export const makeOneOffCluster = async (
  fx: ChainFixtures,
): Promise<string[]> => {
  await clearAnchoredEpisodes(fx);
  await clearLearned(fx);
  const texts = [
    "La facture CV-2291 de Calliope Verre a été payée le 12 du mois.",
    "Correction d'une faute de frappe dans l'adresse de livraison de Calliope Verre.",
  ];
  const ids: string[] = [];
  for (const [i, text] of texts.entries()) {
    ids.push(await freshEpisode(fx, "Ponctuel Calliope", text, 20 - i * 3));
  }
  return ids;
};

/**
 * Tear the universe down — including anything the PIPELINE wrote during a run
 * (distilled episodes, consolidation survivors, promoted `learned/` memories).
 * Those carry no fixture marker of their own, so they are caught by their
 * conversation, their anchored record, or their content.
 */
export const cleanupChainFixtures = async (
  scope: ChainScope,
): Promise<void> => {
  const convIds = (
    await db.query.aiConversations.findMany({
      where: { teamId: scope.teamId, title: CONVERSATION_TITLE },
      columns: { id: true },
    })
  ).map((c) => c.id);

  const type = await db.query.collections.findFirst({
    where: { teamId: scope.teamId, key: TYPE_KEY },
    columns: { id: true },
  });
  const recIds = type
    ? (
        await db.query.collectionRecords.findMany({
          where: { teamId: scope.teamId, collectionId: type.id },
          columns: { id: true },
        })
      ).map((r) => r.id)
    : [];

  // Seeded episodes carry the marker; pipeline-written ones are reachable
  // through the conversation they distilled or the record they anchor.
  const anchored =
    recIds.length > 0
      ? (
          await db.query.aiEpisodeRecords.findMany({
            where: { recordId: { in: recIds } },
            columns: { episodeId: true },
          })
        ).map((e) => e.episodeId)
      : [];
  const all = await db.query.aiEpisodes.findMany({
    where: { teamId: scope.teamId },
    columns: { id: true, title: true, conversationId: true },
  });
  const episodeIds = [
    ...new Set(
      all
        .filter(
          (e) =>
            e.title.startsWith("[chain-eval]") ||
            anchored.includes(e.id) ||
            (e.conversationId !== null && convIds.includes(e.conversationId)),
        )
        .map((e) => e.id),
    ),
  ];
  if (episodeIds.length > 0) {
    await deleteEpisodeVectors(episodeIds);
    await db.delete(aiEpisodes).where(inArray(aiEpisodes.id, episodeIds));
  }
  if (convIds.length > 0) {
    await db
      .delete(aiConversations)
      .where(inArray(aiConversations.id, convIds));
  }

  // Promotions this suite's episodes may have produced.
  const learned = await db.query.aiMemories.findMany({
    where: { teamId: scope.teamId, path: { like: "learned/%" } },
    columns: { id: true, content: true },
  });
  const stale = learned
    .filter((m) => m.content.includes(RECORD_LABEL.split(" ")[0] ?? ""))
    .map((m) => m.id);
  if (stale.length > 0) {
    await deleteMemoryVectorsBulk(stale);
    await db.delete(aiMemories).where(inArray(aiMemories.id, stale));
  }

  if (recIds.length > 0) {
    for (const id of recIds) await deleteRecordCardVectors(id);
    await bulkDeleteCollectionRecords({ teamId: scope.teamId, ids: recIds });
  }
  if (type) {
    await deleteCollection({ id: type.id });
  }
};
