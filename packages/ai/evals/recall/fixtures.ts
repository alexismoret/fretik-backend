/**
 * Deterministic fixture universe for the recall eval (P5-bis).
 *
 * Everything is seeded through the REAL pipelines — records via
 * `createCollectionRecord` (typed tables + journal events), cards/episodes/
 * memories/documents indexed via the in-process `vectorizeSource` — so
 * the gather arms behave exactly as in production. Fictional,
 * industry-agnostic names ("Nordwind", "Sirius") keep the universe
 * recognisable in the eval team's data and greppable for cleanup.
 *
 * Idempotent (`ensureRecallFixtures`): existence is checked by stable
 * natural keys (object-type key, record label, episode title, memory
 * path, document file_name) so repeated eval runs reuse the same rows —
 * fast iteration, stable ids. `cleanupRecallFixtures` tears everything
 * down (`--cleanup`).
 */

import db from "@fretik/shared/db";
import type {
  DocumentVectorMetadata,
  EpisodeVectorMetadata,
  MemoryVectorMetadata,
  RecordVectorMetadata,
} from "@fretik/shared/db/schema";
import { aiEpisodes, aiMemories, aiVectors } from "@fretik/shared/db/schema";
import { deleteMemoryVectors } from "@fretik/shared/services/ai-memory/vector-refresh";
import { buildRecordCard } from "@fretik/shared/services/collection-records/build-card";
import { bulkDeleteCollectionRecords } from "@fretik/shared/services/collection-records/bulk-delete";
import { deleteRecordCardVectors } from "@fretik/shared/services/collection-records/card-vectors";
import { createCollectionRecord } from "@fretik/shared/services/collection-records/create";
import { createCollectionWithFields } from "@fretik/shared/services/collections/create-with-fields";
import { deleteCollection } from "@fretik/shared/services/collections/delete";
import { upsertEpisode } from "@fretik/shared/services/episodes/upsert";
import { deleteEpisodeVectors } from "@fretik/shared/services/episodes/vectors";
import { createLinkType } from "@fretik/shared/services/link-types/create";
import { createLink } from "@fretik/shared/services/links/create";
import { and, eq, inArray, sql } from "drizzle-orm";
import { vectorizeSource } from "../../src/services/vectorize";
import { perturb, round, SCALE_SIGMA } from "./scale-vectors";

const SUPPLIER_COLLECTION_KEY = "recall_eval_supplier";
const PROJECT_COLLECTION_KEY = "recall_eval_project";

export interface RecallFixtures {
  organizationId: string;
  teamId: string;
  userId: string;
  records: {
    nordwind: string;
    nordwindConsulting: string;
    sirius: string;
    horizon: string;
    vega: string;
    callisto: string;
    distractors: string[];
  };
  episodes: {
    contract: string;
    pricingOld: string;
    privateBail: string;
    vegaOld: string;
    vegaNew: string;
    callistoFresh: string;
    planning: string;
  };
  memoryPaths: { recapHebdo: string; relanceStyle: string };
  documents: { bail: string; charte: string };
  workflows: { lateDeliveries: string };
  /**
   * The delivery date the `planning` episode states, as the two forms a French
   * answer can take (`17/09` and `17 septembre`).
   *
   * Exported so the assertion is built from the SAME value the fixture wrote.
   * A case that hard-codes a date is a case that starts failing on a Tuesday.
   */
  nextDelivery: { numeric: string; long: string };
}

interface Scope {
  organizationId: string;
  teamId: string;
  userId: string;
}

/** Distractor suppliers — realistic volume for the selectivity case. */
const DISTRACTORS: { label: string; ville: string; secteur: string }[] = [
  {
    label: "Alpha Composants",
    ville: "Grenoble",
    secteur: "composants électroniques",
  },
  {
    label: "Baltic Screens",
    ville: "Riga",
    secteur: "composants électroniques",
  },
  { label: "Cobalt Plastics", ville: "Anvers", secteur: "plasturgie" },
  { label: "Delta Emballages", ville: "Nantes", secteur: "emballage" },
  { label: "Estrella Química", ville: "Barcelone", secteur: "chimie" },
  { label: "Fjord Interim", ville: "Oslo", secteur: "intérim" },
  { label: "Grafik Studio", ville: "Berlin", secteur: "design graphique" },
  { label: "Helios Energie", ville: "Marseille", secteur: "énergie" },
  { label: "Imprimerie Voltaire", ville: "Lille", secteur: "impression" },
  {
    label: "Juno Cloud Services",
    ville: "Dublin",
    secteur: "hébergement cloud",
  },
  {
    label: "Kappa Métallurgie",
    ville: "Saint-Étienne",
    secteur: "métallurgie",
  },
  { label: "Lumen Optique", ville: "Genève", secteur: "composants optiques" },
];

const findTypeId = async (
  scope: Scope,
  key: string,
): Promise<string | null> => {
  const row = await db.query.collections.findFirst({
    where: { teamId: scope.teamId, key },
    columns: { id: true },
  });
  return row?.id ?? null;
};

