import { assertOperatorTarget } from "@fretik/shared/lib/operator-guard";
import { listDreamingTeams } from "@fretik/shared/services/episodes/dreaming-candidates";
import { runDigestRefresh } from "../workers/dreaming";

/**
 * Rewrite team digests now, in-process, without waiting for 03:00.
 *
 * The two reasons to reach for this: a digest reads wrong and someone needs it
 * corrected today (`--force`, since an unchanged fingerprint would otherwise
 * skip it), or a team has none yet and nobody wants to wait a night.
 *
 * Runs INLINE rather than enqueuing, so the operator sees each result instead
 * of a queue depth — the whole point of running it by hand is to read what came
 * back.
 *
 *   bun run digest:run -- --team <uuid> --org <uuid> [--force]
 *   bun run digest:run -- --all [--force] [--limit N]
 */

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const teamId = flag("team");
const organizationId = flag("org");
const all = argv.includes("--all");
const force = argv.includes("--force");
const limitRaw = Number.parseInt(flag("limit") ?? "", 10);
const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;

if (!all && (!teamId || !organizationId)) {
  console.error(
    "Usage: bun run digest:run -- --team <uuid> --org <uuid> [--force]\n" +
      "       bun run digest:run -- --all [--force] [--limit N]",
  );
  process.exit(1);
}

await assertOperatorTarget(Bun.argv);

// `--all` reuses the nightly cron's own team list rather than a second
// definition of "active team" — two answers to that question would drift, and
// the one that matters is the one the cron uses.
const targets = all
  ? (await listDreamingTeams()).slice(0, limit)
  : [{ teamId: teamId ?? "", organizationId: organizationId ?? "" }];

console.info(
  `[digest:run] ${targets.length.toString()} team(s), force=${String(force)}`,
);

for (const target of targets) {
  await runDigestRefresh({ ...target, ...(force ? { force: true } : {}) });
}

process.exit(0);
