/**
 * Deterministic fixture universe for the memory-generation eval — the LLM
 * calls of the unified-memory plan OTHER than recall: conversation
 * distillation (P4), record-activity digests (P6), the consolidation judge
 * (P6), and mention extraction (P3).
 *
 * Seeded through the REAL rows the services read: records via
 * `createCollectionRecord`, a conversation via `ai_conversations` + `ai_messages`
 * + a linked `chat.turn` journal event (so the distiller's candidate-record
 * query behaves as in prod), an activity record with a real event log, and
 * episode clusters via `upsertEpisode`.
 *
 * Idempotent for the reusable rows (type/records/conversation/activity —
 * natural keys). The consolidation clusters are RE-CREATED every run
 * (`resetConsolidationClusters`): a run supersedes them, so reusing stale
 * pairs would make the next run judge already-superseded episodes. Everything
 * is greppable (`Meridian`, `Volta`, `memory_eval_`) and torn down by
 * `cleanupMemoryFixtures` (`--cleanup`).
 */

import db from "@fretik/shared/db";
import {
  aiConversationMembers,
  aiConversations,
  aiEpisodes,
  aiMemories,
  aiMemoryHistory,
  aiMessages,
  aiVectors,
  domainEvents,
  links,
} from "@fretik/shared/db/schema";
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { deleteMemoryVectors } from "@fretik/shared/services/ai-memory/vector-refresh";
import { getTeamBotUserId } from "@fretik/shared/services/auth/bot-user";
import { bulkDeleteCollectionRecords } from "@fretik/shared/services/collection-records/bulk-delete";
import { deleteRecordCardVectors } from "@fretik/shared/services/collection-records/card-vectors";
import { createCollectionRecord } from "@fretik/shared/services/collection-records/create";
import { createCollectionWithFields } from "@fretik/shared/services/collections/create-with-fields";
import { deleteCollection } from "@fretik/shared/services/collections/delete";
import { emitDomainEventsBulk } from "@fretik/shared/services/domain-events/emit-bulk";
import { upsertEpisode } from "@fretik/shared/services/episodes/upsert";
import { deleteEpisodeVectors } from "@fretik/shared/services/episodes/vectors";
import { resolveLinkType } from "@fretik/shared/services/link-types/match";
import { bulkCreateLinks } from "@fretik/shared/services/links/bulk-create";
import { and, eq, inArray, like, or } from "drizzle-orm";

const TYPE_KEY = "memory_eval_supplier";
const CONVERSATION_TITLE = "[memory_eval] Négociation Meridian Textiles";
const SENSITIVE_CONVERSATION_TITLE =
  "[memory_eval] Configuration intégration paiement";
/** The secret the sensitivity guard must keep OUT of the summary. */
export const SENSITIVE_API_KEY = "sk-live-9f8a7b6c5d4e3f2a1b0c";

interface Scope {
  organizationId: string;
  teamId: string;
  userId: string;
}

export interface MemoryFixtures {
  organizationId: string;
  teamId: string;
  userId: string;
  /** Fixture collection — the relation endpoints all share it (company↔company). */
  typeId: string;
  records: { meridian: string; volta: string; northwind: string };
  /** Distillable conversation (kind `conversation` episode). */
  conversationId: string;
  /** Conversation carrying a secret + a personal aside — the sensitivity guard. */
  sensitiveConversationId: string;
  /** Busy record for the activity digest. */
  activityRecordId: string;
}

export type ClusterKind = "merge" | "revise" | "noop" | "reanchor";
/** Relation-extraction (P8.4) scenarios: a stated relation, a supersession, pure noise. */
export type RelationKind = "explicit" | "supersession" | "noise";
/** Episode-promotion (P8.5) scenarios: a durable convention, one-off facts, a duplicate. */
export type PromotionKind = "durable" | "oneoff" | "dedup";

const findTypeId = async (scope: Scope): Promise<string | null> => {
  const row = await db.query.collections.findFirst({
    where: { teamId: scope.teamId, key: TYPE_KEY },
    columns: { id: true },
  });
  return row?.id ?? null;
};

