import { describe, expect, test } from "bun:test";

/**
 * Every schema module must load as the FIRST thing a process imports.
 *
 * Two schema files that import each other only work when one particular side
 * is loaded first; the other order reads a `const` before it exists. The jobs
 * worker crashed at boot that way (`FolderBreadcrumbSchema` before
 * initialization) as soon as a service imported `schemas/folders` ahead of
 * `schemas/documents`. A test file shares one module graph, so the order is
 * only exercised in a fresh process per module.
 */
const SCHEMA_DIR = new URL("../../src/schemas/", import.meta.url).pathname;

const schemaModules = [
  ...new Bun.Glob("**/*.ts").scanSync({ cwd: SCHEMA_DIR }),
].sort();

const loadAlone = async (
  relative: string,
): Promise<{ code: number; stderr: string }> => {
  // Exit once loaded: a module may open a handle (a queue client) that would
  // otherwise keep the process alive, and loading is all this checks.
  const proc = Bun.spawn(
    [
      "bun",
      // No `.env` from the cwd. Locally it quietly supplied what CI does not
      // have, which is how this passed on a laptop and failed in CI.
      "--env-file=/dev/null",
      "-e",
      `await import(${JSON.stringify(SCHEMA_DIR + relative)}); process.exit(0);`,
    ],
    {
      // The environment the preload built, passed on explicitly: a spawned
      // process inherits the one this process STARTED with, not what the
      // preload set since. Without it, a schema module that reaches the
      // database handle (`bulk-operations.ts`) died on a missing DATABASE_URL.
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { code, stderr };
};

describe("schema modules", () => {
  test("there are modules to check", () => {
    expect(schemaModules.length).toBeGreaterThan(10);
  });

  test("each one loads first in a fresh process", async () => {
    const results = await Promise.all(
      schemaModules.map(async (relative) => ({
        relative,
        ...(await loadAlone(relative)),
      })),
    );
    const failures = results
      .filter((r) => r.code !== 0)
      .map(
        (r) =>
          `${r.relative}: ${r.stderr.split("\n").find((l) => l.includes("Error")) ?? r.stderr}`,
      );
    expect(failures).toEqual([]);
  }, 30_000);
});
