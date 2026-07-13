import db from "@fretik/shared/db";
import type { RecordAnchor } from "@fretik/shared/services/object-records/anchor";

/**
 * Deterministic graph neighborhood of the records anchored in the user's
 * message (P5). Pure SQL — no LLM, no embeddings: active 1-hop `links`,
 * the anchors' most recent journal events, and the active episodes that
 * anchor on them. Rendered as compact lines the recall judge can lift
 * into the GRAPH section verbatim-ish, with provenance ids.
 *
 * Privacy: episode selection applies the same rule as `listEpisodes` —
 * team episodes (userId NULL) plus the caller's own private ones.
 */

const MAX_LINKS = 10;
const MAX_EVENTS_PER_ANCHOR = 5;
const MAX_EPISODES = 3;
/** Fetch ceiling before the per-anchor/top-N trims below. */
const EDGE_FETCH_LIMIT = 30;
/**
 * Recall-usage-weighted recency (MemoryBank-style): base rank is the
 * episode's last update, and each past recall is worth one day of extra
 * freshness — a repeatedly-recalled episode outranks a marginally newer one
 * that never surfaced. Deterministic; no LLM importance scalar (LUFY shows a
 * static importance score underperforms usage signals, and the recall judge
 * already scores relevance dynamically per query).
 */
const RECALL_BOOST_MS = 24 * 60 * 60 * 1000;

const episodeRankScore = (ep: {
  updatedAt: Date;
  recallCount: number;
}): number => ep.updatedAt.getTime() + ep.recallCount * RECALL_BOOST_MS;

export interface GraphEpisode {
  id: string;
  title: string;
  summary: string;
  occurredTo: Date | null;
  /**
   * Labels of the matched anchor records this episode is linked to — the
   * deterministic overlap proof. A 25-record episode's summary rarely
   * names every record, so without these labels the judge (correctly,
   * per its overlap rule) discards the episode as unrelated.
   */
  anchorLabels: string[];
}

export interface GraphNeighborhood {
  /** Pre-rendered lines for the judge prompt (empty string = nothing). */
  rendered: string;
  /**
   * Active episodes anchored on the matched records, WITH their summaries —
   * injected as first-class judge candidates so an episode about a record
   * named in the message never depends on the semantic arm's top-K roulette.
   */
  episodes: GraphEpisode[];
}

const day = (d: Date | null): string =>
  d ? d.toISOString().slice(0, 10) : "?";

