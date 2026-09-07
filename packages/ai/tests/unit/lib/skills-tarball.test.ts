import { describe, expect, test } from "bun:test";
import { getSkillsBundle } from "../../../src/lib/conversation-storage";

/**
 * Smoke tests for the bundled-skills tarball builder.
 *
 * Validates the on-disk artefact the sandbox bootstrap actually
 * uploads. Catches four regressions:
 *
 *   1. The bundled directory drifts away from the loader's expected
 *      location → `getSkillsBundle()` returns `null`.
 *   2. `Bun.Archive` stops compressing → the gzip magic bytes go away.
 *   3. The cached promise stops short-circuiting → second call rebuilds.
 *   4. The exec-bit list goes empty → the scripts land unexecutable.
 *
 * Filesystem-only, no E2B / DB / network — fast and CI-safe.
 */

const GZIP_MAGIC = [0x1f, 0x8b];

describe("getSkillsBundle", () => {
  test("produces non-empty gzipped bytes for the bundled skills tree", async () => {
    const bundle = await getSkillsBundle();

    if (bundle === null) {
      throw new Error(
        "Bundled skills directory is missing — the loader returned null. " +
          "Confirm backend/packages/ai/src/skills/bundled/ exists and is not empty.",
      );
    }

    // Lower bound that would have caught the "Bun.Archive doesn't
    // await BunFile reads" regression we hit on 2026-05-18: passing
    // raw `Bun.file(...)` references produced a ~3 KB tarball with
    // 187 zero-byte entries. The real content (the 5 always-on skills
    // alone — docx/pdf/pptx/xlsx/doc-coauthoring SKILL.md bodies +
    // helper scripts) compresses to several hundred KB, so a 100 KB
    // floor is a comfortable canary.
    expect(bundle.bytes.byteLength).toBeGreaterThan(100 * 1024);

    // gzip magic = 1F 8B. Bun.Archive with { compress: "gzip" } MUST
    // emit a gzipped tarball — if this fails we either lost the
    // compress option or Bun.Archive's output format changed under us.
    expect(bundle.bytes[0]).toBe(GZIP_MAGIC[0]);
    expect(bundle.bytes[1]).toBe(GZIP_MAGIC[1]);
  });

  test("subsequent calls return the same cached bundle", async () => {
    const a = await getSkillsBundle();
    const b = await getSkillsBundle();
    expect(b).toBe(a); // identity — cached promise, not rebuilt
  });

  test("tarball stays small enough to upload in a single E2B write", async () => {
    // E2B's `files.write` accepts arbitrary sizes but we want to keep
    // the bootstrap budget under control. The current bundled set
    // (~3.7 MB raw, ~1-1.5 MB gzipped) sits well under this cap; a
    // sudden jump would warrant either trimming a heavy schema folder
    // or moving to a tar-split strategy.
    const SOFT_CAP_BYTES = 8 * 1024 * 1024; // 8 MB
    const bundle = await getSkillsBundle();
    if (bundle === null) return; // covered by the first test
    expect(bundle.bytes.byteLength).toBeLessThan(SOFT_CAP_BYTES);
  });

  test("carries the exec bit the archive drops", async () => {
    // `Bun.Archive` takes Blobs, and a Blob has no mode — every entry ships
    // `0644`, which denies execution to root too. The bundle therefore has to
    // carry the list separately so the bootstrap can `chmod +x` after
    // extraction. `recalc.py` is `0755` in the repo and is the script the xlsx
    // skill runs to verify a workbook's formulas.
    const bundle = await getSkillsBundle();
    if (bundle === null) return; // covered by the first test
    expect(bundle.executables).toContain("xlsx/scripts/recalc.py");
    // Prose must never end up in the list — a blanket chmod would put it there.
    expect(bundle.executables.some((p) => p.endsWith(".md"))).toBe(false);
  });
});
