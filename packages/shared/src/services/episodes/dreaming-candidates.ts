import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  max,
  sql,
} from "drizzle-orm";
import db from "../../db";
import { domainEvents } from "../../db/schema";

/**
 * Candidate discovery for the nightly "dreaming" consolidation cron (P6).
 * One cohesive query surface, consumed by @fretik/jobs (which has no direct
 * drizzle-orm dependency — aggregates and clustering live here). Every
 * function is read-only; the cron owns ordering, capping, and the LLM calls.
 */

/** Teams with journal activity in the last 24h — the dreaming fan-out set. */
export const listDreamingTeams = async (): Promise<
  { teamId: string; organizationId: string }[]
> =>
  db
    .selectDistinct({
      teamId: domainEvents.teamId,
      organizationId: domainEvents.organizationId,
    })
    .from(domainEvents)
    .where(gt(domainEvents.recordedAt, sql`now() - interval '24 hours'`));

/**
 * Distill safety net: conversations with a `chat.turn` in the last 24h whose
 * active episode is missing or older than the last turn — the debounced
 * distill job was lost (worker down, remove-on-running edge) or never ran.
 */
export const listStaleConversationDistills = async (input: {
  teamId: string;
  limit: number;
}): Promise<{ conversationId: string }[]> => {
  const turns = await db
    .select({
      conversationId: domainEvents.conversationId,
      lastTurnAt: max(domainEvents.recordedAt),
    })
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.teamId, input.teamId),
        eq(domainEvents.type, "chat.turn"),
        isNotNull(domainEvents.conversationId),
        gt(domainEvents.recordedAt, sql`now() - interval '24 hours'`),
      ),
    )
    .groupBy(domainEvents.conversationId)
    .limit(input.limit * 4);

  const byConversation = new Map<string, Date>();
  for (const t of turns) {
    if (t.conversationId && t.lastTurnAt) {
      byConversation.set(t.conversationId, t.lastTurnAt);
    }
  }
  if (byConversation.size === 0) return [];

  const episodes = await db.query.aiEpisodes.findMany({
    where: {
      kind: "conversation",
      state: "active",
      conversationId: { in: [...byConversation.keys()] },
    },
    columns: { conversationId: true, updatedAt: true },
  });
  const freshUntil = new Map<string, Date>();
  for (const e of episodes) {
    if (e.conversationId) freshUntil.set(e.conversationId, e.updatedAt);
  }

  const stale: { conversationId: string }[] = [];
  for (const [conversationId, lastTurnAt] of byConversation) {
    const episodeAt = freshUntil.get(conversationId);
    if (!episodeAt || episodeAt < lastTurnAt) stale.push({ conversationId });
    if (stale.length >= input.limit) break;
  }
  return stale;
};

/**
 * Records busy enough for a `record_activity` digest: ≥ `minEvents` subject
 * events inside the window AND something new since the current digest
 * (episode missing or older than the last event) — an unchanged record costs
 * zero LLM calls night after night. Busiest first, so the per-team cap keeps
 * the highest-signal digests.
 */
export const listRecordActivityCandidates = async (input: {
  teamId: string;
  minEvents: number;
  windowDays: number;
  limit: number;
}): Promise<{ recordId: string; eventCount: number }[]> => {
  const eventCount = count(domainEvents.id);
  const rows = await db
    .select({
      recordId: domainEvents.subjectRecordId,
      eventCount,
      lastEventAt: max(domainEvents.recordedAt),
    })
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.teamId, input.teamId),
        isNotNull(domainEvents.subjectRecordId),
        gt(
          domainEvents.recordedAt,
          sql`now() - make_interval(days => ${input.windowDays})`,
        ),
      ),
    )
    .groupBy(domainEvents.subjectRecordId)
    .having(gte(eventCount, input.minEvents))
    .orderBy(desc(eventCount))
    .limit(input.limit * 4);

  const byRecord = new Map<string, { eventCount: number; lastEventAt: Date }>();
  for (const r of rows) {
    if (r.recordId && r.lastEventAt) {
      byRecord.set(r.recordId, {
        eventCount: r.eventCount,
        lastEventAt: r.lastEventAt,
      });
    }
  }
  if (byRecord.size === 0) return [];

  const digests = await db.query.aiEpisodes.findMany({
    where: {
      kind: "record_activity",
      state: "active",
      anchorRecordId: { in: [...byRecord.keys()] },
    },
    columns: { anchorRecordId: true, updatedAt: true },
  });
  const digestAt = new Map<string, Date>();
  for (const d of digests) {
    if (d.anchorRecordId) digestAt.set(d.anchorRecordId, d.updatedAt);
  }

  const candidates: { recordId: string; eventCount: number }[] = [];
  for (const [recordId, { eventCount: n, lastEventAt }] of byRecord) {
    const existing = digestAt.get(recordId);
    if (!existing || existing < lastEventAt) {
      candidates.push({ recordId, eventCount: n });
    }
    if (candidates.length >= input.limit) break;
  }
  return candidates;
};

