/**
 * Put a screenshot or a screen recording behind a public URL, so a product
 * update can show the thing instead of describing it.
 *
 *     bun run changelog:media 2026-09-15-record-relations shots/*.png
 *     bun run changelog:media 2026-09-15-record-relations demo.mp4
 *
 * Prints, for every file, the public URL and the markdown line to paste into
 * `app/changelog/entries/<slug>/{en,fr}.md` in the frontend repo. That repo is
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
 * owner is a file in another repository, not a row it could look up.
 *
 * No database, so no `assertOperatorTarget`: this writes new immutable objects
 * under a prefix nothing else reads, and there is one bucket. It refuses to
 * overwrite a DIFFERENT object at the same key regardless.
 */

import { fileTypeFromBuffer } from "file-type";
import { basename, extname } from "node:path";
import process from "node:process";

import { objectExists, publicUrl, putObject } from "../lib/s3";

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

const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const [slug, ...files] = args;

// A function DECLARATION, not the arrow the rest of this file uses: a
// `never`-returning arrow only narrows the control flow after it when the
// binding carries an explicit type annotation, and without that narrowing
// `slug` stays `string | undefined` for every line below.
function usage(message: string): never {
  console.error(`\n  ${message}\n`);
  console.error("  Usage: bun run changelog:media <slug> <file…>");
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
if (files.length === 0) usage("Give me at least one file to upload.");

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
  console.log(`\n  Paste into app/changelog/entries/${slug}/{en,fr}.md:\n`);
  for (const item of uploaded) {
    // An image is plain markdown — it already renders with a frame and a zoom
    // lightbox. Only a clip needs the MDC block, because raw <video> is
    // stripped by the renderer's security plugin.
    console.log(
      item.kind === "image"
        ? `![describe what is on screen](${item.url})`
        : `::demo{src="${item.url}" alt="describe what the clip shows"}`,
    );
  }
  console.log("");
}

if (failures.length > 0) process.exit(1);
