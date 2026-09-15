/**
 * Put a screenshot or a screen recording behind a public URL, so a product
 * update can show the thing instead of describing it.
 *
 *     bun run changelog:media 2026-09-15-record-relations shots/*.png
 *     bun run changelog:media 2026-09-15-record-relations demo.mp4
 *     bun run changelog:media --prune 2026-09-15-record-relations [--delete]
 *
 * Prints, for every file, the public URL and the markdown line to paste into
 * `app/changelog/entries/<slug>/<locale>.md` in the frontend repo — the same
 * URL in every language, since the media is shared. That repo is
 * where the updates live and where they get reviewed; this script exists only
 * because the bytes cannot live in git — a handful of screen recordings would
 * outweigh the entire history.
 *
 * WHAT IT DOES TO WHAT YOU GIVE IT:
 *
 *  - **Images are re-encoded, always.** Whatever comes in (PNG, JPEG, WebP)
 *    goes out as WebP, longest edge 1600. A retina screenshot of a full app
 *    window is ~3000px and 2 MB of PNG; nothing in the modal renders wider
 *    than ~900 CSS px, so the other 2000 pixels are pure download time on a
 *    surface whose whole job is to be read in five seconds. Re-encoding also
 *    strips EXIF, which on a screenshot can carry the machine's name.
 *  - **Videos are passed through untouched.** There is no ffmpeg in this image
 *    and a wrong transcode is worse than a large file. Keep recordings short
 *    and small at the source — see `CHANGELOG-AUTHORING.md` for the capture
 *    settings that land under a megabyte.
 *  - **Everything is content-addressed.** The stored name carries a hash of
 *    the processed bytes, so re-running after re-cropping one screenshot
 *    writes a new object and leaves the old URL working (any draft that
 *    already quoted it keeps rendering), and re-running unchanged is a no-op
 *    that prints the same URL.
 *
 * Objects land under `public/changelog/<slug>/` with a `public-read` ACL, next
 * to the avatars and org logos the app already serves straight from the
 * bucket. `scripts/sweep-orphan-s3.ts` enumerates only the prefixes it has a
 * rule for, so it neither deletes nor reports these — which is right: their
 * owner is a file in another repository, not a row it could look up. The
 * corollary is that `--prune` is the ONLY thing that ever removes them, so
 * retiring an old update means running it.
 *
 * No database, so no `assertOperatorTarget`: the upload path writes new
 * immutable objects under a prefix nothing else reads, and there is one
 * bucket. `--prune` does destroy, which is why it reports first and needs
 * `--delete` to act.
 */

import { fileTypeFromBuffer } from "file-type";
import { basename, extname } from "node:path";
import process from "node:process";

import {
  deleteObjects,
  listObjects,
  objectExists,
  publicUrl,
  putObject,
} from "../lib/s3";

// ============================================================ //
// LIMITS                                                        //
// ============================================================ //

/** Longest edge of a stored screenshot, in pixels. */
const IMAGE_MAX_EDGE = 1600;

/** WebP quality. 82 is where screenshots of UI stop losing text edges. */
const IMAGE_QUALITY = 82;

/** Input cap for an image, before re-encoding. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * Input cap for a video, which is ALSO the output cap since nothing
 * re-encodes it. A 20 MB autoplaying loop in a modal is a bad update, not a
 * big one — the ceiling is here to make that a refusal rather than a
 * regret.
 */
const MAX_VIDEO_BYTES = 8 * 1024 * 1024;

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VIDEO_MIMES = new Map([
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
]);

/** Same shape the slug takes in the frontend repo and in `changelog_reads`. */
const SLUG_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;

// ============================================================ //
// ARGUMENTS                                                     //
// ============================================================ //

const flags = new Set(
  process.argv.slice(2).filter((arg) => arg.startsWith("--")),
);
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const [slug, ...files] = args;

const PRUNE = flags.has("--prune");
const CONFIRM_DELETE = flags.has("--delete");
const ALLOW_DEV_BUCKET = flags.has("--target=dev");

/**
 * Mirrors `SAFE_DB_NAME_PATTERN` in `lib/operator-guard.ts`: a `dev`/`test`/`ci`
 * word at either end of the name. Matching a bare substring is how a safe-list
 * stops being one.
 */
const DISPOSABLE_BUCKET = /^(dev|test|ci)[-_]|[-_](dev|test|ci)$/;

