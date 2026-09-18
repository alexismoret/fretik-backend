/**
 * Rewrite the episodes the old per-message clip got wrong.
 *
 *     bun run repair:clipped-episodes                     # dry run, changes nothing
 *     bun run repair:clipped-episodes -- --apply
 *
 * ## What it repairs
 *
 * Until 2026-09-18 the distiller clipped EVERY message of a conversation to its
 * first 500 characters before applying its 12 000-character budget. Measured
 * over 30 days of production, that clip bit on 95 % of workflow messages and
 * 51 % of chat ones, and the distiller saw 17.6 % of a run's narration — while
 * using 9 % of the budget it was already allowed.
 *
 * The damage is not "a thinner summary". A run of `Export EDI Fatton` finished
 * **succeeded**, five files produced and acknowledged, and its episode records
 * *"les tâches `generer-fichiers` et `upload-ftp` restent à exécuter"* — the cut
 * landed mid-sentence and the model read the end of its input as the end of the
 * work. That sentence is now a durable memory, retrieved and believed.
 *
 * ## Why a script at all
 *
 * Nothing re-distils on its own. `listStaleConversationDistills` only considers
 * conversations with a `chat.turn` in the last 24 HOURS, and only when the
 * episode is older than the last turn — so a conversation that has gone quiet
 * keeps whatever was written about it, forever. Measured at the time of
 * writing: 238 active conversation episodes, 20 conversations the nightly sweep
 * can still reach.
 *
 * ## What it does NOT re-distil
 *
 * Only the episodes the clip could have changed. For each one it rebuilds the
 * transcript twice — once the way the service renders it today, once the way it
 * rendered it under the clip — from the same rows, through the same
 * `toTranscriptLines`. Identical means the summary was written from the whole
 * conversation already, and re-running the model would buy a different wording
 * and nothing else. Skipped.
 *
 * ## Resuming, and running it twice
 *
 * `--before` is the cutoff on the episode's `updated_at`, and it defaults to
 * the moment this run starts. A re-distilled episode is stamped NOW, so it
 * falls outside that cutoff — which is what makes an interrupted run resumable
 * and a completed one a no-op. Re-run with the SAME `--before` the first run
 * printed; a fresh default would redo work that is already correct.
 *
 * Sequential on purpose. It is one LLM call plus one embedding per episode,
 * with nobody waiting on it, and a serial pass is the one that stays cheap to
 * interrupt: whatever it finished is committed, and the cutoff makes the rest
 * exact.
 */
import db from "@fretik/shared/db";
import { aiEpisodes, aiMessages } from "@fretik/shared/db/schema";
import { assertOperatorTarget } from "@fretik/shared/lib/operator-guard";
import { getLiveSnapshotSync } from "@fretik/shared/services/model-registry/live";
import { and, asc, desc, eq, isNotNull, lt } from "drizzle-orm";
import process from "node:process";
import { ensureModelRegistryWarm } from "../src/lib/model-registry/resolve";
import {
  distillConversation,
  renderTranscript,
  toTranscriptLines,
} from "../src/services/memory/distill-conversation";

/** The two numbers as they were until 2026-09-18. Dead constants everywhere
 *  else — they exist here only to answer "would this episode have differed?",
 *  and they must never be re-imported from the service, which no longer has
 *  them. */
const LEGACY_MESSAGE_CHARS = 500;
const LEGACY_TRANSCRIPT_CHARS = 12_000;
/** Same row cap as the distiller — the window has not changed. */
const MAX_MESSAGES = 60;

const argv: string[] = Bun.argv;
const has = (name: string): boolean => argv.includes(name);
const opt = (name: string): string | undefined => {
  const hit = argv.find((a: string) => a.startsWith(`${name}=`));
  return hit?.slice(name.length + 1);
};

const apply = has("--apply");
const limitRaw = opt("--limit");
const limit =
  limitRaw === undefined ? undefined : Number.parseInt(limitRaw, 10);
const beforeRaw = opt("--before");
const before = beforeRaw === undefined ? new Date() : new Date(beforeRaw);
if (Number.isNaN(before.getTime())) {
  throw new Error(`--before is not a date: "${beforeRaw ?? ""}"`);
}
if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
  throw new Error(
    `--limit must be a positive integer, got "${limitRaw ?? ""}"`,
  );
}

await assertOperatorTarget(argv);

/** The transcript as the service rendered it BEFORE the fix. */
const renderLegacy = (
  lines: { role: "user" | "assistant"; text: string }[],
): string => {
  const rendered = lines.map(
    (l) =>
      `${l.role === "user" ? "User" : "Assistant"}: ${l.text.slice(0, LEGACY_MESSAGE_CHARS)}`,
  );
  let total = 0;
  const kept: string[] = [];
  for (let i = rendered.length - 1; i >= 0; i--) {
    const line = rendered[i];
    if (line === undefined) continue;
    if (total + line.length > LEGACY_TRANSCRIPT_CHARS) break;
    total += line.length;
    kept.unshift(line);
  }
  return kept.join("\n\n");
};