const ensureType = async (
  scope: Scope,
  key: string,
  label: string,
  extraFields: { label: string; vectorize: boolean }[],
): Promise<string> => {
  const existing = await findTypeId(scope, key);
  if (existing) return existing;
  const created = await createCollectionWithFields({
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    key,
    label,
    description: `Fixture du recall-eval (${label}) — ne pas utiliser.`,
    fields: [
      { label: "Nom", type: "text", isTitle: true },
      ...extraFields.map((f) => ({
        label: f.label,
        type: "text" as const,
        vectorizeInclude: f.vectorize,
        description: `Fixture recall-eval.`,
      })),
    ],
  });
  return created.id;
};

const findRecordId = async (
  scope: Scope,
  collectionId: string,
  label: string,
): Promise<string | null> => {
  const row = await db.query.collectionRecords.findFirst({
    where: { teamId: scope.teamId, collectionId, label },
    columns: { id: true },
  });
  return row?.id ?? null;
};

/** Create + card-index one record (idempotent by label). */
const ensureRecord = async (
  scope: Scope,
  collectionId: string,
  label: string,
  data: Record<string, unknown>,
): Promise<string> => {
  const existing = await findRecordId(scope, collectionId, label);
  if (existing) return existing;
  const record = await createCollectionRecord({
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    collectionId,
    data: { nom: label, ...data },
    labelOverride: label,
    status: "confirmed",
  });
  const card = await buildRecordCard(record.id);
  if (card) {
    await vectorizeSource({
      sourceType: "records",
      sourceId: record.id,
      content: card.content,
      metadata: card.metadata,
      teamId: card.teamId,
      organizationId: card.organizationId,
    });
  }
  return record.id;
};

const findEpisode = async (
  scope: Scope,
  title: string,
): Promise<{ id: string; summary: string } | null> => {
  const row = await db.query.aiEpisodes.findFirst({
    where: { teamId: scope.teamId, title, state: "active" },
    columns: { id: true, summary: true },
  });
  return row ?? null;
};

/**
 * Fixture dates are RELATIVE, and re-applied on every ensure.
 *
 * They used to be hard-coded to June 2026 and, because `ensureEpisode` returns
 * early on an existing title, they were written once and then aged silently.
 * That is invisible to the block suite — `rec-freshness-conflict` only cares
 * which of two episodes is newer — and fatal to anything with a rolling
 * window: by 2026-09-11 the whole universe was 73-180 days old, i.e. outside
 * every window a standing-memory layer can have. A suite that cannot populate
 * the thing under test cannot measure it.
 */
const daysAgo = (days: number): Date =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/**
 * The next Tuesday strictly after today — the date the `planning` episode
 * names, and the one `mr-contextless-week` asserts.
 *
 * Strictly after, so the answer is never "today": a contextless question about
 * the week ahead must be answerable without the model having to reason about
 * whether "mardi" already happened.
 */
const nextTuesday = (): Date => {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  d.setDate(d.getDate() + ((2 - d.getDay() + 7) % 7 || 7));
  return d;
};

const FRENCH_MONTHS = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];

const frenchDate = (d: Date): { numeric: string; long: string } => ({
  numeric: `${d.getDate().toString().padStart(2, "0")}/${(d.getMonth() + 1).toString().padStart(2, "0")}`,
  long: `${d.getDate().toString()} ${FRENCH_MONTHS[d.getMonth()] ?? ""}`,
});

/**
 * The date the `planning` episode names, as a pure function.
 *
 * Exported so an assertion computes the SAME value the fixture wrote instead
 * of hard-coding one — a hard-coded date is a case that starts failing on a
 * Tuesday. It is recomputed at assert time rather than read back from the
 * fixture because assertions are static; the two can only disagree for a run
 * that crosses midnight into a Tuesday.
 */
export const nextDeliveryDate = (): { numeric: string; long: string } =>
  frenchDate(nextTuesday());