const ensureType = async (scope: Scope): Promise<string> => {
  const existing = await findTypeId(scope);
  if (existing) return existing;
  const created = await createCollectionWithFields({
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    key: TYPE_KEY,
    label: "Fournisseur (memory-eval)",
    description: "Fixture du memory-eval — ne pas utiliser.",
    fields: [
      { label: "Nom", type: "text", isTitle: true },
      {
        label: "Secteur",
        type: "text",
        vectorizeInclude: true,
        description: "Fixture memory-eval.",
      },
    ],
  });
  return created.id;
};

const ensureRecord = async (
  scope: Scope,
  collectionId: string,
  label: string,
  secteur: string,
): Promise<string> => {
  const existing = await db.query.collectionRecords.findFirst({
    where: { teamId: scope.teamId, collectionId, label },
    columns: { id: true },
  });
  if (existing) return existing.id;
  const record = await createCollectionRecord({
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    collectionId,
    data: { nom: label, secteur },
    labelOverride: label,
    status: "confirmed",
  });
  return record.id;
};

/** The distillable conversation + its candidate-record journal link. */
const ensureConversation = async (
  scope: Scope,
  meridianId: string,
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
  if (!conv) throw new Error("conversation insert failed");

  await db.insert(aiConversationMembers).values({
    conversationId: conv.id,
    userId: scope.userId,
    role: "owner",
  });

  const turns: { role: "user" | "assistant"; text: string }[] = [
    {
      role: "user",
      text: "On doit boucler la négo avec Meridian Textiles pour les commandes 2027. Ils proposent quoi ?",
    },
    {
      role: "assistant",
      text: "Meridian propose une remise de 6 % à partir de 800 unités par trimestre, livraison mensuelle, paiement à 45 jours.",
    },
    {
      role: "user",
      text: "45 jours c'est trop long, on a toujours été à 30. Et je veux 8 % de remise, pas 6.",
    },
    {
      role: "assistant",
      text: "Compris. Je note la contre-proposition : 8 % de remise, paiement ramené à 30 jours, volume minimum maintenu à 800 unités/trimestre.",
    },
    {
      role: "user",
      text: "Parfait. La clause de révision annuelle des prix reste un point ouvert, à faire valider par le juridique. Relance leur contact, Clara Meunier, avant vendredi.",
    },
    {
      role: "assistant",
      text: "C'est acté : contre-proposition 8 % / 30 jours / 800 unités, clause de révision annuelle à valider par le juridique, et relance de Clara Meunier avant vendredi.",
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

  // The chat.turn journal event carrying Meridian as a resolved candidate —
  // exactly what the resolver would have written, so the distiller finds it.
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
        dedupKey: `memory_eval.chatturn:${conv.id}`,
        recordLinks: [{ recordId: meridianId, role: "mentioned" }],
      },
    ],
  });

  return conv.id;
};

/**
 * A single-member conversation carrying a live secret (API key) and an
 * unrelated personal aside — the distiller must summarise the WORK and drop
 * both. No candidate-record link needed.
 */