export const gatherGraphNeighborhood = async (input: {
  anchors: RecordAnchor[];
  userId?: string;
}): Promise<GraphNeighborhood | null> => {
  if (input.anchors.length === 0) return null;
  const anchorIds = input.anchors.map((a) => a.recordId);

  const [links, subjectEvents, linkedEvents, episodeEdges] = await Promise.all([
    db.query.links.findMany({
      where: {
        invalidatedAt: { isNull: true },
        OR: [
          { fromRecordId: { in: anchorIds } },
          { toRecordId: { in: anchorIds } },
        ],
      },
      with: {
        linkType: { columns: { label: true } },
        fromRecord: { columns: { id: true, label: true } },
        toRecord: { columns: { id: true, label: true } },
      },
      orderBy: { createdAt: "desc" },
      limit: MAX_LINKS,
    }),
    db.query.domainEvents.findMany({
      where: { subjectRecordId: { in: anchorIds } },
      columns: {
        id: true,
        type: true,
        recordedAt: true,
        subjectRecordId: true,
      },
      orderBy: { id: "desc" },
      limit: EDGE_FETCH_LIMIT,
    }),
    db.query.domainEventLinks.findMany({
      where: { recordId: { in: anchorIds }, status: "confirmed" },
      columns: { recordId: true },
      with: {
        event: { columns: { id: true, type: true, recordedAt: true } },
      },
      limit: EDGE_FETCH_LIMIT,
    }),
    db.query.aiEpisodeRecords.findMany({
      where: { recordId: { in: anchorIds } },
      columns: { recordId: true },
      with: { episode: true },
      limit: EDGE_FETCH_LIMIT,
    }),
  ]);

  // Merge subject + linked events per anchor, most recent first, top 5.
  const eventsByAnchor = new Map<
    string,
    { type: string; recordedAt: Date | null }[]
  >();
  const pushEvent = (
    recordId: string,
    e: { type: string; recordedAt: Date | null },
  ): void => {
    const list = eventsByAnchor.get(recordId) ?? [];
    list.push(e);
    eventsByAnchor.set(recordId, list);
  };
  for (const e of subjectEvents) {
    if (e.subjectRecordId) pushEvent(e.subjectRecordId, e);
  }
  for (const l of linkedEvents) {
    if (l.event) pushEvent(l.recordId, l.event);
  }
  for (const [recordId, list] of eventsByAnchor) {
    list.sort(
      (a, b) => (b.recordedAt?.getTime() ?? 0) - (a.recordedAt?.getTime() ?? 0),
    );
    eventsByAnchor.set(recordId, list.slice(0, MAX_EVENTS_PER_ANCHOR));
  }

  // Active episodes anchoring on these records — team ones + the caller's own.
  const labelByAnchor = new Map(
    input.anchors.map((a) => [a.recordId, a.label]),
  );
  const episodes = new Map<string, GraphEpisode & { rankScore: number }>();
  for (const edge of episodeEdges) {
    const ep = edge.episode;
    if (!ep || ep.state !== "active") continue;
    if (ep.userId !== null && ep.userId !== input.userId) continue;
    const anchorLabel = labelByAnchor.get(edge.recordId);
    const existing = episodes.get(ep.id);
    if (existing) {
      if (anchorLabel && !existing.anchorLabels.includes(anchorLabel)) {
        existing.anchorLabels.push(anchorLabel);
      }
      continue;
    }
    episodes.set(ep.id, {
      id: ep.id,
      title: ep.title,
      summary: ep.summary,
      occurredTo: ep.occurredTo,
      anchorLabels: anchorLabel ? [anchorLabel] : [],
      rankScore: episodeRankScore(ep),
    });
  }
  const topEpisodes = [...episodes.values()]
    .sort((a, b) => b.rankScore - a.rankScore)
    .slice(0, MAX_EPISODES);

  const lines: string[] = [];
  for (const anchor of input.anchors) {
    lines.push(`- ${anchor.label} (record:${anchor.recordId})`);
    for (const link of links) {
      const fromId = link.fromRecord?.id;
      const toId = link.toRecord?.id;
      if (fromId !== anchor.recordId && toId !== anchor.recordId) continue;
      const from = link.fromRecord?.label ?? "?";
      const to = link.toRecord?.label ?? "?";
      // Surface the NEIGHBOUR's id (the endpoint that isn't the anchor) —
      // the anchor's id is already on its own line and is what the message
      // referred to; the whole value of surfacing an edge is letting the
      // agent drill into the LINKED record, which needs the neighbour's id.
      const neighbourId = fromId === anchor.recordId ? toId : fromId;
      const idTag = neighbourId ? ` (record:${neighbourId})` : "";
      // Bi-temporal edges (temporal link types) carry a validity interval —
      // render it Zep-style so the judge can date the relationship and the
      // agent reasons over "when was this true". NULL validFrom = atemporal
      // link, no interval.
      const interval = link.validFrom
        ? ` (${day(link.validFrom)} → ${link.validTo ? day(link.validTo) : "present"})`
        : "";
      // Qualify AI-inferred edges still in the review band so the judge/agent
      // weighs them as unconfirmed (P8.4). Confirmed edges carry no marker.
      const band = link.status === "suggested" ? " (suggested)" : "";
      lines.push(
        `  · ${from} —${link.linkType?.label ?? "linked"}→ ${to}${idTag}${interval}${band}`,
      );
    }
    const recent = eventsByAnchor.get(anchor.recordId);
    if (recent && recent.length > 0) {
      // Carry the anchor's own marker inline: every renderable graph line is
      // self-contained, so the judge copies a real id, never the section
      // header text ("graph neighborhood") as a stray provenance.
      lines.push(
        `  · recent: ${recent.map((e) => `${e.type} ${day(e.recordedAt)}`).join(", ")} (record:${anchor.recordId})`,
      );
    }
  }
  return {
    rendered: lines.join("\n"),
    episodes: topEpisodes.map(({ rankScore: _rankScore, ...ep }) => ep),
  };
};
