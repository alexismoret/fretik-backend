/**
 * Find — and only if you say so, delete — S3 objects whose owner no longer
 * exists in Postgres.
 *
 *     bun run s3:sweep                      # report only, changes nothing
 *     bun run s3:sweep -- --delete          # actually delete
 *     bun run s3:sweep -- --prefix sessions # one family at a time
 *     bun run s3:sweep -- --min-age-hours 1 # default is 24
 *
 * ENVIRONMENT. This package has no `.env` of its own, and the repo keeps
 * one per service, so `s3:sweep` passes bun three `--env-file`s — the repo
 * root, this package, then `packages/api/`. Bun ignores the ones that do
 * not exist and lets a later file win a shared key, so whichever layout is
 * in use is picked up without configuration. Anywhere else, call bun
 * yourself; `--env-file` must come BEFORE `run`, and `bun run s3:sweep --
 * --env-file=…` will not work because everything after `--` goes to the
 * script:
 *
 *     bun --env-file=../api/.env run src/scripts/sweep-orphan-s3.ts
 *
 * AGE. `--min-age-hours` is a floor on how RECENT an object may be, not a
 * window to look back through: the default sweeps everything older than a
 * day, however old, and excludes only the last 24 hours. `0` removes even
 * that exclusion — see the grace-window note below before reaching for it.
 *
 * WHY THESE EXIST. Deleting a conversation used to reap only the objects
 * sitting at the root of its session folder: `deleteSessionFolder` listed
 * through `listSessionFiles`, which drops every key containing a `/`, and
 * since the move to a per-conversation workspace that is nearly all of
 * them. Every `attachments/…` and `outputs/…` object of every conversation
 * deleted before that fix is still in the bucket, and agent outputs have
 * no row anywhere — so nothing in Postgres can enumerate them. This script
 * is how you find them: from the bucket side, by asking whether the owner
 * named in the key still exists.
 *
 * It also covers the families the audit found leaking for other reasons —
 * documents orphaned by a folder-delete cascade, context files whose
 * profile went with its team, avatars and logos nobody ever deleted.
 *
 * WHAT IT WILL NOT DO, by construction:
 *
 *  - Delete anything without `--delete`. The default run writes nothing.
 *  - Delete an object whose key it does not RECOGNISE. Every family below
 *    parses an owner id out of the key; a key that does not match is
 *    reported as unrecognised and kept. A sweeper that deletes what it
 *    cannot explain is a data-loss incident waiting for a rename.
 *  - Delete an object younger than `--min-age-hours` (24 by default).
 *    `uploadDocument` writes the bytes BEFORE it inserts the row, so an
 *    upload in flight looks exactly like an orphan. This window is the
 *    only thing standing between the two.
 *  - Run at all if a table it needs comes back empty while the bucket has
 *    objects. An empty id set makes everything look orphaned, and the
 *    likeliest cause is pointing at the wrong database. Override with
 *    `--allow-empty` only when you know the table really is empty.
 *
 * It is a SCRIPT, not a cron. Read the report, then decide.
 */

import {
  classifyObject,
  documentOwner,
  firstSegmentOwner,
  publicImageOwner,
} from "../lib/s3-orphans";

// ==================== //
// ENVIRONMENT          //
// ==================== //

/**
 * Checked BEFORE `../db` and `../lib/s3` are loaded, which is why those two
 * are imported dynamically below.
 *
 * Both throw at module scope when their variables are missing, and
 * `lib/s3`'s message is "Missing S3 env vars" — true, and useless to
 * somebody who ran the documented command and does not know the script
 * reads an env file at all, let alone which one. An operator script's
 * first failure should name its own fix.
 */
const REQUIRED_ENV = [
  "DATABASE_URL",
  "S3_BUCKET",
  "S3_URL",
  "S3_REGION",
  "SCW_ACCESS_KEY",
  "SCW_SECRET_KEY",
] as const;

const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error(`Missing environment: ${missingEnv.join(", ")}.`);
  console.error(
    "\n`bun run s3:sweep` reads the first .env it finds among the repo root,",
  );
  console.error(
    "packages/shared/ and packages/api/. To point somewhere else, call bun",
  );
  console.error("directly — the flag has to come BEFORE `run`:\n");
  console.error(
    "    bun --env-file=../api/.env run src/scripts/sweep-orphan-s3.ts\n",
  );
  console.error(
    "(`bun run s3:sweep -- --env-file=…` does NOT work: everything after",
  );
  console.error("`--` is passed to the script, not to bun.)");
  process.exit(2);
}

const { default: db } = await import("../db");
const { aiContextProfiles, aiConversations, documents, organization, user } =
  await import("../db/schema");
const { deleteObjects, listObjectsDetailed } = await import("../lib/s3");

// ==================== //
// ARGUMENTS            //
// ==================== //

const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const valueOf = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const DELETE = has("--delete");
const ALLOW_EMPTY = has("--allow-empty");
const MIN_AGE_HOURS = Number(valueOf("--min-age-hours") ?? "24");
const ONLY = valueOf("--prefix");