const ensureEpisode = async (
  scope: Scope,
  input: {
    title: string;
    summary: string;
    recordIds: string[];
    userId?: string | null;
    occurredFrom?: Date;
    occurredTo?: Date;
  },
): Promise<string> => {
  const occurredFrom = input.occurredFrom ?? daysAgo(8);
  const occurredTo = input.occurredTo ?? daysAgo(3);
  const existing = await findEpisode(scope, input.title);
  if (existing) {
    // Re-date rather than re-insert: the row is keyed by title. `created_at`
    // moves too, because every rolling-window query reads
    // `coalesce(occurred_to, created_at)`.
    await db.execute(sql`
      UPDATE ai_episodes
      SET occurred_from = ${occurredFrom}, occurred_to = ${occurredTo},
          created_at = ${occurredFrom},
          summary = ${input.summary}
      WHERE id = ${existing.id}
    `);
    // The vector's metadata carries `occurred_to` and `asOfLine` renders it,
    // so a re-dated row with a stale vector shows yesterday's date in
    // `<active_memory>`.
    await db.execute(sql`
      UPDATE ai_vectors
      SET metadata = jsonb_set(
            jsonb_set(metadata, '{occurred_to}', to_jsonb(${occurredTo.toISOString()}::text)),
            '{occurred_from}', to_jsonb(${occurredFrom.toISOString()}::text))
      WHERE source_type = 'episodes' AND source_id = ${existing.id}
    `);
    // One fixture's text is not stable — the planning episode names a computed
    // date — so its vector has to be rebuilt, or the block would retrieve last
    // run's date. Only when the text actually moved: embeddings are cached by
    // text, but the rerank and write are not free.
    if (existing.summary !== input.summary) {
      const metadata: EpisodeVectorMetadata = {
        kind: "consolidated",
        title: input.title,
        conversation_id: null,
        anchor_record_id: null,
        occurred_from: occurredFrom.toISOString(),
        occurred_to: occurredTo.toISOString(),
      };
      await vectorizeSource({
        sourceType: "episodes",
        sourceId: existing.id,
        content: `${input.title}\n\n${input.summary}`,
        metadata,
        teamId: scope.teamId,
        organizationId: scope.organizationId,
        userId: input.userId ?? null,
      });
    }
    return existing.id;
  }
  const { episode } = await upsertEpisode({
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    userId: input.userId ?? null,
    kind: "consolidated",
    title: input.title,
    summary: input.summary,
    recordIds: input.recordIds,
    occurredFrom,
    occurredTo,
  });
  const metadata: EpisodeVectorMetadata = {
    kind: episode.kind,
    title: episode.title,
    conversation_id: null,
    anchor_record_id: null,
    occurred_from: episode.occurredFrom?.toISOString() ?? null,
    occurred_to: episode.occurredTo?.toISOString() ?? null,
  };
  await vectorizeSource({
    sourceType: "episodes",
    sourceId: episode.id,
    content: `${episode.title}\n\n${episode.summary}`,
    metadata,
    teamId: scope.teamId,
    organizationId: scope.organizationId,
    userId: episode.userId,
  });
  return episode.id;
};

const ensureMemory = async (
  scope: Scope,
  path: string,
  content: string,
): Promise<void> => {
  const existing = await db.query.aiMemories.findFirst({
    where: { teamId: scope.teamId, path, scope: "team" },
    columns: { id: true },
  });
  if (existing) return;
  const [row] = await db
    .insert(aiMemories)
    .values({
      organizationId: scope.organizationId,
      teamId: scope.teamId,
      userId: null,
      scope: "team",
      path,
      content,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      createdByActor: "agent",
      lastModifiedByActor: "agent",
    })
    .returning();
  if (!row) throw new Error(`memory insert failed for ${path}`);
  const metadata: MemoryVectorMetadata = {
    scope: "team",
    path,
    size_bytes: row.sizeBytes,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
  await vectorizeSource({
    sourceType: "memories",
    sourceId: row.id,
    content,
    metadata,
    teamId: scope.teamId,
    organizationId: scope.organizationId,
    userId: null,
  });
};

/**
 * Synthetic document: content indexed straight into `ai_vectors`
 * (source_type='documents') — `searchRAG` never joins the documents
 * table, so recall behaves exactly as with a real upload, without
 * dragging OCR/upload pipelines into the eval.
 */
const ensureDocument = async (
  scope: Scope,
  fileName: string,
  summary: string,
  content: string,
): Promise<string> => {
  const rows = await db
    .select({ sourceId: aiVectors.sourceId })
    .from(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "documents"),
        eq(aiVectors.teamId, scope.teamId),
        sql`${aiVectors.metadata}->>'file_name' = ${fileName}`,
      ),
    )
    .limit(1);
  const first = rows[0];
  if (first) return first.sourceId;
  const sourceId = crypto.randomUUID();
  const metadata: DocumentVectorMetadata = {
    file_name: fileName,
    file_type: "application/pdf",
    page_count: 3,
    document_language: "fr",
    document_summary: summary,
    entities: [],
    custom_fields: {},
  };
  await vectorizeSource({
    sourceType: "documents",
    sourceId,
    content,
    metadata,
    teamId: scope.teamId,
    organizationId: scope.organizationId,
  });
  return sourceId;
};

/**
 * Synthetic workflow card, indexed straight into `ai_vectors`
 * (source_type='workflows') — same shortcut as `ensureDocument`: the recall
 * capability arm reads vectors, never the `workflows` table, so this exercises
 * the real path without a playbook row. Content mirrors `buildWorkflowCard`
 * (`@fretik/shared/services/workflows/vector-refresh`) — goal first, then the
 * task titles, because a user asks for the OUTCOME.
 */
const ensureWorkflowCard = async (
  scope: Scope,
  name: string,
  card: string,
): Promise<string> => {
  const rows = await db
    .select({ sourceId: aiVectors.sourceId })
    .from(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "workflows"),
        eq(aiVectors.teamId, scope.teamId),
        sql`${aiVectors.metadata}->>'name' = ${name}`,
      ),
    )
    .limit(1);
  const first = rows[0];
  if (first) return first.sourceId;
  const sourceId = crypto.randomUUID();
  await vectorizeSource({
    sourceType: "workflows",
    sourceId,
    content: card,
    metadata: {
      name,
      description: "",
      trigger_type: "manual",
      status: "active",
      task_count: 3,
      content_hash: "",
      version_indexed_at: new Date().toISOString(),
    },
    teamId: scope.teamId,
    organizationId: scope.organizationId,
  });
  return sourceId;
};