export interface ConsolidationCluster {
  /** Visibility scope — null = team episodes, set = one user's private ones. */
  userId: string | null;
  /** ≥2 active episode ids sharing at least one anchored record. */
  episodeIds: string[];
}

/**
 * Eager consolidation (P8.3): the cluster overlapping ONE just-distilled
 * episode, so a contradiction across conversations is caught within the
 * distill debounce (~35 min) instead of waiting for the nightly cron. Same
 * rules as `listConsolidationClusters` but seeded from a single episode:
 * active `conversation` / `consolidated` episodes ≤ `windowDays` old sharing
 * ≥1 record with the seed, in the SEED's visibility scope. Returns null when
 * the seed has no records or fewer than 2 members overlap (nothing to judge).
 * Most-recent-first, capped at `maxClusterSize`, seed always included.
 */
export interface PromotionCandidate {
  /** The record the episodes recur around — the promotion's topical seed. */
  recordId: string;
  /** Visibility scope of the episodes (null = team, set = one user's private). */
  userId: string | null;
  episodeIds: string[];
}

/**
 * Promotion candidates (P8.5): records that anchor ≥ `minEpisodes` active
 * `conversation`/`consolidated` episodes within the window — a recurrence
 * signal that a durable, generalizable fact about that entity may be worth
 * promoting from episodic memory to the semantic store (`ai_memories`).
 * Grouped by visibility scope (never mixes team + private). Busiest first,
 * capped. The promotion service owns the LLM extraction + the ADD/UPDATE/NOOP
 * dedup gate; this only surfaces where to look.
 */
export const listPromotionCandidates = async (input: {
  teamId: string;
  minEpisodes: number;
  windowDays: number;
  limit: number;
}): Promise<PromotionCandidate[]> => {
  const since = new Date(Date.now() - input.windowDays * 24 * 60 * 60 * 1000);
  const episodes = await db.query.aiEpisodes.findMany({
    where: {
      teamId: input.teamId,
      state: "active",
      kind: { in: ["conversation", "consolidated"] },
      updatedAt: { gt: since },
    },
    columns: { id: true, userId: true },
    with: { episodeRecords: { columns: { recordId: true } } },
  });

  const byScopedRecord = new Map<
    string,
    { recordId: string; userId: string | null; episodeIds: Set<string> }
  >();
  for (const e of episodes) {
    for (const { recordId } of e.episodeRecords) {
      const key = `${e.userId ?? "team"}:${recordId}`;
      const group = byScopedRecord.get(key) ?? {
        recordId,
        userId: e.userId,
        episodeIds: new Set<string>(),
      };
      group.episodeIds.add(e.id);
      byScopedRecord.set(key, group);
    }
  }

  return [...byScopedRecord.values()]
    .filter((g) => g.episodeIds.size >= input.minEpisodes)
    .sort((a, b) => b.episodeIds.size - a.episodeIds.size)
    .slice(0, input.limit)
    .map((g) => ({
      recordId: g.recordId,
      userId: g.userId,
      episodeIds: [...g.episodeIds],
    }));
};