const episodes = await db
  .select({
    id: aiEpisodes.id,
    conversationId: aiEpisodes.conversationId,
    title: aiEpisodes.title,
    updatedAt: aiEpisodes.updatedAt,
    teamId: aiEpisodes.teamId,
    organizationId: aiEpisodes.organizationId,
  })
  .from(aiEpisodes)
  .where(
    and(
      eq(aiEpisodes.kind, "conversation"),
      eq(aiEpisodes.state, "active"),
      isNotNull(aiEpisodes.conversationId),
      lt(aiEpisodes.updatedAt, before),
    ),
  )
  .orderBy(asc(aiEpisodes.updatedAt));

console.log(
  `\n${episodes.length.toString()} active conversation episodes written before ${before.toISOString()}`,
);

interface Candidate {
  episodeId: string;
  conversationId: string;
  title: string;
  teamId: string;
  organizationId: string;
  seenBefore: number;
  seenAfter: number;
}

const candidates: Candidate[] = [];
let unchanged = 0;
let gone = 0;

for (const ep of episodes) {
  const conversationId = ep.conversationId;
  if (conversationId === null) continue;
  const conversation = await db.query.aiConversations.findFirst({
    where: { id: conversationId },
    columns: { agentType: true },
  });
  if (!conversation) {
    gone += 1;
    continue;
  }
  const rows = await db
    .select({
      role: aiMessages.role,
      parts: aiMessages.parts,
      metadata: aiMessages.metadata,
    })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(desc(aiMessages.seq))
    .limit(MAX_MESSAGES);
  rows.reverse();
  const lines = toTranscriptLines(rows, conversation.agentType === "workflow");
  const legacy = renderLegacy(lines);
  const current = renderTranscript(lines);
  if (legacy === current) {
    unchanged += 1;
    continue;
  }
  candidates.push({
    episodeId: ep.id,
    conversationId,
    title: ep.title,
    teamId: ep.teamId,
    organizationId: ep.organizationId,
    seenBefore: legacy.length,
    seenAfter: current.length,
  });
}

console.log(
  `  ${candidates.length.toString()} written from a clipped transcript · ${unchanged.toString()} already whole · ${gone.toString()} whose conversation is gone\n`,
);

if (candidates.length === 0) {
  console.log("Nothing to repair.");
  process.exit(0);
}

const shown = limit === undefined ? candidates : candidates.slice(0, limit);
for (const c of shown) {
  const pct = Math.round((c.seenBefore / Math.max(1, c.seenAfter)) * 100);
  console.log(
    `  ${c.seenBefore.toString().padStart(6)} → ${c.seenAfter.toString().padStart(6)} chars (${pct.toString().padStart(3)} % was seen)  ${c.title.slice(0, 70)}`,
  );
}

if (!apply) {
  console.log(
    [
      ``,
      `Dry run — nothing was written. To repair ${shown.length.toString()} episode(s):`,
      ``,
      `  bun run repair:clipped-episodes -- --apply --before=${before.toISOString()}${limitRaw === undefined ? "" : ` --limit=${limitRaw}`}`,
      ``,
      `Pass that same --before when resuming: a repaired episode is stamped now,`,
      `so it drops out of the cutoff and a second pass skips it.`,
    ].join("\n"),
  );
  process.exit(0);
}

// The registry is PROCESS state, and a script is a process nothing warmed.
//
// `getLiveStateSync` is synchronous by design — model construction cannot await
// — so a cold snapshot does not reload on demand, it answers `undefined` for
// every key. The distiller then throws `No model profile for key
// "deepseek-v4-flash"` about a row that is published, enabled and healthy, and
// because `resolveModelForTeam` catches that and falls back to the SAME code
// default, it throws twice per episode. Measured 2026-09-18 on the first
// production run of this script: 238 identical failures, and the dry run could
// not have caught it — it resolves no model at all.
//
// `ensureModelRegistryWarm` is the door, and it is a no-op once warm. The
// check below is what turns a cold registry into one refusal instead of one per
// episode: an empty map is a real state that `ensureModelRegistryWarm` leaves
// alone by design, so warming is not proof that anything is in there.
await ensureModelRegistryWarm();
if (getLiveSnapshotSync() === undefined) {
  throw new Error(
    "The model registry is cold — every episode would fail to resolve a model. Check the database is reachable, then `bun run models:sync` (jobs package) if it is a fresh one.",
  );
}

let repaired = 0;
let skipped = 0;
let failed = 0;
for (const [i, c] of shown.entries()) {
  const at = `[${(i + 1).toString()}/${shown.length.toString()}]`;
  try {
    const result = await distillConversation({
      conversationId: c.conversationId,
      teamId: c.teamId,
      organizationId: c.organizationId,
    });
    if (result.distilled) {
      repaired += 1;
      console.log(
        `${at} repaired ${c.conversationId} → ${result.episodeId ?? "?"}`,
      );
    } else {
      // Below the message floor, or the model returned nothing parsable. The
      // OLD episode stays — a stale summary beats none, and the next pass
      // retries it.
      skipped += 1;
      console.log(`${at} skipped  ${c.conversationId} (not distilled)`);
    }
  } catch (err) {
    failed += 1;
    console.warn(
      `${at} FAILED   ${c.conversationId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

console.log(
  `\nrepaired ${repaired.toString()} · skipped ${skipped.toString()} · failed ${failed.toString()}`,
);
if (failed > 0 || skipped > 0) {
  console.log(
    `Re-run with --before=${before.toISOString()} to retry only what did not land.`,
  );
}
process.exit(0);
