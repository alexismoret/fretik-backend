import "@hono/zod-openapi";
import { beforeEach, describe, expect, test } from "bun:test";
import { DynamicToolManager } from "../../../../src/agents/shared/dynamic-tools";
import { wrapRuntimeContext } from "../../../../src/agents/shared/runtime-context";
import { getProfileForRole } from "../../../../src/lib/model-registry/resolve";
import { writePageProject } from "../../../../src/services/page-project/store";
import { createPageEditTool } from "../../../../src/tools/page-project/edit";
import { createPageReadTool } from "../../../../src/tools/page-project/read";
import { createPageWriteTool } from "../../../../src/tools/page-project/write";

/**
 * The three tools a build spends most of its steps in, against a real working
 * copy (the in-memory Redis double the preload installs).
 *
 * What is pinned here is the ECONOMY, not the plumbing. Every branch below
 * exists because the alternative was measured costing a whole re-emission: an
 * anchor that missed and was retried five times, a file written back with the
 * line numbers it was read with, a "not found" that gave the model nothing to
 * correct with. A tool that fails without teaching is a tool that gets paid
 * for twice.
 */

const ORIGINAL = [
  "<template>",
  '  <div class="p-6">',
  '    <h1 class="text-xl">Board</h1>',
  '    <UButton color="neutral" @click="go()">Open</UButton>',
  "  </div>",
  "</template>",
  '<script setup lang="ts">',
  "const go = () => {};",
  "</script>",
].join("\n");

let scope = "";

const run = async (
  tool: { execute?: (input: never, options: never) => unknown },
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  if (typeof tool.execute !== "function")
    throw new Error("tool has no execute");
  const ctx = {
    organizationId: "org-1",
    teamId: "team-1",
    conversationId: "conv-1",
    traceId: scope,
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  };
  const result = await tool.execute(
    input as never,
    {
      toolCallId: "tc-1",
      messages: [],
      context: wrapRuntimeContext(ctx),
    } as never,
  );
  if (typeof result !== "object" || result === null) {
    throw new Error("tool returned a non-object");
  }
  return result as Record<string, unknown>;
};

/** A tool-result field as text, whatever shape the tool put in it. */
const text = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? "");

/** One file, the shape most cases here care about. */
const write = (input: Record<string, unknown>) =>
  run(createPageWriteTool(), {
    files: [{ path: input.path, content: input.content }],
    ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
  });

/** The batch, which is what a build is supposed to send. */
const writeMany = (files: { path: string; content: string }[]) =>
  run(createPageWriteTool(), { files });

/** A single file's outcome inside a batch result. */
const outcome = (
  result: Record<string, unknown>,
  path: string,
): Record<string, unknown> => {
  const files = result.files;
  if (!Array.isArray(files)) throw new Error("no files in the result");
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null) continue;
    const record: Record<string, unknown> = { ...entry };
    if (record.path === path) return record;
  }
  throw new Error(`no outcome for ${path}`);
};
const edit = (input: Record<string, unknown>) =>
  run(createPageEditTool(), input);
const read = (input: Record<string, unknown> = {}) =>
  run(createPageReadTool(), input);

beforeEach(() => {
  // A fresh run per test: the working copy is keyed by the trace.
  scope = `trace-${crypto.randomUUID()}`;
});