export const ensureRecallFixtures = async (
  scope: Scope,
): Promise<RecallFixtures> => {
  const supplierTypeId = await ensureType(
    scope,
    SUPPLIER_COLLECTION_KEY,
    "Fournisseur (recall-eval)",
    [
      { label: "Ville", vectorize: true },
      { label: "Secteur", vectorize: true },
      { label: "Note interne", vectorize: true },
    ],
  );
  const projectTypeId = await ensureType(
    scope,
    PROJECT_COLLECTION_KEY,
    "Projet (recall-eval)",
    [{ label: "Objectif", vectorize: true }],
  );

  const nordwind = await ensureRecord(scope, supplierTypeId, "Nordwind GmbH", {
    ville: "Hambourg",
    secteur: "composants électroniques — écrans OLED",
    note_interne:
      "Fournisseur allemand ajouté récemment pour les écrans OLED. Interlocuteur: Jonas Weber.",
  });
  const nordwindConsulting = await ensureRecord(
    scope,
    supplierTypeId,
    "Nordwind Consulting",
    {
      ville: "Paris",
      secteur: "conseil RH et recrutement",
      note_interne: "Cabinet de conseil — mission de recrutement Q3.",
    },
  );
  const sirius = await ensureRecord(
    scope,
    supplierTypeId,
    "Sirius Immobilier",
    {
      ville: "Lyon",
      secteur: "immobilier d'entreprise",
      note_interne: "Bailleur des locaux de Lyon (bail commercial).",
    },
  );
  const horizon = await ensureRecord(scope, projectTypeId, "Horizon", {
    objectif: "Refonte de l'intranet interne — phase de cadrage.",
  });
  // Freshness-conflict subject — isolated (name/sector share nothing with the
  // other cases) so its two dated, contradicting episodes surface only for
  // the Vega delivery question.
  const vega = await ensureRecord(scope, supplierTypeId, "Vega Logistics", {
    ville: "Rotterdam",
    secteur: "transport et logistique",
    note_interne: "Transporteur pour les expéditions Benelux.",
  });
  // Usage-vs-relevance subject — isolated vocabulary (software support /
  // tickets) so its episodes only compete on the Callisto question.
  const callisto = await ensureRecord(
    scope,
    supplierTypeId,
    "Callisto Systems",
    {
      ville: "Berlin",
      secteur: "éditeur logiciel — outil de ticketing",
      note_interne: "Éditeur de l'outil de suivi des tickets internes.",
    },
  );
  const distractors: string[] = [];
  for (const d of DISTRACTORS) {
    distractors.push(
      await ensureRecord(scope, supplierTypeId, d.label, {
        ville: d.ville,
        secteur: d.secteur,
      }),
    );
  }

  // One active 1-hop link so the GRAPH arm has an edge to render.
  const existingLinkType = await db.query.linkTypes.findFirst({
    where: { teamId: scope.teamId, key: "recall_eval_fournit" },
    columns: { id: true },
  });
  const linkTypeId =
    existingLinkType?.id ??
    (
      await createLinkType({
        organizationId: scope.organizationId,
        teamId: scope.teamId,
        key: "recall_eval_fournit",
        label: "fournit",
        fromCollectionId: supplierTypeId,
        toCollectionId: projectTypeId,
      })
    ).id;
  const existingLink = await db.query.links.findFirst({
    where: {
      linkTypeId,
      fromRecordId: nordwind,
      toRecordId: horizon,
      invalidatedAt: { isNull: true },
    },
    columns: { id: true },
  });
  if (!existingLink) {
    await createLink({
      organizationId: scope.organizationId,
      teamId: scope.teamId,
      linkTypeId,
      fromRecordId: nordwind,
      toRecordId: horizon,
    });
  }

  const contract = await ensureEpisode(scope, {
    title: "Négociation contrat Nordwind GmbH — conditions 2027",
    summary:
      "Négociation du contrat d'approvisionnement 2027 avec Nordwind GmbH (écrans OLED). **Décisions actées** : commande minimale de 500 unités par trimestre ; remise de 8 % sur le tarif catalogue ; **rythme de livraison bimensuel** (toutes les deux semaines, le mardi). **Point ouvert** : la clause de pénalité de retard doit être revalidée par le juridique avant signature. **Prochaine étape** : relancer Jonas Weber avant le 15 pour obtenir le contrat signé.",
    recordIds: [nordwind],
  });
  const pricingOld = await ensureEpisode(scope, {
    title: "Benchmark tarifaire fournisseurs d'écrans — comparatif initial",
    summary:
      "Comparatif de tarifs entre fournisseurs d'écrans réalisé en amont du choix : Nordwind GmbH (tarif de référence), Baltic Screens (−5 % mais délais doublés), Lumen Optique (qualité supérieure, +18 %). Conclusion de l'époque : Nordwind offrait le meilleur rapport qualité/prix/délai. Ce benchmark est antérieur à la négociation du contrat 2027.",
    recordIds: [nordwind, distractors[1] ?? nordwind],
    // Deliberately older than a standing-memory window and younger than the
    // corpus: it must stay RETRIEVABLE (`rec-episode-right-one` asks recall to
    // prefer the contract over it) while never appearing in a "lately" block.
    // A free negative control for anything that claims to show recent work.
    occurredFrom: daysAgo(48),
    occurredTo: daysAgo(45),
  });
  const privateBail = await ensureEpisode(scope, {
    title: "Notes personnelles — renégociation du bail Sirius",
    summary:
      "Réflexions personnelles avant la renégociation du bail avec Sirius Immobilier : viser 10 % de réduction du loyer en s'appuyant sur les taux de vacance du quartier ; NE PAS mentionner le budget maximum validé en interne (4 500 €/mois) ; demander un étalement de la caution si possible.",
    recordIds: [sirius],
    userId: scope.userId,
  });
  // Two dated episodes about Vega's delivery lead time that CONTRADICT: the
  // recent one supersedes the old value. Recall must keep the recent fact.
  const vegaOld = await ensureEpisode(scope, {
    title: "Vega Logistics — délai de livraison initial",
    summary:
      "Point logistique avec Vega Logistics : le délai de livraison standard pour les expéditions Benelux est de 48 heures après enlèvement.",
    recordIds: [vega],
    occurredFrom: daysAgo(100),
    occurredTo: daysAgo(95),
  });
  const vegaNew = await ensureEpisode(scope, {
    title: "Vega Logistics — nouveau délai de livraison",
    summary:
      "Vega Logistics a revu ses délais : le délai de livraison standard pour les expéditions Benelux passe désormais à 24 heures après enlèvement, contre 48 heures auparavant.",
    recordIds: [vega],
    occurredFrom: daysAgo(6),
    occurredTo: daysAgo(2),
  });

  // Usage-vs-relevance cluster (rec-graph-usage-vs-relevance): three
  // heavily-recalled peripheral episodes against one fresh, directly relevant
  // one, all anchored on Callisto. The raw UPDATE below (re-applied on every
  // ensure, bypassing the ORM's $onUpdateFn) pins the geometry: crowders 10
  // days old with 60 recalls, the relevant episode fresh with none. Unbounded
  // boost ranks the crowders at now+50d and evicts the relevant episode from
  // the graph arm's 3 slots; a 7-day cap ranks them at now−3d and it wins one.
  for (const [week, note] of [
    [
      "semaine 27",
      "Point de suivi hebdomadaire avec Callisto Systems : revue du backlog de tickets, pas d'incident majeur, prochaine revue planifiée.",
    ],
    [
      "semaine 28",
      "Suivi hebdomadaire Callisto Systems : mise à jour mineure de l'outil déployée, temps de réponse stables, rien à signaler.",
    ],
    [
      "semaine 29",
      "Suivi hebdomadaire Callisto Systems : volumétrie de tickets en légère baisse, revue des accès utilisateurs effectuée.",
    ],
  ] as const) {
    await ensureEpisode(scope, {
      title: `Callisto Systems — suivi hebdo (${week})`,
      summary: note,
      recordIds: [callisto],
    });
  }
  const callistoFresh = await ensureEpisode(scope, {
    title: "Callisto Systems — nouveau contact support",
    summary:
      "Changement d'interlocuteur chez Callisto Systems : **Lena Voss** (l.voss@callisto.example) reprend le suivi de nos tickets à compter de cette semaine. L'ancien interlocuteur, Marek Jansen, quitte le support — ne plus lui adresser de demandes.",
    recordIds: [callisto],
  });
  await db.execute(sql`
    UPDATE ai_episodes
    SET updated_at = now() - interval '10 days', recall_count = 60
    WHERE team_id = ${scope.teamId} AND title LIKE 'Callisto Systems — suivi hebdo%'
  `);
  await db.execute(sql`
    UPDATE ai_episodes
    SET updated_at = now(), recall_count = 0
    WHERE id = ${callistoFresh}
  `);

  // The one episode a CONTEXTLESS question stands on ("qu'est-ce qu'on a de
  // prévu cette semaine ?"). Nothing in it matches such a message lexically or
  // semantically — no entity is named in the question — so it is only ever
  // reachable through a standing block. Its date is computed, so the case is
  // never scored against a date that has passed.
  const nextDelivery = frenchDate(nextTuesday());
  const planning = await ensureEpisode(scope, {
    title: "Planning — semaine en cours",
    summary:
      `Points à tenir cette semaine. Prochaine livraison Nordwind GmbH (rythme bimensuel) : mardi ${nextDelivery.numeric} (${nextDelivery.long}). ` +
      "La clause de pénalité de retard du contrat 2027 est toujours en attente de revalidation par le juridique avant signature.",
    recordIds: [nordwind],
    occurredFrom: daysAgo(1),
    occurredTo: daysAgo(1),
  });

  const recapHebdoPath = "team/processes/recap-hebdo-fournisseurs.md";
  await ensureMemory(
    scope,
    recapHebdoPath,
    "Récap hebdo fournisseurs.\n\n**When to apply:** quand on demande le récap, le point ou le bilan hebdomadaire des fournisseurs.\n\n**What to do:** produire un tableau markdown avec les colonnes Fournisseur / Statut / Prochaine action, trié par urgence, et l'envoyer le vendredi avant midi.",
  );
  const relanceStylePath = "team/processes/relances-fournisseurs.md";
  await ensureMemory(
    scope,
    relanceStylePath,
    "Relances fournisseurs.\n\n**When to apply:** toute relance écrite adressée à un fournisseur.\n\n**What to do:** ton ferme mais courtois ; rappeler systématiquement la référence du contrat ; fixer une échéance explicite à 7 jours ; mettre l'acheteur référent en copie.",
  );

  const bail = await ensureDocument(
    scope,
    "bail-sirius-lyon.pdf",
    "Bail commercial des locaux de Lyon signé avec Sirius Immobilier.",
    "# Bail commercial — locaux de Lyon\n\n**Bailleur :** Sirius Immobilier, 14 quai de la Pêcherie, 69001 Lyon.\n\n**Preneur :** la société locataire.\n\n## Conditions financières\n\n- **Loyer mensuel : 4 200 € HT**, payable au premier jour ouvré de chaque mois.\n- **Dépôt de garantie (caution) : 12 600 €**, soit trois mois de loyer, restituable dans les deux mois suivant la fin du bail.\n- Indexation annuelle sur l'ILC.\n\n## Durée et renouvellement\n\n- Bail de type 3/6/9 prenant effet au 1er octobre 2024.\n- **Échéance de renouvellement : 30 septembre 2027.**\n- **Préavis de résiliation : 6 mois** avant chaque échéance triennale, par acte extrajudiciaire.\n\n## Clauses particulières\n\n- Travaux d'aménagement soumis à accord écrit du bailleur.\n- Sous-location interdite sauf accord exprès.",
  );
  const charte = await ensureDocument(
    scope,
    "charte-achats-responsables.pdf",
    "Charte interne des achats responsables.",
    "# Charte des achats responsables\n\nLa présente charte encadre les relations avec l'ensemble des fournisseurs référencés.\n\n- Privilégier les fournisseurs disposant d'une certification environnementale.\n- Tout nouveau fournisseur fait l'objet d'une évaluation documentée avant référencement.\n- Les paiements sont effectués à 30 jours fin de mois, sans exception.\n- Un audit qualité est mené chaque année sur au moins 20 % du panel fournisseurs.",
  );

  // The capability axis: a workflow whose GOAL is the outcome a user would ask
  // for in plain words, never naming a workflow. Deliberately worded around
  // suppliers and deliveries so it also probes the false positive — every
  // supplier question in this suite shares that vocabulary with it.
  const lateDeliveries = await ensureWorkflowCard(
    scope,
    "Récap des livraisons fournisseurs en retard",
    "Workflow: Récap des livraisons fournisseurs en retard\nGoal: produire la liste des livraisons fournisseurs en retard et l'envoyer aux acheteurs.\nStarted by: manuellement, ou tous les lundis à 8h.\nSteps:\n1. Collecter les livraisons attendues — lister les livraisons dont la date prévue est dépassée.\n2. Recouper avec les fournisseurs — rattacher chaque retard à son fournisseur et à son contrat.\n3. Envoyer le récapitulatif — tableau des retards par fournisseur, envoyé aux acheteurs.",
  );

  return {
    organizationId: scope.organizationId,
    teamId: scope.teamId,
    userId: scope.userId,
    records: {
      nordwind,
      nordwindConsulting,
      sirius,
      horizon,
      vega,
      callisto,
      distractors,
    },
    episodes: {
      contract,
      pricingOld,
      privateBail,
      vegaOld,
      vegaNew,
      callistoFresh,
      planning,
    },
    nextDelivery,
    memoryPaths: { recapHebdo: recapHebdoPath, relanceStyle: relanceStylePath },
    documents: { bail, charte },
    workflows: { lateDeliveries },
  };
};