// A function DECLARATION, not the arrow the rest of this file uses: a
// `never`-returning arrow only narrows the control flow after it when the
// binding carries an explicit type annotation, and without that narrowing
// `slug` stays `string | undefined` for every line below.
function usage(message: string): never {
  console.error(`\n  ${message}\n`);
  console.error("  Usage: bun run changelog:media <slug> <file…>");
  console.error("         bun run changelog:media --prune <slug> [--delete]");
  console.error(
    "  e.g.:  bun run changelog:media 2026-09-15-record-relations shots/*.png\n",
  );
  process.exit(1);
}

if (!slug) usage("Missing <slug>.");
if (!SLUG_PATTERN.test(slug)) {
  usage(
    `"${slug}" is not a slug. Use the entry's directory name in the frontend repo, e.g. 2026-09-15-record-relations.`,
  );
}
if (!PRUNE && files.length === 0) usage("Give me at least one file to upload.");

// ============================================================ //
// WHICH BUCKET                                                  //
// ============================================================ //

/**
 * The bucket is announced, and a disposable one is refused.
 *
 * This is the only script here whose output is COMMITTED: the URL it prints
 * goes into an entry, into a pull request, and into production. A laptop's env
 * points at `dev-files.fretik.com`, and nothing downstream looks wrong — the
 * URL is https, it resolves, the image renders in review — so the mistake only
 * surfaces the day someone empties the dev bucket and every customer's
 * announcement loses its pictures.
 *
 * The same Scaleway credentials reach both buckets, so the fix is one
 * environment variable rather than a second set of keys.
 */
const bucket = process.env.S3_BUCKET ?? "";

console.log(`\n  bucket: ${bucket}`);

if (DISPOSABLE_BUCKET.test(bucket) && !ALLOW_DEV_BUCKET) {
  console.error(
    `\n  ${bucket} is a disposable bucket, and this URL gets committed.\n`,
  );
  console.error("  Re-run against production:\n");
  console.error(
    `    S3_BUCKET=files.fretik.com bun run changelog:media ${slug} <file…>\n`,
  );
  console.error(
    "  Or pass --target=dev to exercise the pipeline without publishing.\n",
  );
  process.exit(1);
}

// ============================================================ //
// PRUNE — retiring an entry                                     //
// ============================================================ //

/**
 * Delete everything stored for one entry, for when its directory is removed
 * from the frontend repo and the bytes have nothing left pointing at them.
 *
 * Its own mode rather than a separate script, and reporting before deleting,
 * because this is the one operation here that destroys something: everything
 * else writes new immutable objects. `--prune` alone lists, `--prune --delete`
 * removes.
 *
 * Nothing else reaps these. `sweep-orphan-s3.ts` decides ownership by looking
 * up a row in Postgres, and the owner of a changelog object is a DIRECTORY IN
 * ANOTHER REPOSITORY — so it enumerates only the prefixes it has a rule for
 * and never touches this one. Retiring an entry means running this.
 */
if (PRUNE) {
  const prefix = `public/changelog/${slug}/`;
  const keys = await listObjects(prefix);

  if (keys.length === 0) {
    console.log(`\n  Nothing stored under ${prefix}\n`);
    process.exit(0);
  }

  console.log(`\n  ${keys.length.toString()} object(s) under ${prefix}:\n`);
  for (const key of keys) console.log(`    ${key}`);

  if (!CONFIRM_DELETE) {
    console.log(
      "\n  Nothing deleted. Re-run with --delete once the entry directory is gone from the frontend repo.\n",
    );
    process.exit(0);
  }

  await deleteObjects(keys);
  console.log(`\n  Deleted ${keys.length.toString()} object(s).\n`);
  process.exit(0);
}

// ============================================================ //
// PER-FILE PIPELINE                                             //
// ============================================================ //

interface Uploaded {
  source: string;
  key: string;
  url: string;
  bytes: number;
  kind: "image" | "video";
}

/**
 * Filename stem, stripped to what can live in a URL without escaping. An
 * `Écran 2026-09-15 à 14.02.png` dropped straight into a key is legal S3 and
 * an unreadable percent-encoded URL in a markdown file people have to review.
 */
const stem = (path: string): string => {
  const name = basename(path, extname(path))
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name.length > 0 ? name.slice(0, 48) : "media";
};