describe("pageWrite", () => {
  test("writes a file and reports what the write introduced", async () => {
    const result = await write({
      path: "Page.vue",
      content: ORIGINAL.replace(
        '<UButton color="neutral" @click="go()">Open</UButton>',
        "<select><option>a</option></select>",
      ),
    });

    expect(result.written).toBe(1);
    // The lint delta is the whole point of reporting anything here: the review
    // would have blocked on this, two minutes and a render later.
    expect(text(outcome(result, "Page.vue").lintDelta)).toContain(
      "native control",
    );
  });

  test("writes a whole project in ONE call", async () => {
    // The economy this tool exists for. The first multi-file build sent 15
    // writes as 15 steps, and every step re-sent the conversation: 39 model
    // calls, 3.25M input tokens, a bill 19% above the single-file design it
    // replaced. A batch is one step whatever the model's mood.
    const result = await writeMany([
      { path: "Page.vue", content: ORIGINAL },
      {
        path: "components/Lane.vue",
        content: "<template><p>lane</p></template>",
      },
      {
        path: "composables/useData.ts",
        content: "export const useData = () => ({});",
      },
      { path: "page.json", content: '{ "name": "Board", "datasets": [] }' },
    ]);

    expect(result.written).toBe(4);
    const manifest = await read({});
    expect(text(manifest.manifest ?? manifest.project)).toContain(
      "components/Lane.vue",
    );
  });

  test("page.json is a file this tool can write", async () => {
    // It was not, until 2026-09-04: `PAGE_FILE_PATH_RE` validates `code.files`,
    // which reaches the compiler, and page.json is not code — so the write path
    // refused the ONE file that declares a page's datasets. The builder worked
    // around the refusal by putting four dataset configs in a lib module, the
    // server ran none of them, and the page shipped empty.
    const result = await write({
      path: "page.json",
      content: '{ "name": "Deals", "datasets": [] }',
    });

    expect(result.written).toBe(1);
    expect(outcome(result, "page.json").error).toBeUndefined();
  });

  test("one bad path in a batch does not cost the good ones", async () => {
    const result = await writeMany([
      { path: "Page.vue", content: ORIGINAL },
      { path: "src/deep/Thing.vue", content: "<template><div /></template>" },
    ]);

    expect(result.written).toBe(1);
    // Named, because a file the model believes it wrote and did not is a
    // defect that surfaces three steps later as a missing import.
    expect(text(result.refused)).toContain("src/deep/Thing.vue");
  });

  test("refuses its own output pasted back", async () => {
    // `pageRead` numbers its lines. A model that copies that back writes a
    // file where every line starts with a number — it compiles to nothing, and
    // the error the compiler gives points at line 1 of everything.
    const result = await write({
      path: "Page.vue",
      content: [
        "    1\t<template>",
        "    2\t  <div>hi</div>",
        "    3\t</template>",
      ].join("\n"),
    });

    expect(result.code).toBe("INVALID_ARGS");
    expect(String(result.error)).toContain("line numbers");
  });

  test("refuses a path the project cannot have, and says which shapes it can", async () => {
    const result = await write({
      path: "src/deep/Thing.vue",
      content: "<template><div /></template>",
    });

    expect(result.code).toBe("INVALID_ARGS");
    expect(String(result.hint)).toContain("components/");
  });

  test("names a component file as usable by name", async () => {
    const result = await write({
      path: "components/LaneBoard.vue",
      content: "<template><div>lane</div></template>",
    });
    expect(result.written).toBe(1);

    // And it is in the project: the manifest is what a later step reads.
    const manifest = await read({});
    expect(text(manifest.manifest ?? manifest.project)).toContain(
      "components/LaneBoard.vue",
    );
  });
});