if (!Number.isFinite(MIN_AGE_HOURS) || MIN_AGE_HOURS < 0) {
  console.error("--min-age-hours must be a non-negative number.");
  process.exit(2);
}

const cutoff = new Date(Date.now() - MIN_AGE_HOURS * 60 * 60 * 1000);

// ==================== //
// FAMILIES             //
// ==================== //

/**
 * One S3 key family: where it lives, who owns it, and how to read the
 * owner out of a key.
 */
interface Family {
  /** `--prefix` selector. */
  name: string;
  prefix: string;
  /** Every id of this kind currently in Postgres. */
  liveIds: () => Promise<string[]>;
  /**
   * The owning id encoded in this key, or null when the shape is not one
   * this family knows — in which case the object is KEPT and reported.
   */
  ownerOf: (key: string) => string | null;
}

/**
 * Read a set of ids, or stop the run.
 *
 * A failed query must never reach the classifier: an empty id set makes
 * every object look orphaned, so "the database is unreachable" and
 * "nothing owns any of this" would become the same answer. Postgres
 * throwing is the one thing this script treats as fatal.
 */
const readIds = async (
  what: string,
  query: () => Promise<{ id: string }[]>,
): Promise<string[]> => {
  try {
    return (await query()).map((row) => row.id);
  } catch (err) {
    console.error(
      `\nCould not read ${what} from Postgres: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "   Nothing was deleted. Check DATABASE_URL and that the database is reachable.",
    );
    process.exit(1);
  }
};

let liveUserIds = new Set<string>();
let liveOrgIds = new Set<string>();

const FAMILIES: Family[] = [
  {
    name: "sessions",
    prefix: "chatbot-sessions/",
    liveIds: () =>
      readIds("conversations", () =>
        db.select({ id: aiConversations.id }).from(aiConversations),
      ),
    ownerOf: firstSegmentOwner("chatbot-sessions/"),
  },
  {
    name: "documents",
    prefix: "documents/",
    liveIds: () =>
      readIds("documents", () =>
        db.select({ id: documents.id }).from(documents),
      ),
    ownerOf: documentOwner,
  },
  {
    name: "context",
    prefix: "ai-context/",
    liveIds: () =>
      readIds("context profiles", () =>
        db.select({ id: aiContextProfiles.id }).from(aiContextProfiles),
      ),
    ownerOf: firstSegmentOwner("ai-context/"),
  },
  {
    name: "extractions",
    prefix: "file-extractions/",
    liveIds: () =>
      readIds("organizations", () =>
        db.select({ id: organization.id }).from(organization),
      ),
    ownerOf: firstSegmentOwner("file-extractions/"),
  },
  {
    name: "avatars",
    prefix: "public/avatars/",
    liveIds: async () => [...liveUserIds],
    ownerOf: publicImageOwner("public/avatars/", () => liveUserIds),
  },
  {
    name: "org-logos",
    prefix: "public/org-logos/",
    liveIds: async () => [...liveOrgIds],
    ownerOf: publicImageOwner("public/org-logos/", () => liveOrgIds),
  },
];

// ==================== //
// REPORTING            //
// ==================== //

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes.toString()} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? "TB"}`;
};

/** S3's DeleteObjects caps at 1000 keys, and `deleteObjects` does not chunk. */
const DELETE_CHUNK = 1000;

interface Outcome {
  family: string;
  scanned: number;
  orphanKeys: string[];
  orphanBytes: number;
  tooYoung: number;
  unrecognised: string[];
}

const sweep = async (family: Family): Promise<Outcome | null> => {
  const entries = await listObjectsDetailed(family.prefix);

  // `listObjectsDetailed` answers `[]` on a listing FAILURE as well as on an
  // empty prefix. Nothing to delete either way, so the ambiguity is harmless
  // here — but it is why an empty result is reported rather than passed over.
  if (entries.length === 0) {
    console.log(`\n${family.name}: nothing under ${family.prefix}`);
    return null;
  }

  const ids = await family.liveIds();
  if (ids.length === 0 && !ALLOW_EMPTY) {
    console.error(
      `\n${family.name}: ${entries.length.toString()} objects under ${family.prefix}, ` +
        "but the table holding their owners is EMPTY.",
    );
    console.error(
      "   Refusing to treat every object as an orphan. Check DATABASE_URL, " +
        "or pass --allow-empty if the table really is empty.",
    );
    process.exit(1);
  }
  const live = new Set(ids);

  const outcome: Outcome = {
    family: family.name,
    scanned: entries.length,
    orphanKeys: [],
    orphanBytes: 0,
    tooYoung: 0,
    unrecognised: [],
  };

  for (const entry of entries) {
    const verdict = classifyObject({
      key: entry.key,
      lastModified: entry.lastModified,
      ownerOf: family.ownerOf,
      liveIds: live,
      cutoff,
    });
    if (verdict.kind === "live") continue;
    if (verdict.kind === "unrecognised") {
      outcome.unrecognised.push(entry.key);
      continue;
    }
    if (verdict.kind === "too-young") {
      outcome.tooYoung += 1;
      continue;
    }
    outcome.orphanKeys.push(entry.key);
    outcome.orphanBytes += entry.size;
  }

  return outcome;
};

const report = (outcome: Outcome): void => {
  console.log(`\n${outcome.family}`);
  console.log(`  scanned       ${outcome.scanned.toString()}`);
  console.log(
    `  orphaned      ${outcome.orphanKeys.length.toString()} (${formatBytes(outcome.orphanBytes)})`,
  );
  if (outcome.tooYoung > 0) {
    console.log(
      `  too young     ${outcome.tooYoung.toString()} (owner gone, but written in the last ${MIN_AGE_HOURS.toString()}h — kept)`,
    );
  }
  if (outcome.unrecognised.length > 0) {
    console.log(
      `  unrecognised  ${outcome.unrecognised.length.toString()} (key shape not known to this script — kept)`,
    );
    for (const key of outcome.unrecognised.slice(0, 5)) {
      console.log(`                ${key}`);
    }
    if (outcome.unrecognised.length > 5) {
      console.log(
        `                … and ${(outcome.unrecognised.length - 5).toString()} more`,
      );
    }
  }
  for (const key of outcome.orphanKeys.slice(0, 10)) {
    console.log(`    - ${key}`);
  }
  if (outcome.orphanKeys.length > 10) {
    console.log(
      `    … and ${(outcome.orphanKeys.length - 10).toString()} more`,
    );
  }
};

// ==================== //
// RUN                  //
// ==================== //

const selected = ONLY
  ? FAMILIES.filter((family) => family.name === ONLY)
  : FAMILIES;

if (selected.length === 0) {
  console.error(
    `Unknown --prefix "${ONLY ?? ""}". Known: ${FAMILIES.map((f) => f.name).join(", ")}.`,
  );
  process.exit(2);
}

// The two public-image families match keys AGAINST the live id set, so it has
// to exist before their `ownerOf` runs.
if (selected.some((family) => family.name === "avatars")) {
  liveUserIds = new Set(
    await readIds("users", () => db.select({ id: user.id }).from(user)),
  );
}
if (selected.some((family) => family.name === "org-logos")) {
  liveOrgIds = new Set(
    await readIds("organizations", () =>
      db.select({ id: organization.id }).from(organization),
    ),
  );
}

console.log(
  DELETE
    ? `DELETING orphans older than ${MIN_AGE_HOURS.toString()}h.`
    : `Dry run — nothing will be deleted. Orphans older than ${MIN_AGE_HOURS.toString()}h.`,
);

const outcomes: Outcome[] = [];
for (const family of selected) {
  // Sequential on purpose: a bucket-wide listing is heavy, and a readable
  // report beats a fast one.
  // eslint-disable-next-line no-await-in-loop
  const outcome = await sweep(family);
  if (outcome) {
    report(outcome);
    outcomes.push(outcome);
  }
}

const totalKeys = outcomes.reduce((sum, o) => sum + o.orphanKeys.length, 0);
const totalBytes = outcomes.reduce((sum, o) => sum + o.orphanBytes, 0);

console.log(
  `\n${totalKeys.toString()} orphaned object(s), ${formatBytes(totalBytes)}.`,
);

if (totalKeys === 0) {
  process.exit(0);
}

if (!DELETE) {
  console.log("\nRe-run with --delete to remove them.");
  process.exit(0);
}

let deleted = 0;
for (const outcome of outcomes) {
  for (let i = 0; i < outcome.orphanKeys.length; i += DELETE_CHUNK) {
    const chunk = outcome.orphanKeys.slice(i, i + DELETE_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    await deleteObjects(chunk);
    deleted += chunk.length;
    console.log(`  deleted ${deleted.toString()}/${totalKeys.toString()}`);
  }
}

// `deleteObjects` logs and swallows its failures, so "we sent the request" is
// not "the object is gone". Ask the bucket.
console.log("\nVerifying…");
let remaining = 0;
for (const outcome of outcomes) {
  const family = selected.find((f) => f.name === outcome.family);
  if (!family) continue;
  // eslint-disable-next-line no-await-in-loop
  const stillThere = new Set(
    (await listObjectsDetailed(family.prefix)).map((entry) => entry.key),
  );
  const survivors = outcome.orphanKeys.filter((key) => stillThere.has(key));
  if (survivors.length > 0) {
    console.error(
      `  ${outcome.family}: ${survivors.length.toString()} object(s) still present`,
    );
    remaining += survivors.length;
  }
}

if (remaining > 0) {
  console.error(
    `\n${remaining.toString()} object(s) were not deleted — see the [s3] warnings above.`,
  );
  process.exit(1);
}

console.log(`Done — ${deleted.toString()} object(s) deleted.`);
