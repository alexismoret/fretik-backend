import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  langfuseCredentialsPresent,
  PROMPTS,
} from "../../src/lib/langfuse-prompts/seed";
import { aiReleaseTasks } from "../../src/release-tasks";

/**
 * What this service will do to a deployment, decided from its environment.
 *
 * The runner and its ledger are exercised against Postgres in
 * `@fretik/shared` (`tests/integration/release-tasks/`). What is left here is
 * the half that decides WHETHER a task exists at all — pure env reading, and
 * the half that would quietly turn "publish the prompts on every deploy" into
 * "publish a developer's working copy" or "publish nothing, forever".
 */

const KEYS = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PROMPTS_LOCAL",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    // The preload EMPTIES the Langfuse keys rather than deleting them (a
    // deleted key comes straight back from `dotenv`), so restore the empty
    // string rather than removing the variable.
    process.env[key] = value ?? "";
  }
});

const withCredentials = (): void => {
  process.env["LANGFUSE_PUBLIC_KEY"] = "pk-test";
  process.env["LANGFUSE_SECRET_KEY"] = "sk-test";
  process.env["LANGFUSE_BASE_URL"] = "https://langfuse.invalid";
  process.env["LANGFUSE_PROMPTS_LOCAL"] = "";
};

describe("every managed prompt is a file that exists", () => {
  // This module moved out of `scripts/` on 2026-09-02, which changed how deep
  // `PROJECT_ROOT` has to climb. A wrong depth typechecks and reads fine, and
  // fails only in the container — on every deploy, inside a task whose whole
  // point is that nobody has to watch it.
  test.each(PROMPTS.map((p) => [p.name, p.path] as const))(
    "%s",
    async (_name, path) => {
      expect(await Bun.file(path).exists()).toBe(true);
    },
  );
});

describe("which tasks this container registers", () => {
  const names = (): string[] => aiReleaseTasks().map((t) => t.name);

  test("the audit runs whatever the environment holds", async () => {
    // It only READS, and it reads the database this service already needs in
    // order to boot at all — so there is no environment in which registering
    // it is a decision.
    withCredentials();
    expect(names()).toContain("models-audit");

    process.env["LANGFUSE_PUBLIC_KEY"] = "";
    expect(names()).toContain("models-audit");
  });

  test("with Langfuse credentials, it also publishes prompts", async () => {
    withCredentials();
    expect(names()).toEqual(["langfuse-seed-prompts", "models-audit"]);
  });

  test("with NO credentials, it does not register the publish at all", async () => {
    process.env["LANGFUSE_PUBLIC_KEY"] = "";
    process.env["LANGFUSE_SECRET_KEY"] = "";
    process.env["LANGFUSE_BASE_URL"] = "";

    // Not "registers a task that reports it cannot run": that would be
    // recorded `ok` for this version and never reconsidered, so adding the
    // credentials afterwards would fix nothing until the next deploy. No task
    // means no ledger row, and the next boot decides again.
    expect(names()).not.toContain("langfuse-seed-prompts");
  });

  test("one missing key is as good as none", async () => {
    withCredentials();
    process.env["LANGFUSE_SECRET_KEY"] = "";
    expect(langfuseCredentialsPresent()).toBe(false);
    expect(names()).not.toContain("langfuse-seed-prompts");
  });

  test("a container iterating on prompts locally publishes NOTHING", async () => {
    // `LANGFUSE_PROMPTS_LOCAL` exists so a developer can edit a prompt and see
    // it live without touching the `production` label. A process running with
    // it set is the last one that should be publishing to production.
    withCredentials();
    process.env["LANGFUSE_PROMPTS_LOCAL"] = "true";
    expect(names()).not.toContain("langfuse-seed-prompts");
  });
});
