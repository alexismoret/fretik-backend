import db from "@fretik/shared/db";

/**
 * Read-only audit of what the memory system wrote ON ITS OWN — the "measure"
 * half of the minimal governance net (the "undo" half is
 * /internal/memory/unsupersede-episodes, `invalidateLink`, `deleteMemory`).
 *
 * Prints every system-actor journal entry of the memory families over a
 * window, with its payload — the payload IS the provenance (superseded ids,
 * episode ids, titles). No writes, no LLM calls.
 *
 *   bun run memory:audit                          # all teams, last 7 days
 *   bun run memory:audit -- --team <id> --days 30
 */

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};

const teamId = opt("--team");
const daysRaw = Number.parseInt(opt("--days") ?? "", 10);
const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 7;
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/** The families an autonomous memory pass can write. */
const MEMORY_EVENT_PREFIXES = ["episode.", "memory.", "link."] as const;

const events = await db.query.domainEvents.findMany({
  where: {
    actorType: "system",
    recordedAt: { gt: since },
    ...(teamId ? { teamId } : {}),
  },
  orderBy: { recordedAt: "asc" },
});
const memoryEvents = events.filter((e) =>
  MEMORY_EVENT_PREFIXES.some((p) => e.type.startsWith(p)),
);

console.info(
  `[memory-audit] ${memoryEvents.length.toString()} autonomous memory write(s) over ${days.toString()}d${teamId ? ` (team ${teamId})` : ""}`,
);

const byType = new Map<string, number>();
for (const e of memoryEvents) {
  byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
}
for (const [type, count] of [...byType.entries()].sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  console.info(`  ${type}: ${count.toString()}`);
}

console.info("");
for (const e of memoryEvents) {
  const payload = JSON.stringify(e.payload).slice(0, 220);
  console.info(
    `${e.recordedAt.toISOString()} ${e.type} team=${e.teamId} ${payload}`,
  );
}
process.exit(0);
