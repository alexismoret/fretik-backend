/**
 * Flag migrations that cannot be deployed safely alongside the code already
 * running. Advisory: it prints and exits 0, because a flagged statement is
 * sometimes exactly right and a blocking check nobody can override gets
 * disabled.
 *
 * A deployment is never atomic. For a window measured in minutes, the old
 * containers and the new schema coexist — that is not a race to avoid, it is
 * the normal state of every deploy. So a migration has to be compatible with
 * the code that is ALREADY running, and the three shapes below are the ones
 * that are not:
 *
 *   - `ADD COLUMN … NOT NULL` with no `DEFAULT`: every INSERT from the old
 *     code omits the column and fails. This is `20260830125622` — the migration
 *     that added `account.issuer NOT NULL` and broke every sign-up with a 500
 *     for two days. It is why this file exists.
 *   - `DROP COLUMN` / `DROP TABLE`: the old code still selects it. Drop in a
 *     LATER release, once nothing reads it (expand, then contract).
 *   - `ALTER COLUMN … TYPE`: rewrites the table under an `ACCESS EXCLUSIVE`
 *     lock and may not round-trip for the old code.
 *
 * The safe shape is two releases: add nullable (or with a default) and
 * backfill, ship the code that writes it, then tighten in the next migration.
 *
 * Usage: `bun run scripts/lint-migrations.ts [base-ref]` (default `origin/main`).
 * Only migrations ADDED relative to the base are examined — the history is
 * immutable and re-flagging it every run would train everyone to ignore this.
 */

export {};

const BASE_REF = process.argv[2] ?? "origin/main";
const MIGRATIONS_DIR = "packages/shared/drizzle";

interface Finding {
  file: string;
  line: number;
  rule: string;
  statement: string;
  advice: string;
}

const RULES: {
  rule: string;
  test: (statement: string) => boolean;
  advice: string;
}[] = [
  {
    rule: "add-column-not-null-without-default",
    test: (s) =>
      /\badd\s+column\b/.test(s) &&
      /\bnot\s+null\b/.test(s) &&
      !/\bdefault\b/.test(s) &&
      !/\bgenerated\b/.test(s),
    advice:
      "the running code INSERTs without this column. Add it nullable (or with a DEFAULT), backfill, ship the code, tighten in a later migration.",
  },
  {
    rule: "alter-column-set-not-null",
    test: (s) => /\balter\s+column\b.*\bset\s+not\s+null\b/.test(s),
    advice:
      "THE incident, precisely. `20260830125622` is a correctly written expand/contract migration — nullable, backfill, tighten — and it still broke every sign-up for two days, because the tightening landed while the code that inserts without the column was still running. Ship this in the release AFTER the one that starts writing the column.",
  },
  {
    rule: "drop-column",
    test: (s) => /\bdrop\s+column\b/.test(s),
    advice:
      "the running code still SELECTs it. Stop reading it in one release, drop it in the next.",
  },
  {
    rule: "drop-table",
    test: (s) => /\bdrop\s+table\b/.test(s),
    advice:
      "same as a dropped column, one table wider. Confirm nothing reads it in the release that is live right now.",
  },
  {
    rule: "alter-column-type",
    test: (s) => /\balter\s+column\b.*\btype\b/.test(s),
    advice:
      "rewrites the table under ACCESS EXCLUSIVE and may not round-trip for the running code. Prefer a new column + backfill.",
  },
];

const addedMigrationFiles = async (): Promise<string[]> => {
  const diff =
    await Bun.$`git diff --name-only --diff-filter=A ${BASE_REF}...HEAD -- ${MIGRATIONS_DIR}`
      .nothrow()
      .quiet();
  if (diff.exitCode !== 0) {
    console.warn(
      `[lint-migrations] cannot diff against ${BASE_REF} (${diff.stderr.toString().trim()}). Nothing to check.`,
    );
    return [];
  }
  return diff
    .text()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".sql"));
};

/**
 * Statements, with the line each starts on. Drizzle separates them with
 * `--> statement-breakpoint`, but splitting on `;` also handles a file written
 * by hand, and comments are stripped so a rule cannot fire on prose.
 */
const statementsOf = (sql: string): { line: number; text: string }[] => {
  const out: { line: number; text: string }[] = [];
  let buffer = "";
  let startLine = 1;
  const lines = sql.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/--.*$/, "");
    // `buffer.trim()`, not `buffer`: a stripped comment line appends a space,
    // so a file that opens with a comment block would otherwise report every
    // statement at line 1.
    if (buffer.trim() === "" && line.trim() !== "") startLine = index + 1;
    buffer += ` ${line}`;
    if (line.includes(";")) {
      if (buffer.trim() !== "") out.push({ line: startLine, text: buffer });
      buffer = "";
    }
  }
  if (buffer.trim() !== "") out.push({ line: startLine, text: buffer });
  return out;
};

const files = await addedMigrationFiles();
if (files.length === 0) {
  console.log("[lint-migrations] no new migrations in this diff.");
  process.exit(0);
}

const findings: Finding[] = [];
for (const file of files) {
  const sql = await Bun.file(file).text();
  for (const { line, text } of statementsOf(sql)) {
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
    for (const { rule, test, advice } of RULES) {
      if (test(normalized)) {
        findings.push({
          file,
          line,
          rule,
          statement: text.replace(/\s+/g, " ").trim().slice(0, 160),
          advice,
        });
      }
    }
  }
}

console.log(
  `[lint-migrations] ${files.length.toString()} new migration file(s), ${findings.length.toString()} statement(s) to look at.`,
);
for (const finding of findings) {
  console.log("");
  console.log(`${finding.file}:${finding.line.toString()}  ${finding.rule}`);
  console.log(`  ${finding.statement}`);
  console.log(`  → ${finding.advice}`);
}
if (findings.length > 0) {
  console.log("");
  console.log(
    "None of this blocks the build. It is a question — is the code that is live RIGHT NOW compatible with this schema? — and only the author can answer it.",
  );
}
