/**
 * Copy the render contract into the frontend, and guard the copy.
 *
 * `app/` is deployed on its own (Vercel builds it without the backend
 * workspace), so it cannot import `@fretik/render`. Before this package there
 * was a HAND-written mirror of the catalog in `utils/pageCatalog.ts` — 448
 * lines that drifted from the backend once already, which is the failure this
 * whole package exists to remove. A generated, checked-in copy plus a manifest
 * is the version of that mirror that cannot drift silently.
 *
 * The stamp carries two independent things, because there are two failure
 * modes and two checkers:
 *
 *   - `source` — one digest of the source tree. THIS script compares it and
 *     fails when the catalog changed and nobody re-synced.
 *   - `files`  — a digest PER written file. The frontend's
 *     `verify-render-contract.ts` recomputes those and fails when someone
 *     hand-edits the generated copy.
 *
 * Per-file digests rather than a second aggregate, on purpose: two scripts
 * that must agree on a concatenation convention is a bug waiting to happen —
 * the first version of this file disagreed with its frontend twin over a
 * single separator character and reported a false edit. A per-file digest has
 * no convention to get wrong.
 *
 * Usage:
 *   bun run sync-contract          write the copy
 *   bun run sync-contract --check  fail if the copy is stale
 */

import { CryptoHasher } from "bun";
import { join, relative } from "node:path";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const SOURCE_DIR = join(PACKAGE_ROOT, "src");
const REPO_ROOT = join(PACKAGE_ROOT, "../../..");
const FRONTEND_ROOT = join(REPO_ROOT, "app");
const TARGET_DIR = join(FRONTEND_ROOT, "app/utils/render-contract");
const STAMP = join(TARGET_DIR, "contract-hash.json");

/**
 * The frontend is a SEPARATE git repository (`fretik-app`), checked out beside
 * this one. A backend-only clone — CI, a Docker build — has nothing to sync
 * and nothing to check, and must not be failed for it or have a phantom
 * `app/` tree written into it. Staleness across the two repos is caught where
 * both trees exist: the pre-commit hook and pre-push `check`.
 */
const frontendPresent = await Bun.file(
  join(FRONTEND_ROOT, "package.json"),
).exists();

const banner = (path: string): string =>
  [
    "// GENERATED FILE — do not edit.",
    `// Source: backend/packages/render/src/${path}`,
    "// Regenerate: cd backend/packages/render && bun run sync-contract",
    "",
    "",
  ].join("\n");

const digest = (content: string): string =>
  new CryptoHasher("sha256").update(content).digest("hex");

/**
 * One digest for a whole tree. Fed through `JSON.stringify` of the sorted
 * entries so there is no separator to agree on — see the note above.
 */
const digestTree = (files: Map<string, string>): string =>
  digest(
    JSON.stringify(
      [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  );

const readTree = async (dir: string): Promise<Map<string, string>> => {
  const files = new Map<string, string>();
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: dir })) {
    files.set(path, await Bun.file(join(dir, path)).text());
  }
  return files;
};

const source = await readTree(SOURCE_DIR);
if (source.size === 0) {
  console.error(`no .ts files under ${SOURCE_DIR}`);
  process.exit(1);
}
const sourceHash = digestTree(source);

if (!frontendPresent) {
  console.log(
    "frontend repo not checked out beside this one — nothing to sync",
  );
  process.exit(0);
}

if (process.argv.includes("--check")) {
  const file = Bun.file(STAMP);
  const stamp: unknown = (await file.exists()) ? await file.json() : undefined;
  const stamped: unknown =
    typeof stamp === "object" && stamp !== null
      ? Reflect.get(stamp, "source")
      : undefined;
  if (stamped === sourceHash) {
    console.log(`render contract in sync (${source.size} files)`);
    process.exit(0);
  }
  console.error(
    [
      "render contract is STALE.",
      `  source: ${sourceHash}`,
      `  copy:   ${typeof stamped === "string" ? stamped : "(never synced)"}`,
      "  fix:    cd backend/packages/render && bun run sync-contract",
    ].join("\n"),
  );
  process.exit(1);
}

// Files deleted from the source must disappear from the copy, so the target is
// rebuilt rather than merged.
const manifest: Record<string, string> = {};
const bodies = [...source].map(([path, content]) => ({
  path,
  body: banner(path) + content,
}));
await Promise.all(
  bodies.map(({ path, body }) => Bun.write(join(TARGET_DIR, path), body)),
);
for (const { path, body } of bodies) manifest[path] = digest(body);

for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: TARGET_DIR })) {
  if (!source.has(path)) {
    await Bun.file(join(TARGET_DIR, path)).delete();
    console.log(`removed ${path}`);
  }
}

await Bun.write(
  STAMP,
  `${JSON.stringify({ source: sourceHash, files: manifest }, null, 2)}\n`,
);
await Bun.write(
  join(TARGET_DIR, "README.md"),
  [
    "# render-contract (generated)",
    "",
    "A copy of `backend/packages/render/src`, checked in because `app/` builds",
    "without the backend workspace. **Do not edit anything here** — change the",
    "source and run `cd backend/packages/render && bun run sync-contract`.",
    "",
    "`bun run verify:contract` (frontend) fails if these files were hand-edited;",
    "`bun run check` (render package) fails if they are behind the source.",
    "",
  ].join("\n"),
);

console.log(
  `synced ${source.size} files → ${relative(REPO_ROOT, TARGET_DIR)} (${sourceHash.slice(0, 12)})`,
);