export const listOverlappingCluster = async (input: {
  episodeId: string;
  windowDays: number;
  maxClusterSize: number;
}): Promise<ConsolidationCluster | null> => {
  const seed = await db.query.aiEpisodes.findFirst({
    where: {
      id: input.episodeId,
      state: "active",
      kind: { in: ["conversation", "consolidated"] },
    },
    columns: { id: true, userId: true, updatedAt: true },
    with: { episodeRecords: { columns: { recordId: true } } },
  });
  if (!seed) return null;
  const recordIds = seed.episodeRecords.map((r) => r.recordId);
  if (recordIds.length === 0) return null;

  const since = new Date(Date.now() - input.windowDays * 24 * 60 * 60 * 1000);
  const edges = await db.query.aiEpisodeRecords.findMany({
    where: { recordId: { in: recordIds } },
    columns: { episodeId: true },
    with: {
      episode: {
        columns: {
          id: true,
          userId: true,
          state: true,
          kind: true,
          updatedAt: true,
        },
      },
    },
  });

  const members = new Map<string, Date>([[seed.id, seed.updatedAt]]);
  for (const edge of edges) {
    const ep = edge.episode;
    if (!ep || ep.id === seed.id) continue;
    if (ep.state !== "active") continue;
    if (ep.kind !== "conversation" && ep.kind !== "consolidated") continue;
    if (ep.userId !== seed.userId) continue; // never cross a visibility scope
    if (ep.updatedAt < since) continue;
    members.set(ep.id, ep.updatedAt);
  }
  if (members.size < 2) return null;

  const episodeIds = [...members.entries()]
    .sort((a, b) => b[1].getTime() - a[1].getTime())
    .slice(0, input.maxClusterSize)
    .map(([id]) => id);
  return { userId: seed.userId, episodeIds };
};

/**
 * Consolidation-judge input: connected components of active `conversation` /
 * `consolidated` episodes (≤ `windowDays` old) sharing ≥1 anchored record,
 * never crossing a visibility scope (team ↔ private, or two users).
 * `record_activity` digests are excluded — they are ROLLING summaries keyed
 * by record; merging one away would only make the next night recreate it.
 * Oversized components keep their `maxClusterSize` most recent members.
 */
export const listConsolidationClusters = async (input: {
  teamId: string;
  windowDays: number;
  maxClusterSize: number;
  limit: number;
}): Promise<ConsolidationCluster[]> => {
  const since = new Date(Date.now() - input.windowDays * 24 * 60 * 60 * 1000);
  const episodes = await db.query.aiEpisodes.findMany({
    where: {
      teamId: input.teamId,
      state: "active",
      kind: { in: ["conversation", "consolidated"] },
      updatedAt: { gt: since },
    },
    columns: { id: true, userId: true, updatedAt: true },
    with: { episodeRecords: { columns: { recordId: true } } },
  });

  // Union-find over shared records, scoped by visibility.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    parent.set(find(a), find(b));
  };

  const updatedAtOf = new Map<string, Date>();
  const scopeOf = new Map<string, string | null>();
  const byScopedRecord = new Map<string, string>();
  for (const e of episodes) {
    parent.set(e.id, e.id);
    updatedAtOf.set(e.id, e.updatedAt);
    scopeOf.set(e.id, e.userId);
    for (const { recordId } of e.episodeRecords) {
      const key = `${e.userId ?? "team"}:${recordId}`;
      const prior = byScopedRecord.get(key);
      if (prior) union(e.id, prior);
      else byScopedRecord.set(key, e.id);
    }
  }

  const components = new Map<string, string[]>();
  for (const e of episodes) {
    const root = find(e.id);
    const members = components.get(root) ?? [];
    members.push(e.id);
    components.set(root, members);
  }

  const clusters: ConsolidationCluster[] = [];
  for (const members of components.values()) {
    if (members.length < 2) continue;
    members.sort(
      (a, b) =>
        (updatedAtOf.get(b)?.getTime() ?? 0) -
        (updatedAtOf.get(a)?.getTime() ?? 0),
    );
    clusters.push({
      userId: scopeOf.get(members[0] ?? "") ?? null,
      episodeIds: members.slice(0, input.maxClusterSize),
    });
  }
  clusters.sort((a, b) => b.episodeIds.length - a.episodeIds.length);
  return clusters.slice(0, input.limit);
};