const processOne = async (path: string): Promise<Uploaded> => {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`${path}: no such file`);

  const input = new Uint8Array(await file.arrayBuffer());
  // Magic bytes, never the extension: a `.png` that is really a 40 MB
  // ProRes clip must fail here and not at `Bun.Image`.
  const detected = await fileTypeFromBuffer(input);
  const mime = detected?.mime ?? "";

  let body: Uint8Array;
  let contentType: string;
  let extension: string;
  let kind: Uploaded["kind"];

  if (IMAGE_MIMES.has(mime)) {
    if (input.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `${path}: ${(input.byteLength / 1024 / 1024).toFixed(1)} MB exceeds the ${(MAX_IMAGE_BYTES / 1024 / 1024).toString()} MB input cap for an image`,
      );
    }
    body = await new Bun.Image(input, { maxPixels: 8192 * 8192 })
      .resize(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: IMAGE_QUALITY })
      .bytes();
    contentType = "image/webp";
    extension = "webp";
    kind = "image";
  } else if (VIDEO_MIMES.has(mime)) {
    if (input.byteLength > MAX_VIDEO_BYTES) {
      throw new Error(
        `${path}: ${(input.byteLength / 1024 / 1024).toFixed(1)} MB exceeds the ${(MAX_VIDEO_BYTES / 1024 / 1024).toString()} MB cap for a video. Trim it, drop the frame rate, or cut it into two shorter loops.`,
      );
    }
    body = input;
    contentType = mime;
    extension = VIDEO_MIMES.get(mime) ?? "mp4";
    kind = "video";
  } else {
    throw new Error(
      `${path}: ${mime === "" ? "unrecognised format" : mime} is not supported. Images: PNG, JPEG, WebP. Video: MP4, WebM.`,
    );
  }

  const hash = Bun.hash(body).toString(16).slice(0, 10);
  const key = `public/changelog/${slug}/${stem(path)}-${hash}.${extension}`;

  // Content-addressed: a key that already exists holds these exact bytes, so
  // re-running after touching one screenshot re-uploads only that one and
  // every URL already quoted in a draft keeps resolving.
  if (!(await objectExists(key))) {
    await putObject({ key, body, contentType, acl: "public-read" });
  }

  return {
    source: path,
    key,
    url: publicUrl(key),
    bytes: body.byteLength,
    kind,
  };
};

// ============================================================ //
// RUN                                                           //
// ============================================================ //

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} kB`;

const uploaded: Uploaded[] = [];
const failures: string[] = [];

for (const path of files) {
  try {
    // Sequential on purpose: `Bun.Image` re-encodes off-thread but a dozen at
    // once is a memory spike for no wall-clock gain on a handful of files,
    // and the output has to stay in the order the author listed them.
    // eslint-disable-next-line no-await-in-loop
    const result = await processOne(path);
    uploaded.push(result);
    console.log(`  ✓ ${result.source} → ${result.key} (${kb(result.bytes)})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(message);
    console.error(`  ✗ ${message}`);
  }
}

if (uploaded.length > 0) {
  // The same lines go into EVERY language's body — only the alt text changes.
  console.log(
    `\n  Paste into every app/changelog/entries/${slug}/<locale>.md:\n`,
  );
  /**
   * A still needs BOTH themes, so `foo-light.png` and `foo-dark.png` come back
   * as ONE block rather than two. Pairing on the filename because that is what
   * a capture script already produces, and an author who has to hand-match two
   * URLs out of a list of eight will eventually cross them.
   */
  const pairKey = (key: string): string =>
    key.replace(/-(light|dark)-[0-9a-f]{10}\.\w+$/, "");

  const printed = new Set<string>();

  for (const item of uploaded) {
    if (printed.has(item.key)) continue;
    printed.add(item.key);

    const twin = uploaded.find(
      (other) =>
        other.key !== item.key &&
        pairKey(other.key) === pairKey(item.key) &&
        /-dark-/.test(other.key) !== /-dark-/.test(item.key),
    );
    if (twin) printed.add(twin.key);

    const light = /-dark-/.test(item.key) ? twin?.url : item.url;
    const dark = /-dark-/.test(item.key) ? item.url : twin?.url;

    if (item.kind === "video") {
      console.log(
        `::demo{light="${item.url}" alt="describe what the clip shows"}\n::\n`,
      );
      continue;
    }
    console.log(
      (dark
        ? `::shot{light="${light ?? ""}" dark="${dark}" alt="describe what is on screen"}`
        : // No twin: say so rather than emitting a half-block that renders the
          // same picture in both themes and looks deliberate.
          `::shot{light="${item.url}" dark="MISSING — capture this frame in dark mode too" alt="describe what is on screen"}`) +
        // The closing `::` is part of what gets pasted, never a line the author
        // is trusted to add. Without it the block never closes and swallows the
        // rest of the update — silently, and only at render time.
        "\n::\n",
    );
  }
  console.log("");
}

if (failures.length > 0) process.exit(1);