/** `metadata.label` prefix every scale distractor carries. */
const SCALE_PREFIX = "scale-distractor-";

/** How many rows go in one INSERT. 2560 fp32 dims per row is the constraint. */
const SCALE_BATCH = 500;

/** How many real vectors the distractors are perturbed from. */
const SCALE_BASES = 16;

/**
 * Decimal places kept in the halfvec literal.
 *
 * Free, and measured: the column is fp16, whose own narrowing already costs
 * 2.0e-5 of absolute error, so rounding to 5 dp (5.0e-6) is strictly finer than
 * what gets stored. It halves the wire — a full-precision row serialises to
 * 54.7 KB, and 50 000 of them are 2.7 GB of INSERT text over a remote
 * connection.
 */
const SCALE_DECIMALS = 5;

/**
 * `source_type` the distractors are written as.
 *
 * **`records`, and getting this wrong made the whole instrument lie.** The
 * first version wrote `documents`, which reads plausibly and tests nothing: the
 * eval team's rows are 20 072 records, 27 episodes, 9 memories and 118
 * documents, and the semantic arm under test filters
 * `source_type IN ('memories','episodes','records')`. Ten thousand document
 * distractors therefore left the knowledge partition at 20 108 rows — measured
 * 747 ms before and 769 ms after, a 3 % move for a 49 % bigger TABLE — so the
 * suite would have reported a healthy arm at 50 000 while the arm never grew.
 *
 * `records` is also the honest growth model: it is what a real team accumulates
 * most of, and it already dominates this corpus. The registry arm is unaffected
 * — it reads `collection_records`, not `ai_vectors`, and these rows have no
 * record behind them.
 */
