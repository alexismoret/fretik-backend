#!/usr/bin/env bun
/**
 * One-off migration: re-encode existing PNG document thumbnails to WebP.
 *
 * Context: thumbnail generation switched from sharp/PNG to Bun.Image/WebP
 * (`services/documents/thumbnails.ts`) and the thumbnail S3 key moved from
 * `documents/{id}-thumbnail.png` to `…-thumbnail.webp`
 * (`buildDocumentThumbnailKey`). Documents processed before the switch
 * still carry a `.png` object, so their presigned `thumbnailUrl` now 404s.
 * This transcodes each existing PNG thumbnail to WebP at the new key.
 *
 * Works off the already-rendered PNG — no originals, no poppler, no
 * Gotenberg, no DB. Needs only S3 credentials (present in the prod API
 * container, injected by Dokploy).
 *
 * Behaviour:
 *   - Lists every `documents/*-thumbnail.png` on S3.
 *   - Per object: download the PNG, re-encode to a bounded WebP via Bun's
 *     native pipeline, upload to `…-thumbnail.webp`, then delete the `.png`
 *     (unless `--keep-png`).
 *   - Idempotent: a re-run finds no `.png` left (already migrated).
 *   - Bounded concurrency; per-object failures are collected, never abort
 *     the batch.
 *   - Dry-run by default — prints what it WOULD do. Pass `--apply` to write.
 *
 * Usage (local):
 *   cd packages/shared
 *   bun --env-file=../../.env run src/scripts/migrate-thumbnails-to-webp.ts            # dry-run
 *   bun --env-file=../../.env run src/scripts/migrate-thumbnails-to-webp.ts --apply    # write
 *
 * Usage (prod — env is ambient, WORKDIR=/app inside the @fretik/api image):
 *   docker exec <api-container> bun run packages/shared/src/scripts/migrate-thumbnails-to-webp.ts            # dry-run
 *   docker exec <api-container> bun run packages/shared/src/scripts/migrate-thumbnails-to-webp.ts --apply    # write
 */
import {
  deleteObject,
  getObjectBytes,
  listObjects,
  putObject,
} from "../lib/s3";

// Must mirror `services/documents/thumbnails.ts` so migrated thumbnails
// are byte-for-byte equivalent to freshly generated ones.
const THUMBNAIL_SIZE = 400;
const WEBP_QUALITY = 80;
const MAX_INPUT_PIXELS = 8192 * 8192;

const CONCURRENCY = 8;

const apply = process.argv.includes("--apply");
const keepPng = process.argv.includes("--keep-png");

type Outcome = "migrated" | "skipped" | "failed";

const toWebp = (png: Uint8Array): Promise<Uint8Array> =>
  new Bun.Image(png, { maxPixels: MAX_INPUT_PIXELS })
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY })
    .bytes();

const migrateOne = async (pngKey: string): Promise<Outcome> => {
  const webpKey = pngKey.replace(/-thumbnail\.png$/, "-thumbnail.webp");

  // Dry-run stays cheap — just report the mapping, no S3 GET / transcode.
  if (!apply) {
    console.log(`  would migrate ${pngKey} -> ${webpKey}`);
    return "migrated";
  }

  try {
    const png = await getObjectBytes(pngKey);
    if (!png) {
      console.warn(`  [skip] ${pngKey} — object could not be read`);
      return "skipped";
    }
    const webp = await toWebp(png);
    await putObject({ key: webpKey, body: webp, contentType: "image/webp" });
    if (!keepPng) await deleteObject(pngKey);
    console.log(
      `  migrated ${pngKey} -> ${webpKey} (${png.length.toString()} -> ${webp.length.toString()} B)`,
    );
    return "migrated";
  } catch (err) {
    console.error(
      `  [fail] ${pngKey}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "failed";
  }
};

const main = async (): Promise<void> => {
  console.log(
    `[thumbnails:migrate-webp] mode=${apply ? "APPLY" : "DRY-RUN"} keepPng=${keepPng.toString()}`,
  );

  const pngThumbs = (await listObjects("documents/")).filter((k) =>
    k.endsWith("-thumbnail.png"),
  );
  console.log(
    `[thumbnails:migrate-webp] found ${pngThumbs.length.toString()} PNG thumbnail(s)`,
  );

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < pngThumbs.length; i += CONCURRENCY) {
    const batch = pngThumbs.slice(i, i + CONCURRENCY);
    // oxlint-disable-next-line no-await-in-loop -- batches are intentionally sequential to cap S3 concurrency
    const results = await Promise.all(batch.map(migrateOne));
    for (const r of results) {
      if (r === "migrated") migrated += 1;
      else if (r === "skipped") skipped += 1;
      else failed += 1;
    }
  }

  console.log(
    `[thumbnails:migrate-webp] done: ${apply ? "migrated" : "would migrate"}=${migrated.toString()} skipped=${skipped.toString()} failed=${failed.toString()}`,
  );
  if (!apply && pngThumbs.length > 0) {
    console.log(
      "[thumbnails:migrate-webp] dry-run — re-run with --apply to write.",
    );
  }
};

await main();
