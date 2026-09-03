import { describe, expect, test } from "bun:test";
// The contract reaches `schemas/pages` → `common/params`, which calls
// `.openapi()` — patched onto Zod by this import and, in a service, by boot.
import "@hono/zod-openapi";
import { join } from "node:path";
import { renderPageDesignDoctrine } from "../../../src/agents/chatbot/page-design-doctrine";
import { BUNDLED_SKILLS_DIR } from "../../../src/skills/paths";
import {
  PAGE_ENVIRONMENT_GUIDE,
  renderPageEnvironmentContract,
} from "../../../src/tools/page-environment-guide";

/**
 * The builder knows its own environment without asking.
 *
 * It writes a page on every single run, so spending a tool step to fetch a
 * contract that never varies was a step spent on nothing. The contract is
 * appended to its system prompt instead — which only works while the text is
 * DETERMINISTIC, because a prefix that changes between turns is a prefix that
 * never hits the cache.
 */

describe("page environment contract", () => {
  test("is byte-identical across calls, so it can sit in a cached prefix", () => {
    expect(renderPageEnvironmentContract()).toBe(
      renderPageEnvironmentContract(),
    );
  });

  test("carries what the model cannot know from training", () => {
    const contract = renderPageEnvironmentContract();
    // The runtime half: how the project is laid out, what may be imported,
    // what the bridge offers, what the sandbox forbids.
    expect(contract).toContain("## the project");
    expect(contract).toContain("## imports");
    expect(contract).toContain("## controls");
    expect(contract).toContain("## the bridge");
    expect(contract).toContain("## sandbox rules");
    // The data half: the grammar a definition has to be written in.
    expect(contract).toContain("## datasets");
    expect(contract).toContain("## variables");
    expect(contract).toContain("## operations");
  });

  test("is the same text `get_guide` serves — one source, two consumers", () => {
    expect(renderPageEnvironmentContract()).toContain(PAGE_ENVIRONMENT_GUIDE);
  });

  /**
   * The two halves are budgeted apart because they answer to different rules.
   *
   * A single cap on the total conflated them, and the conflation had a cost:
   * measured 2026-08-22, 5 252 of the contract's 11 983 characters — 44% — are
   * `describePageDataContract()`, GENERATED from the Zod schema. So adding a
   * dataset kind or an operation kind, which is adding CAPABILITY, ate the
   * budget meant to keep hand-written doctrine disciplined, and the way to make
   * the suite green again was to delete prose that had nothing to do with it.
   *
   * The prose half gets the tight bound, because that is where padding lives.
   * The generated half gets a loose backstop — it tracks the schema, and the
   * schema is allowed to grow — so what it catches is a description that has
   * run away, not a feature being added.
   */
  test("the hand-written half stays small enough to live in a prompt", () => {
    // A contract that grows without bound stops being a contract and starts
    // being a manual the model skims. Every sentence here is one the builder
    // reads before writing a line, on every single build.
    //
    // 7 500 → 10 000 on 2026-09-03, when a page became a PROJECT: the guide
    // gained the file grammar, the Nuxt-UI-not-native control rule, the Vue
    // pitfalls sheet and the never-invent-rows rule — five things it must now
    // enumerate, not five paragraphs of appetite. The budget follows what the
    // section has to list; growth with nothing new listed is padding.
    expect(PAGE_ENVIRONMENT_GUIDE.length).toBeLessThan(10_000);
  });

  test("the generated half tracks the schema, and only the schema", () => {
    const generated =
      renderPageEnvironmentContract().length - PAGE_ENVIRONMENT_GUIDE.length;
    // Loose on purpose: this text is the data grammar the schema describes, and
    // a new dataset or operation kind SHOULD lengthen it. The bound exists so a
    // description that doubled would still be noticed.
    expect(generated).toBeGreaterThan(0);
    expect(generated).toBeLessThan(12_000);
  });

  test("carries the two rules whose failure is SILENT", () => {
    // A class or an icon name assembled at runtime compiles to nothing and
    // raises nothing. Both used to live only in the skill — a file the builder
    // might not open — so they moved to the one text it always has.
    const contract = renderPageEnvironmentContract();
    expect(contract).toContain("never build a class name at runtime");
    expect(contract).toContain("NEVER wrap them");
  });

  test("forbids invented rows where the model cannot miss it", () => {
    // The one defect neither the compiler nor the review can catch: a page
    // filled from a `mockData()` renders beautifully and is a lie. It lived in
    // `data.md` — a file the builder may never open — while a build over an
    // unconnected app shipped 78 fabricated rows and claimed "simulation mode"
    // (Langfuse `01a03e9b…`, 2026-08-26). A rule that must hold on every build
    // belongs in the text the builder always has.
    expect(renderPageEnvironmentContract()).toContain("NEVER invent rows");
  });
});

describe("page design doctrine", () => {
  test("is the skill's own files, not a copy of them", async () => {
    // The point of appending rather than authoring: one source, two consumers.
    // A paraphrase here would be a second home for design doctrine, and the
    // two would part company the week either side improved.
    const doctrine = renderPageDesignDoctrine();
    for (const name of ["design.md", "taste.md"]) {
      const source = await Bun.file(
        join(BUNDLED_SKILLS_DIR, "building-pages", "references", name),
      ).text();
      expect(doctrine).toContain(source.trim());
    }
  });

  test("is byte-identical across calls, so it can sit in a cached prefix", () => {
    expect(renderPageDesignDoctrine()).toBe(renderPageDesignDoctrine());
  });

  test("states the capability floor in countable terms", () => {
    // "Make it rich" is not checkable and does not survive a rewrite. The floor
    // is written as things a reviewer can count, which is the only form a
    // default can take without becoming taste.
    const doctrine = renderPageDesignDoctrine();
    expect(doctrine).toContain("### The floor");
    expect(doctrine).toContain("A writable type means a write.");
  });
});
