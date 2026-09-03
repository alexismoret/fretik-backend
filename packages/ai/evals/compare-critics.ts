/**
 * Which model should JUDGE a generated page. Not a test file — a protocol you
 * re-run before repointing the `page-review` binding.
 *
 * The question a critic has to answer is not "is this pretty" but "what is
 * wrong with it, and is any of that made up". So the protocol is the one that
 * settled the binding on 2026-08-15: take pages whose defects are already
 * known, render each ONCE, and hand the same screenshots to every candidate.
 * A critic earns the role by naming the real defects and inventing none —
 * a hallucinated finding is worse than a missed one, because the builder
 * spends a whole fix round (~3 ¢ and a minute) chasing it.
 *
 * Rendering once and sharing the shots is what makes the comparison fair: the
 * candidates differ only in what they SAW, never in what was drawn.
 *
 *   bun evals/compare-critics.ts --page <uuid>:<expected defect> [--page …]
 *                                [--critic <profileKey>]…
 *
 * Needs what `managePage { action: "review" }` needs — a browser on $PATH (or
 * PAGE_RENDER_BROWSER_WS) and the runtime assets (PAGE_RUNTIME_DIR / APP_URL).
 */

// Patches zod with `.openapi()`, which `@fretik/shared/schemas/*` calls at
// module load. It cannot protect a STATIC `@fretik/*` import: the formatter
// sorts those above `@hono/*`, so they would run first and throw
// "z.uuid().openapi is not a function". Hence the dynamic imports in `main`.
import type { PageRenderShot } from "@fretik/shared/services/pages/render/types";
import "@hono/zod-openapi";

interface Subject {
  pageId: string;
  /** What a competent critic MUST see. Free text — you read the verdict. */
  expected: string;
}

const parseArgs = (
  argv: string[],
): { subjects: Subject[]; critics: string[] } => {
  const subjects: Subject[] = [];
  const critics: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === "--page" && next) {
      const at = next.indexOf(":");
      subjects.push(
        at === -1
          ? { pageId: next, expected: "(unstated)" }
          : { pageId: next.slice(0, at), expected: next.slice(at + 1) },
      );
      i++;
      continue;
    }
    if (argv[i] === "--critic" && next) {
      critics.push(next);
      i++;
      continue;
    }
    console.error(`[critics] unrecognised argument: ${argv[i] ?? ""}`);
    process.exit(2);
  }
  return { subjects, critics };
};

const main = async (): Promise<void> => {
  const [
    { renderPage },
    { getPage },
    { evaluatePageDesign },
    { gatePageRender },
  ] = await Promise.all([
    import("@fretik/shared/services/pages/render/render-page"),
    import("@fretik/shared/services/pages/retrieve"),
    import("../src/services/page-review/evaluate"),
    import("../src/services/page-review/gate"),
  ]);
  const { subjects, critics } = parseArgs(process.argv.slice(2));
  const teamId = process.env.EVAL_TEAM_ID ?? "";
  if (subjects.length === 0 || critics.length === 0 || teamId === "") {
    console.error(
      "[critics] need --page <uuid>[:expected] and --critic <profileKey>, plus EVAL_TEAM_ID",
    );
    process.exit(2);
  }

  for (const subject of subjects) {
    const page = await getPage({ pageId: subject.pageId, teamId });
    const compiled = page.definition.code.compiled;
    if (!compiled) {
      console.error(`\n### ${page.name} — no compiled code, skipped`);
      continue;
    }
    const render = await renderPage({
      compiled,
      definition: page.definition,
      teamId,
      userId: process.env.EVAL_USER_ID ?? null,
      pageName: page.name,
    });
    if (render.degraded !== undefined || !render.mounted) {
      console.error(
        `\n### ${page.name} — RIG: ${render.degraded ?? "never mounted"}`,
      );
      continue;
    }
    const gate = gatePageRender(render, {
      declaredDatasets: page.definition.datasets.length,
      declaredOperations: page.definition.operations.length,
    });
    const shots: PageRenderShot[] = render.shots;

    console.log(`\n${"=".repeat(78)}`);
    console.log(`### ${page.name}`);
    console.log(`expected: ${subject.expected}`);
    console.log(
      `gate: ${gate.blocking.length > 0 ? gate.blocking.join(" | ") : "clean"}`,
    );

    for (const critic of critics) {
      const started = Date.now();
      const result = await evaluatePageDesign({
        pageName: page.name,
        brief: page.definition.brief,
        shots,
        known: gate.blocking,
        criticProfileKey: critic,
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (!result.ok) {
        console.log(
          `\n-- ${critic} (${seconds}s) → UNAVAILABLE: ${result.reason}`,
        );
        continue;
      }
      const { critique } = result;
      console.log(
        `\n-- ${critic} (${seconds}s) → ${critique.score.toFixed(1)}/10 ` +
          `(d${critique.scores.design.toString()} f${critique.scores.functionality.toString()} ` +
          `c${critique.scores.craft.toString()} o${critique.scores.originality.toString()})`,
      );
      console.log(`   ${critique.summary}`);
      for (const finding of critique.findings) {
        console.log(
          `   [${finding.severity}] ${finding.where} — ${finding.problem}`,
        );
      }
    }
  }
  process.exit(0);
};

main().catch((error: unknown) => {
  console.error("[critics] fatal:", error);
  process.exit(3);
});
