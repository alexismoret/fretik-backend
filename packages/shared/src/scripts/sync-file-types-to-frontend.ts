/**
 * Copy the browser-safe half of the file-type registry into the frontend repo.
 *
 *     bun run file-types:sync
 *
 * WHY A COPY AT ALL. `fretik-backend` and `fretik-app` are two repositories
 * that deploy on their own. The Nuxt alias used to point straight at
 * `../backend/packages/shared/src/file-types/index.ts`, which resolves on a
 * developer machine — both checkouts sit side by side — and nowhere else:
 * Vercel clones `fretik-app` alone, so the build died with
 * `UNLOADABLE_DEPENDENCY: Could not load ../backend/.../file-types/index.ts`.
 *
 * This is the same shape as the old render contract, and the same answer:
 * generate the copy, commit it in the frontend, and guard it from both ends —
 * `bun run verify:generated` there catches a hand-edit, the pre-push hook here
 * catches a backend change that was never carried over.
 *
 * WHAT IS COPIED. Exactly the four dependency-free modules `index.ts` exposes.
 * `detect.ts` is excluded for the reason it is already excluded from
 * `index.ts`: it pulls `file-type`, a Node-only package the browser bundle
 * must not reach.
 *
 *     bun run file-types:sync --check
 *
 * Writes nothing; exits 1 when the copy is out of date. This is what the
 * pre-push hook asks, and it is the half no check on the frontend side can
 * do — over there the copy looks internally consistent no matter how far the
 * backend has moved on.
 */

/** The modules that make up the registry's public, browser-safe surface. */
const FILES = ["types.ts", "registry.ts", "derive.ts", "index.ts"] as const;

const SOURCE_DIR = new URL("../file-types/", import.meta.url);
/** `backend/packages/shared/src/scripts/` → the sibling `fretik-app` checkout. */
const APP_REPO = new URL("../../../../../app/", import.meta.url);
const TARGET_DIR = new URL("generated/file-types/", APP_REPO);

const banner = (name: string): string =>
  [
    "// GENERATED FILE — DO NOT EDIT.",
    "//",
    `// Copied verbatim from fretik-backend, packages/shared/src/file-types/${name}.`,
    "// Edit it there, run `bun run file-types:sync`, and commit both repos.",
    "// `bun run verify:generated` here fails if this copy was hand-edited.",
    "",
    "",
  ].join("\n");

const sha256 = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

if (!(await Bun.file(new URL("package.json", APP_REPO)).exists())) {
  console.error(
    `No fretik-app checkout beside this repo (looked in ${APP_REPO.pathname}).`,
  );
  console.error("Clone it as a sibling directory, then re-run.");
  process.exit(2);
}

const checkOnly = process.argv.includes("--check");

const manifest: Record<string, string> = {};
const stale: string[] = [];

for (const name of FILES) {
  const generated =
    banner(name) + (await Bun.file(new URL(name, SOURCE_DIR)).text());
  const destination = new URL(name, TARGET_DIR);

  const previous = await Bun.file(destination)
    .text()
    .catch(() => null);
  if (previous !== generated) stale.push(name);

  if (!checkOnly) await Bun.write(destination, generated);
  manifest[name] = sha256(generated);
}

if (checkOnly) {
  if (stale.length === 0) {
    console.log(
      `OK — ${FILES.length.toString()} files in sync with fretik-app.`,
    );
    process.exit(0);
  }
  console.error(`Out of date in fretik-app: ${stale.join(", ")}`);
  process.exit(1);
}

await Bun.write(
  new URL("manifest.json", TARGET_DIR),
  `${JSON.stringify({ files: manifest }, null, 2)}\n`,
);

if (stale.length === 0) {
  console.log(`OK — ${FILES.length.toString()} files already in sync.`);
} else {
  console.log(
    `Wrote ${stale.length.toString()}/${FILES.length.toString()} changed file(s) to ${TARGET_DIR.pathname}`,
  );
  console.log("Commit them in fretik-app — the frontend deploys on its own.");
}