const SCALE_SOURCE_TYPE = "records" as const;

/**
 * Collection the distractors claim to belong to.
 *
 * The fixture supplier collection, on purpose: a distractor that claims a
 * collection nothing else uses would be trivially separable by any future
 * filter, and the point of these rows is to be indistinguishable from the
 * team's own. They carry no `collection_records` row — nothing joins one — so
 * the registry arm never sees them and only the vector arms compete.
 */
const SCALE_COLLECTION_KEY = SUPPLIER_COLLECTION_KEY;

/**
 * Grow the EVAL team's KNOWLEDGE partition to `count` synthetic distractors, so
 * the suite can be run against a corpus the size of a real team's.
 *
 * Why it exists: the semantic arm is a Seq Scan, and the cost that matters is
 * per candidate row AFTER the source-type filter, not per table row. At the
 * eval team's ~20 k that was survivable and nothing in the suite could see the
 * cliff, because the suite never changed the corpus size. `--scale` makes "it
 * is fast enough" a claim about a SIZE rather than about this laptop.
 *
 * The rows are deliberately BM25-inert: neutral filler text with no eval
 * vocabulary in it, so a scale run moves the semantic arm and leaves the
 * lexical arms where they were. One variable at a time.
 *
 * Idempotent and resumable — counts what is already there and tops up.
 */