describe("pageEdit", () => {
  const seed = async () => {
    await write({ path: "Page.vue", content: ORIGINAL });
  };

  test("refuses to edit a file this run has never read", async () => {
    // The repair path: the working copy was seeded from the STORED page, so
    // the files exist and the run has seen none of them. An anchor composed
    // from memory there is an anchor from another page — and a miss costs more
    // than the read it skipped.
    await writePageProject(scope, {
      files: { "Page.vue": ORIGINAL },
      seen: {},
    });

    const result = await edit({
      oldString: 'color="neutral"',
      newString: 'color="primary"',
    });

    expect(result.code).toBe("INVALID_ARGS");
    expect(String(result.error)).toContain("not read");
    expect(String(result.hint)).toContain("pageRead");
  });

  test("…and a read clears the way", async () => {
    await writePageProject(scope, {
      files: { "Page.vue": ORIGINAL },
      seen: {},
    });
    await read({ path: "Page.vue" });

    const result = await edit({
      oldString: 'color="neutral"',
      newString: 'color="primary"',
    });
    expect(result.applied).toBe(true);
  });

  test("a file that does not exist is a different answer, and names the ones that do", async () => {
    await seed();
    const result = await edit({
      path: "components/Nope.vue",
      oldString: "a",
      newString: "b",
    });

    expect(result.code).toBe("NOT_FOUND");
    expect(String(result.hint)).toContain("Page.vue");
  });

  test("applies an exact anchor and reports where it landed", async () => {
    await seed();
    const result = await edit({
      oldString: 'color="neutral"',
      newString: 'color="primary"',
    });

    expect(result.applied).toBe(true);
    expect(String(result.at)).toContain("line 4");
  });

  test("forgives an indent the model did not reproduce", async () => {
    await seed();
    // The measured failure mode: a multi-line anchor quoted flat, or one level
    // off, from a context window. The code is identical; only the leading
    // whitespace differs, and a strict matcher answers "not found" — which
    // costs a re-read, then a rewrite of the whole file.
    const result = await edit({
      oldString: [
        '<h1 class="text-xl">Board</h1>',
        '<UButton color="neutral" @click="go()">Open</UButton>',
      ].join("\n"),
      newString: [
        '<h1 class="text-2xl">Board</h1>',
        '<UButton color="primary" @click="go()">Open</UButton>',
      ].join("\n"),
    });

    expect(result.applied).toBe(true);
    // Named, so the model learns its anchor drifted rather than believing it
    // was exact — and so a strategy that quietly swallowed the others would
    // show up here instead of passing silently.
    expect(result.matchedBy).toBe("indentation");

    // The replacement is re-indented to where it landed: a correctly-edited
    // file with a visibly broken shape is still a defect.
    const after = await read({ path: "Page.vue", offset: 1, limit: 6 });
    expect(text(after.content)).toContain('    <h1 class="text-2xl">');
  });

  test("refuses an ambiguous anchor and shows the candidates", async () => {
    await write({
      path: "Page.vue",
      content: [
        "<template>",
        '  <div class="p-4">one</div>',
        '  <div class="p-4">two</div>',
        "</template>",
      ].join("\n"),
    });
    const result = await edit({
      oldString: 'class="p-4"',
      newString: 'class="p-6"',
    });

    expect(result.code).toBe("INVALID_ARGS");
    expect(String(result.error)).toContain("2 times");
    // The recovery is IN the answer: the lines, so the next call can add
    // context instead of guessing.
    expect(String(result.error)).toContain("L2");
    expect(String(result.hint)).toContain("replaceAll");
  });

  test("replaceAll changes every occurrence", async () => {
    await write({
      path: "Page.vue",
      content: [
        "<template>",
        '  <div class="p-4">one</div>',
        '  <div class="p-4">two</div>',
        "</template>",
      ].join("\n"),
    });
    const result = await edit({
      oldString: 'class="p-4"',
      newString: 'class="p-6"',
      replaceAll: true,
    });

    expect(result.applied).toBe(true);
    expect(result.occurrences).toBe(2);
  });

  test("an edit already applied is a success, not a failure to reason about", async () => {
    await seed();
    await edit({
      oldString: 'color="neutral"',
      newString: 'color="primary"',
    });
    const again = await edit({
      oldString: 'color="neutral"',
      newString: 'color="primary"',
    });

    expect(again.alreadyApplied).toBe(true);
    expect(again.applied).toBe(false);
  });

  test("a missed anchor comes back with what the file actually says", async () => {
    await seed();
    const result = await edit({
      oldString: '<UButton color="danger">Open</UButton>',
      newString: '<UButton color="error">Open</UButton>',
    });

    expect(result.code).toBe("INVALID_ARGS");
    // "Not found" alone leaves the model guessing; the nearest real line is
    // what turns a miss into a correction.
    expect(String(result.hint)).toContain("Did you mean");
  });

  test("after three misses on one file, the advice changes", async () => {
    await seed();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- the counter is the subject
      await edit({ oldString: `nothing like this ${attempt}`, newString: "x" });
    }
    const third = await edit({ oldString: "still nothing", newString: "x" });

    // Escalation, not repetition: a fourth re-anchor costs more than the
    // rewrite it is avoiding.
    expect(String(third.hint)).toContain("pageWrite it whole");
  });

  test("an identical edit is refused before anything is touched", async () => {
    await seed();
    const result = await edit({ oldString: "Board", newString: "Board" });
    expect(result.code).toBe("INVALID_ARGS");
  });
});

describe("pageRead", () => {
  test("re-reading what you just wrote returns the FACT, not the bytes", async () => {
    // The file is already in the context that asked for it. Re-sending it is
    // the cheapest possible way to spend a step budget.
    await write({ path: "Page.vue", content: ORIGINAL });
    const result = await read({ path: "Page.vue" });

    expect(result.unchanged).toBe(true);
    expect(String(result.notice)).toContain("use that result");
  });

  test("numbers the lines it does return", async () => {
    await write({ path: "Page.vue", content: ORIGINAL });
    // An explicit window is a deliberate re-read, so the dedup stands aside.
    const result = await read({ path: "Page.vue", offset: 1, limit: 3 });

    const content = text(result.content ?? result.source);
    expect(content).toContain("\t<template>");
    expect(content.split("\n")[0]).toMatch(/^\s+1\t/);
    expect(content.split("\n")).toHaveLength(3);
  });

  test("with no path, it is the manifest — the project's shape", async () => {
    await write({ path: "Page.vue", content: ORIGINAL });
    await write({
      path: "components/Lane.vue",
      content: "<template><p>lane</p></template>",
    });

    const result = await read({});
    const manifest = text(result.manifest ?? result.project);
    expect(manifest).toContain("Page.vue");
    expect(manifest).toContain("components/Lane.vue");
  });
});