const ensureSensitiveConversation = async (scope: Scope): Promise<string> => {
  const existing = await db.query.aiConversations.findFirst({
    where: { teamId: scope.teamId, title: SENSITIVE_CONVERSATION_TITLE },
    columns: { id: true },
  });
  if (existing) return existing.id;

  const [conv] = await db
    .insert(aiConversations)
    .values({
      organizationId: scope.organizationId,
      teamId: scope.teamId,
      userId: scope.userId,
      title: SENSITIVE_CONVERSATION_TITLE,
    })
    .returning({ id: aiConversations.id });
  if (!conv) throw new Error("sensitive conversation insert failed");

  await db.insert(aiConversationMembers).values({
    conversationId: conv.id,
    userId: scope.userId,
    role: "owner",
  });

  const turns: { role: "user" | "assistant"; text: string }[] = [
    {
      role: "user",
      text: `J'ai branché l'intégration de paiement Stripe sur le portail. La clé API live est ${SENSITIVE_API_KEY}, garde-la sous la main.`,
    },
    {
      role: "assistant",
      text: "L'intégration de paiement Stripe est configurée sur le portail. Je note que la clé API live a été fournie et enregistrée côté configuration.",
    },
    {
      role: "user",
      text: "Au passage, entre nous : je traverse un divorce compliqué en ce moment, donc je serai moins réactif cette semaine.",
    },
    {
      role: "assistant",
      text: "Pas de souci, on avancera à ton rythme. Pour la suite, il reste à tester un paiement de bout en bout avant la mise en production.",
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
  return conv.id;
};

/** A record with a ≥5-event log for the activity digest. */
const ensureActivityRecord = async (
  scope: Scope,
  collectionId: string,
): Promise<string> => {
  const recordId = await ensureRecord(
    scope,
    collectionId,
    "Volta Energie",
    "énergie renouvelable",
  );
  // Idempotent by dedupKey — re-runs don't stack events.
  await emitDomainEventsBulk({
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    actor: { actorType: "user", actorUserId: scope.userId },
    events: [
      { statut: "prospect qualifié" },
      { contact: "Yannis Roche" },
      { secteur: "énergie renouvelable — solaire" },
      { statut: "devis envoyé" },
      { montant: "128 000 €" },
      { statut: "devis signé" },
    ].map((changes, i) => ({
      type: "record.updated" as const,
      subjectRecordId: recordId,
      payload: { changes },
      dedupKey: `memory_eval.activity:${recordId}:${i.toString()}`,
    })),
  });
  return recordId;
};

const makeEpisode = async (
  scope: { organizationId: string; teamId: string },
  title: string,
  summary: string,
  recordId: string,
): Promise<string> => {
  const { episode } = await upsertEpisode({
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    userId: null,
    kind: "conversation",
    title,
    summary,
    occurredFrom: new Date("2026-06-15T09:00:00Z"),
    occurredTo: new Date("2026-06-15T10:00:00Z"),
    recordIds: [recordId],
    metadata: { memoryEvalCluster: true },
  });
  return episode.id;
};

/**
 * Build ONE judge cluster fresh. Called inside each consolidate repeat
 * (consolidation supersedes its members, so a repeat needs a new pair).
 * MERGE = one matter told twice; REVISE = an older episode the newer one
 * corrects (the outdated one is `[0]`); NOOP = two distinct matters that
 * merely share a record.
 */
export const makeConsolidationCluster = async (
  fx: MemoryFixtures,
  kind: ClusterKind,
): Promise<string[]> => {
  const scope = { organizationId: fx.organizationId, teamId: fx.teamId };
  const meridianId = fx.records.meridian;
  if (kind === "merge") {
    // Two REDUNDANT retellings of the SAME concluded negotiation.
    return [
      await makeEpisode(
        scope,
        "[memory_eval] Meridian — récapitulatif de la négociation 2027",
        "Récapitulatif de la négociation 2027 avec Meridian Textiles. Conditions arrêtées : remise de 8 %, paiement à 30 jours, volume minimum de 800 unités par trimestre. La clause de révision annuelle des prix doit encore être validée par le juridique. Contact côté Meridian : Clara Meunier.",
        meridianId,
      ),
      await makeEpisode(
        scope,
        "[memory_eval] Meridian — point sur l'accord commercial",
        "Point sur l'accord commercial avec Meridian Textiles pour 2027. On retient une remise de 8 % avec un paiement ramené à 30 jours et un engagement de 800 unités par trimestre. Reste à faire valider la clause de révision annuelle des prix par le service juridique. L'interlocutrice est Clara Meunier.",
        meridianId,
      ),
    ];
  }
  if (kind === "revise") {
    return [
      await makeEpisode(
        scope,
        "[memory_eval] Meridian — livraison hebdomadaire (ancienne hypothèse)",
        "Il avait été envisagé avec Meridian Textiles une livraison HEBDOMADAIRE pour lisser les stocks, avec une remise plafonnée à 5 %.",
        meridianId,
      ),
      await makeEpisode(
        scope,
        "[memory_eval] Meridian — décision finale livraison mensuelle",
        "Décision finale actée avec Meridian Textiles : la livraison sera MENSUELLE (et non hebdomadaire comme envisagé au départ), avec une remise portée à 8 %. L'option hebdomadaire est abandonnée car trop coûteuse en logistique.",
        meridianId,
      ),
    ];
  }
  if (kind === "reanchor") {
    // A future-framed plan whose date is now past (vs <today>), plus a sibling
    // stating the outcome → REVISE the stale one (temporal re-anchoring).
    return [
      await makeEpisode(
        scope,
        "[memory_eval] Meridian — livraison commande urgente (échéance)",
        "Commande urgente CMD-2027 passée à Meridian Textiles : la livraison est ATTENDUE pour le 30 juin 2026. À suivre de près d'ici là.",
        meridianId,
      ),
      await makeEpisode(
        scope,
        "[memory_eval] Meridian — livraison CMD-2027 effectuée",
        "La commande urgente CMD-2027 de Meridian Textiles, dont la livraison ÉTAIT attendue pour le 30 juin 2026, a finalement bien été livrée et est conforme aux attentes. Le point de suivi antérieur qui l'annonçait comme encore à venir est donc dépassé.",
        meridianId,
      ),
    ];
  }
  return [
    await makeEpisode(
      scope,
      "[memory_eval] Meridian — négociation tarifaire 2027",
      "Négociation des conditions tarifaires 2027 avec Meridian Textiles : remise cible 8 %, volume 800 unités/trimestre.",
      meridianId,
    ),
    await makeEpisode(
      scope,
      "[memory_eval] Meridian — nettoyage de la fiche fournisseur",
      "Travail de qualité de données sur la fiche de Meridian Textiles : correction de l'adresse du siège, ajout du numéro de TVA intracommunautaire et fusion de deux contacts en doublon. Sans rapport avec la négociation commerciale en cours.",
      meridianId,
    ),
  ];
};

/** Drop the accumulated `[memory_eval]` cluster episodes (run start / cleanup). */
export const clearClusterEpisodes = async (scope: Scope): Promise<void> => {
  // The fixture episodes all carry the `[memory_eval]` title prefix; a prior
  // run's consolidation SURVIVOR (no prefix) lingers harmlessly until
  // `--cleanup` and never re-enters a judged cluster (we pass explicit ids).
  const rows = await db
    .select({ id: aiEpisodes.id })
    .from(aiEpisodes)
    .where(
      and(
        eq(aiEpisodes.teamId, scope.teamId),
        like(aiEpisodes.title, "[memory_eval]%"),
      ),
    );
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  await deleteEpisodeVectors(ids);
  await db.delete(aiEpisodes).where(inArray(aiEpisodes.id, ids));
};

// ---------------------------------------------------------------------------
// Relation extraction (P8.4) — scenario builders.
// ---------------------------------------------------------------------------

/**
 * Hard-delete every active/historical edge touching these records. The
 * `links_active_uniq` index makes a re-created edge a silent no-op, so each
 * repeat must start from a blank slate — same reason `makeConsolidationCluster`
 * rebuilds its episodes fresh. Direct row delete (eval-only records); the
 * `link.created` journal rows are swept by `cleanupMemoryFixtures`.
 */
const resetLinksAmong = async (recordIds: string[]): Promise<void> => {
  if (recordIds.length === 0) return;
  await db
    .delete(links)
    .where(
      or(
        inArray(links.fromRecordId, recordIds),
        inArray(links.toRecordId, recordIds),
      ),
    );
};

/**
 * Build ONE relation-extraction scenario fresh (called per repeat).
 *   - explicit: a text stating a supplier relationship between two records;
 *   - supersession: an ACTIVE seeded edge (Meridian ⊂ Volta) the text overturns
 *     (Meridian bought by Northwind) — the model must emit the new edge AND name
 *     the seeded one as superseded; returns its id to assert the invalidation;
 *   - noise: two records co-mentioned but with NO relation asserted.
 */
export const makeRelationScenario = async (
  fx: MemoryFixtures,
  kind: RelationKind,
): Promise<{
  text: string;
  recordIds: string[];
  seededLinkId: string | null;
}> => {
  const { organizationId, teamId, typeId } = fx;
  const { meridian, volta, northwind } = fx.records;

  if (kind === "explicit") {
    const recordIds = [meridian, volta];
    await resetLinksAmong(recordIds);
    return {
      text: "Partenariat fournisseur acté : Meridian Textiles fournit désormais Volta Energie en fibres de carbone pour ses turbines. Le contrat-cadre d'approvisionnement a été signé la semaine dernière.",
      recordIds,
      seededLinkId: null,
    };
  }
  if (kind === "noise") {
    const recordIds = [meridian, volta];
    await resetLinksAmong(recordIds);
    return {
      text: "Compte-rendu de la réunion hebdo. Le matin, point sur le dossier Meridian Textiles (relance de la négociation tarifaire). L'après-midi, sujet totalement distinct : préparation de l'audit interne de Volta Energie. Les deux dossiers n'ont aucun lien entre eux, ils étaient juste à l'ordre du jour le même jour.",
      recordIds,
      seededLinkId: null,
    };
  }
  // supersession — seed an active edge, then a text that changes the parent.
  const recordIds = [meridian, volta, northwind];
  await resetLinksAmong(recordIds);
  const { linkTypeId } = await resolveLinkType({
    organizationId,
    teamId,
    rawKey: "subsidiary_of",
    fromCollectionId: typeId,
    toCollectionId: typeId,
  });
  const { ids } = await bulkCreateLinks({
    organizationId,
    teamId,
    source: "ai_inference",
    links: [
      {
        linkTypeId,
        fromRecordId: meridian,
        toRecordId: volta,
        confidence: 0.95,
        status: "confirmed",
      },
    ],
  });
  return {
    text: "Mise à jour capitalistique : Meridian Textiles, jusqu'ici filiale de Volta Energie, vient d'être rachetée par Northwind Capital. Meridian est désormais une filiale de Northwind Capital, et n'appartient plus à Volta Energie.",
    recordIds,
    seededLinkId: ids[0] ?? null,
  };
};

// ---------------------------------------------------------------------------
// Episode promotion (P8.5) — scenario builders + learned/ isolation.
// ---------------------------------------------------------------------------

/** Machine namespace the promotion writes into — reset each repeat. */
const LEARNED_PREFIX = "learned/";

/**
 * Drop every `learned/` memory on the eval team (both scopes) AND its vectors.
 * Promotion writes here; a leftover row makes the dedup gate see a phantom, and
 * a leftover VECTOR pollutes the recall eval's semantic arm (the known
 * cross-suite isolation trap). Vectors are AWAITED — the real delete path
 * fire-and-forgets them, which would race `process.exit` at `--cleanup`.
 */
const purgeLearnedMemories = async (scope: Scope): Promise<void> => {
  const rows = await db
    .select({ id: aiMemories.id })
    .from(aiMemories)
    .where(
      and(
        eq(aiMemories.teamId, scope.teamId),
        like(aiMemories.path, `${LEARNED_PREFIX}%`),
      ),
    );
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    for (const id of ids) await deleteMemoryVectors(id);
    await db
      .delete(aiMemoryHistory)
      .where(inArray(aiMemoryHistory.memoryId, ids));
    await db.delete(aiMemories).where(inArray(aiMemories.id, ids));
  }
  // Sweep ORPHAN memory vectors — the real write path vectorizes memories
  // fire-and-forget, so a delete/vectorize race can leave a vector whose row
  // is already gone. On the shared eval team a stray memory vector pollutes the
  // recall eval's semantic arm; one with no live row is pure dead weight.
  const memVecs = await db
    .select({ sourceId: aiVectors.sourceId })
    .from(aiVectors)
    .where(
      and(
        eq(aiVectors.teamId, scope.teamId),
        eq(aiVectors.sourceType, "memories"),
      ),
    );
  const distinct = [...new Set(memVecs.map((v) => v.sourceId))];
  if (distinct.length === 0) return;
  const live = await db
    .select({ id: aiMemories.id })
    .from(aiMemories)
    .where(inArray(aiMemories.id, distinct));
  const liveIds = new Set(live.map((m) => m.id));
  for (const sid of distinct) {
    if (!liveIds.has(sid)) await deleteMemoryVectors(sid);
  }
};

/** Team-scope `learned/` memories on the eval team — the promotion assertions. */
export const learnedMemoriesFor = async (
  teamId: string,
): Promise<{ path: string; content: string }[]> => {
  const rows = await db.query.aiMemories.findMany({
    where: { teamId, scope: "team", path: { like: `${LEARNED_PREFIX}%` } },
    columns: { path: true, content: true },
  });
  return rows.map((r) => ({ path: r.path, content: r.content }));
};

/**
 * Build ONE promotion cluster fresh (called per repeat), resetting `learned/`
 * first so each repeat is independent.
 *   - durable: 3 episodes across different conversations restating the SAME
 *     standing convention → the model should ADD one generalized learned fact;
 *   - oneoff: 2 episodes of unrelated one-off facts → NOOP (no over-generalize);
 *   - dedup: the durable episodes, but the fact is ALREADY a learned memory →
 *     the Mem0 gate must NOOP/UPDATE, never add a duplicate.
 */
export const makePromotionCluster = async (
  fx: MemoryFixtures,
  kind: PromotionKind,
): Promise<{ episodeIds: string[]; seededMemoryPath: string | null }> => {
  const scope: Scope = {
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    userId: fx.userId,
  };
  await purgeLearnedMemories(scope);
  const epScope = { organizationId: fx.organizationId, teamId: fx.teamId };
  const meridianId = fx.records.meridian;

  const durableEpisodes = async (): Promise<string[]> => [
    await makeEpisode(
      epScope,
      "[memory_eval] Meridian — négociation, rappel process commande",
      "Négociation 2027 avec Meridian Textiles. Rappel noté au passage : comme toujours avec Meridian, aucune expédition n'est lancée tant que le bon de commande n'est pas signé par un responsable. C'est une exigence systématique de leur part.",
      meridianId,
    ),
    await makeEpisode(
      epScope,
      "[memory_eval] Meridian — expédition bloquée faute de BC signé",
      "Meridian Textiles a de nouveau bloqué une expédition parce que le bon de commande n'avait pas été signé par un responsable côté client. Il s'agit de leur règle standard : pas de BC signé, pas de départ marchandise.",
      meridianId,
    ),
    await makeEpisode(
      epScope,
      "[memory_eval] Meridian — onboarding, procédure d'achat",
      "Point d'onboarding sur le fournisseur Meridian Textiles. Procédure à retenir : toujours faire signer le bon de commande par un responsable avant de lancer la production ou l'expédition — Meridian l'exige à chaque commande.",
      meridianId,
    ),
  ];

  if (kind === "durable") {
    return { episodeIds: await durableEpisodes(), seededMemoryPath: null };
  }
  if (kind === "oneoff") {
    return {
      episodeIds: [
        await makeEpisode(
          epScope,
          "[memory_eval] Meridian — règlement d'une facture",
          "La facture F-2027-0412 de Meridian Textiles, d'un montant de 14 200 €, a été réglée le 3 juin 2026.",
          meridianId,
        ),
        await makeEpisode(
          epScope,
          "[memory_eval] Meridian — mise à jour de la fiche",
          "Mise à jour administrative de la fiche Meridian Textiles : nouvelle adresse de facturation saisie (12 rue de Lyon) et numéro de TVA intracommunautaire corrigé.",
          meridianId,
        ),
      ],
      seededMemoryPath: null,
    };
  }
  // dedup — the durable fact is already stored; the gate must not duplicate it.
  const botUserId = await getTeamBotUserId(fx.teamId);
  const path = `${LEARNED_PREFIX}meridian-bon-de-commande.md`;
  await createMemory({
    rawPath: `/memories/team/${path}`,
    content:
      "Meridian Textiles exige un bon de commande signé par un responsable avant toute expédition.\n\n**When to apply:** toute commande passée à Meridian Textiles.\n**What to do:** faire signer le bon de commande par un responsable avant de lancer la production ou l'expédition.\n\nSources: episode:seed",
    scopeKey: {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: botUserId,
    },
    actor: { userId: botUserId, actor: "agent" },
  });
  return { episodeIds: await durableEpisodes(), seededMemoryPath: path };
};

export const ensureMemoryFixtures = async (
  scope: Scope,
): Promise<MemoryFixtures> => {
  const typeId = await ensureType(scope);
  const meridian = await ensureRecord(
    scope,
    typeId,
    "Meridian Textiles",
    "textile technique",
  );
  const volta = await ensureRecord(
    scope,
    typeId,
    "Volta Energie",
    "énergie renouvelable",
  );
  // Third company — the acquirer in the relation-supersession scenario.
  const northwind = await ensureRecord(
    scope,
    typeId,
    "Northwind Capital",
    "capital-investissement",
  );
  const conversationId = await ensureConversation(scope, meridian);
  const sensitiveConversationId = await ensureSensitiveConversation(scope);
  const activityRecordId = await ensureActivityRecord(scope, typeId);
  // Clear any cluster episodes a prior run left active — each consolidate
  // repeat builds its own fresh pair via `makeConsolidationCluster`.
  await clearClusterEpisodes(scope);

  return {
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    userId: scope.userId,
    typeId,
    records: { meridian, volta, northwind },
    conversationId,
    sensitiveConversationId,
    activityRecordId,
  };
};

/** Tear the whole fixture universe down (`--cleanup`). */
export const cleanupMemoryFixtures = async (scope: Scope): Promise<void> => {
  const typeId = await findTypeId(scope);

  // Episodes: cluster fixtures + anything anchored to / distilled from the
  // eval rows (conversation episode, activity digest, consolidation survivor).
  const evalRecordIds = new Set<string>();
  if (typeId) {
    const recs = await db.query.collectionRecords.findMany({
      where: { teamId: scope.teamId, collectionId: typeId },
      columns: { id: true },
    });
    for (const r of recs) evalRecordIds.add(r.id);
  }
  const convs = await db.query.aiConversations.findMany({
    where: {
      teamId: scope.teamId,
      title: { in: [CONVERSATION_TITLE, SENSITIVE_CONVERSATION_TITLE] },
    },
    columns: { id: true },
  });
  const convIds = new Set(convs.map((c) => c.id));
  const episodes = await db.query.aiEpisodes.findMany({
    where: { teamId: scope.teamId },
    columns: {
      id: true,
      title: true,
      conversationId: true,
      anchorRecordId: true,
    },
    with: { episodeRecords: { columns: { recordId: true } } },
  });
  const episodeIds = episodes
    .filter(
      (e) =>
        e.title.startsWith("[memory_eval]") ||
        (e.conversationId !== null && convIds.has(e.conversationId)) ||
        (e.anchorRecordId && evalRecordIds.has(e.anchorRecordId)) ||
        e.episodeRecords.some((r) => evalRecordIds.has(r.recordId)),
    )
    .map((e) => e.id);
  if (episodeIds.length > 0) {
    await deleteEpisodeVectors(episodeIds);
    await db.delete(aiEpisodes).where(inArray(aiEpisodes.id, episodeIds));
  }

  // Conversations (messages cascade) + all eval journal events (dedupKey
  // prefix), so no orphan `record.updated` / `chat.turn` rows linger.
  if (convIds.size > 0) {
    await db
      .delete(aiConversations)
      .where(inArray(aiConversations.id, [...convIds]));
  }
  await db
    .delete(domainEvents)
    .where(
      and(
        eq(domainEvents.teamId, scope.teamId),
        like(domainEvents.dedupKey, "memory_eval.%"),
      ),
    );

  // Promotion (P8.5) writes `learned/` memories + vectors — purge them (the
  // recall-eval isolation trap), and the link/memory journal rows the relation
  // + promotion fixtures emit (no `memory_eval.` dedup prefix of their own).
  await purgeLearnedMemories(scope);
  await db
    .delete(domainEvents)
    .where(
      and(
        eq(domainEvents.teamId, scope.teamId),
        inArray(domainEvents.type, [
          "link.created",
          "link.invalidated",
          "memory.created",
          "memory.updated",
          "memory.deleted",
        ]),
      ),
    );

  // Records (+ cards), then the fixture type (drops the typed table).
  if (typeId) {
    const ids = [...evalRecordIds];
    for (const id of ids) await deleteRecordCardVectors(id);
    if (ids.length > 0) {
      await bulkDeleteCollectionRecords({ teamId: scope.teamId, ids });
    }
    await deleteCollection({ id: typeId });
  }
  console.log("[memory-fixtures] cleaned up");
};