export const seedScaleDistractors = async (
  scope: Scope,
  count: number,
): Promise<{ total: number }> => {
  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, SCALE_SOURCE_TYPE),
        eq(aiVectors.teamId, scope.teamId),
        sql`${aiVectors.metadata}->>'label' LIKE ${`${SCALE_PREFIX}%`}`,
      ),
    );
  const existing = countRow?.n ?? 0;
  if (existing >= count) {
    // Louder than it looks: asking for 5 000 when 10 000 are already there is a
    // run whose corpus is twice its label. It returns the ACTUAL total so the
    // metadata records what was measured rather than what was requested, and
    // says so, because `--cleanup-scale` is the only way down.
    if (existing > count) {
      console.warn(
        `[recall-fixtures] scale: ${existing.toString()} distractors present but ${count.toString()} requested — this run measures ${existing.toString()}. Use --cleanup-scale to go back down.`,
      );
    }
    return { total: existing };
  }

  // Perturb REAL vectors, and several of them: one base would build a single
  // tight cluster, which an ANN index navigates quite differently from a corpus
  // spread over the manifold the way a team's documents are.
  //
  // The NOT LIKE is what keeps that true on the top-up path. This function is
  // resumable, so on a second call the distractors already outnumber the real
  // rows — without the exclusion the "real" bases would mostly be previous
  // distractors, and each round would perturb a perturbation. Two rounds of
  // sigma=0.02 compose to roughly sigma=0.028, three to 0.035, and the corpus
  // walks off the manifold `tests/unit/evals/scale-vectors.test.ts` exists to
  // pin — silently, because that test checks `perturb`, not what is fed to it.
  const bases = await db
    .select({ embedding: aiVectors.embedding })
    .from(aiVectors)
    .where(
      and(
        eq(aiVectors.teamId, scope.teamId),
        sql`${aiVectors.embedding} IS NOT NULL`,
        sql`coalesce(${aiVectors.metadata}->>'label', '') NOT LIKE ${`${SCALE_PREFIX}%`}`,
      ),
    )
    .limit(SCALE_BASES);
  const vectors = bases
    .map((b) => b.embedding)
    .filter((e): e is number[] => Array.isArray(e) && e.length > 0);
  if (vectors.length === 0) {
    throw new Error(
      "[recall-fixtures] scale: no real embedding to perturb — run the suite once without --scale first",
    );
  }

  const scaleCollectionId = await findTypeId(scope, SCALE_COLLECTION_KEY);
  if (!scaleCollectionId) {
    throw new Error(
      "[recall-fixtures] scale: fixture collection missing — ensureRecallFixtures runs first",
    );
  }

  const missing = count - existing;
  console.log(
    `[recall-fixtures] scale: ${existing.toString()} present, inserting ${missing.toString()} more from ${vectors.length.toString()} base vectors`,
  );
  let inserted = 0;
  while (inserted < missing) {
    const size = Math.min(SCALE_BATCH, missing - inserted);
    const rows = Array.from({ length: size }, (_, k) => {
      const index = existing + inserted + k;
      const base = vectors[index % vectors.length] ?? vectors[0] ?? [];
      const metadata: RecordVectorMetadata = {
        collection_id: scaleCollectionId,
        collection_key: SCALE_COLLECTION_KEY,
        label: `${SCALE_PREFIX}${index.toString()}`,
      };
      return {
        content: `Filler ${index.toString()} — volume row for the recall scale test.`,
        contextualPrefix: `Filler ${index.toString()}.`,
        chunkIndex: 0,
        totalChunks: 1,
        embedding: round(perturb(base, SCALE_SIGMA), SCALE_DECIMALS),
        metadata,
        sourceType: SCALE_SOURCE_TYPE,
        sourceId: crypto.randomUUID(),
        teamId: scope.teamId,
        organizationId: scope.organizationId,
      };
    });
    // Serial on purpose: each row inserts into an HNSW index, which is a graph
    // traversal per row. Firing the batches concurrently would multiply the
    // index's write contention rather than the throughput, and 500 rows is
    // ~12 MB on the wire per statement even rounded.
    // eslint-disable-next-line no-await-in-loop
    await db.insert(aiVectors).values(rows);
    inserted += size;
    console.log(
      `[recall-fixtures] scale: ${(existing + inserted).toString()}/${count.toString()}`,
    );
  }
  return { total: existing + inserted };
};

/**
 * Drop the scale distractors and nothing else (`--cleanup-scale`), leaving the
 * fixture universe intact so the suite still runs.
 */
export const cleanupScaleDistractors = async (scope: Scope): Promise<void> => {
  const deleted = await db
    .delete(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, SCALE_SOURCE_TYPE),
        eq(aiVectors.teamId, scope.teamId),
        sql`${aiVectors.metadata}->>'label' LIKE ${`${SCALE_PREFIX}%`}`,
      ),
    )
    .returning({ id: aiVectors.id });
  console.log(
    `[recall-fixtures] scale: ${deleted.length.toString()} distractor(s) removed`,
  );
};

/** Tear the whole fixture universe down (`--cleanup`). */
export const cleanupRecallFixtures = async (scope: Scope): Promise<void> => {
  // Episodes (+ vectors) — matched by our fixture titles.
  const episodes = await db.query.aiEpisodes.findMany({
    where: { teamId: scope.teamId },
    columns: { id: true, title: true },
  });
  const fixtureEpisodeIds = episodes
    .filter(
      (e) =>
        e.title.includes("Nordwind") ||
        e.title.includes("Benchmark tarifaire fournisseurs") ||
        e.title.includes("renégociation du bail Sirius") ||
        e.title.includes("Vega Logistics") ||
        e.title.includes("Callisto Systems"),
    )
    .map((e) => e.id);
  if (fixtureEpisodeIds.length > 0) {
    await deleteEpisodeVectors(fixtureEpisodeIds);
    await db
      .delete(aiEpisodes)
      .where(inArray(aiEpisodes.id, fixtureEpisodeIds));
  }

  // Memories (+ vectors).
  const memories = await db.query.aiMemories.findMany({
    where: {
      teamId: scope.teamId,
      path: {
        in: [
          "team/processes/recap-hebdo-fournisseurs.md",
          "team/processes/relances-fournisseurs.md",
        ],
      },
    },
    columns: { id: true },
  });
  for (const m of memories) {
    await deleteMemoryVectors(m.id);
    await db.delete(aiMemories).where(eq(aiMemories.id, m.id));
  }

  // Synthetic documents — vectors only (no document rows exist).
  await db
    .delete(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "documents"),
        eq(aiVectors.teamId, scope.teamId),
        sql`${aiVectors.metadata}->>'file_name' IN ('bail-sirius-lyon.pdf', 'charte-achats-responsables.pdf')`,
      ),
    );

  // …and the scale distractors, which the line above does NOT match (it lists
  // file names exactly). "Tear the whole universe down" has to include the
  // 50 000 rows a scale run left behind, or `--cleanup` quietly leaves the next
  // measurement standing on a corpus nobody remembers seeding.
  await cleanupScaleDistractors(scope);

  // Synthetic workflow cards — vectors only (no workflow rows exist).
  await db
    .delete(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "workflows"),
        eq(aiVectors.teamId, scope.teamId),
        sql`${aiVectors.metadata}->>'name' = 'Récap des livraisons fournisseurs en retard'`,
      ),
    );

  // Records (+ cards), then the fixture types (drops typed tables + link type).
  for (const key of [SUPPLIER_COLLECTION_KEY, PROJECT_COLLECTION_KEY]) {
    const typeId = await findTypeId(scope, key);
    if (!typeId) continue;
    const records = await db.query.collectionRecords.findMany({
      where: { teamId: scope.teamId, collectionId: typeId },
      columns: { id: true },
    });
    const ids = records.map((r) => r.id);
    for (const id of ids) await deleteRecordCardVectors(id);
    if (ids.length > 0) {
      await bulkDeleteCollectionRecords({ teamId: scope.teamId, ids });
    }
    await deleteCollection({ id: typeId });
  }
  console.log("[recall-fixtures] cleaned up");
};
