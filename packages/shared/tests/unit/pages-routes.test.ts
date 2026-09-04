import { describe, expect, test } from "bun:test";
// `schemas/pages` reaches `common/params`, which calls `.openapi()` — patched
// into Zod by this import, and only by it.
import "@hono/zod-openapi";
import {
  PAGE_FILE_PATH_RE,
  type PageDefinition,
} from "../../src/schemas/pages";
import { compilePageCode } from "../../src/services/pages/compile";
import { lintPageProject } from "../../src/services/pages/lint";
import { renderPage } from "../../src/services/pages/render/render-page";
import { closeRenderViews } from "../../src/services/pages/render/webview";
import {
  derivePageRoutes,
  formatRouteTable,
} from "../../src/services/pages/routes";

/**
 * A page with views of its own.
 *
 * The claim under test is that the ADDRESS is the file path and nothing else:
 * no declaration in `page.json` to disagree with the files, no table the agent
 * maintains by hand. Everything downstream — the manifest, the host URL, the
 * review's per-view captures — reads the same derivation, so if it is wrong
 * here it is wrong in four places at once.
 */

const SHELL = `<template>
  <div class="p-6 space-y-4">
    <nav class="flex gap-3">
      <ULink to="/">Overview</ULink>
      <ULink to="/deal/7">A deal</ULink>
    </nav>
    <RouterView />
  </div>
</template>`;

const VIEWS: Record<string, string> = {
  "pages/index.vue": `<template>
  <div>
    <h1 class="text-2xl font-display tracking-tight">Every deal</h1>
    <DealRow label="Acme" />
  </div>
</template>`,
  // Two directories down: the component registry is at the build root, so this
  // file reaching <DealRow> at all is the depth-2 specifier working.
  "pages/deal/[id].vue": `<template>
  <div>
    <p class="text-sm">Deal {{ route.params.id }}</p>
    <DealRow :label="String(route.params.id)" />
  </div>
</template>

<script setup lang="ts">
import { useRoute } from "vue-router";
const route = useRoute();
</script>`,
  "components/DealRow.vue": `<template>
  <p class="text-sm text-muted">{{ label }}</p>
</template>

<script setup lang="ts">
defineProps<{ label: string }>();
</script>`,
};

const definitionFor = (
  compiled: PageDefinition["code"]["compiled"],
): PageDefinition => ({
  version: 3,
  variables: [],
  datasets: [],
  operations: [],
  code: { source: SHELL, files: VIEWS, compiled },
});

describe("the pages/ grammar", () => {
  test("accepts one level of nesting, and a param only below it", () => {
    for (const path of [
      "pages/index.vue",
      "pages/activity.vue",
      "pages/activity/index.vue",
      "pages/activity/[id].vue",
      "pages/settings/team.vue",
    ]) {
      expect(PAGE_FILE_PATH_RE.test(path)).toBe(true);
    }

    for (const path of [
      // Would answer at `/anything` and swallow every static view.
      "pages/[id].vue",
      "pages/a/b/c.vue",
      "pages/Activity.vue",
      "pages/a/[Id].vue",
      "pages/a/[id]/b.vue",
      "pages/a/[id].ts",
    ]) {
      expect(PAGE_FILE_PATH_RE.test(path)).toBe(false);
    }
  });
});

describe("deriving routes from files", () => {
  test("the path is the file, and index names its directory", () => {
    const result = derivePageRoutes([
      "components/Foo.vue",
      "pages/deal/[id].vue",
      "pages/index.vue",
      "pages/settings/team.vue",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routes).toEqual([
      { path: "/", name: "index", file: "pages/index.vue", params: [] },
      {
        path: "/deal/:id",
        name: "deal-id",
        file: "pages/deal/[id].vue",
        params: ["id"],
      },
      {
        path: "/settings/team",
        name: "settings-team",
        file: "pages/settings/team.vue",
        params: [],
      },
    ]);
  });

  test("a project with no pages/ declares no routes at all", () => {
    const result = derivePageRoutes(["components/Foo.vue", "lib/format.ts"]);
    expect(result).toEqual({ ok: true, routes: [] });
  });

  test("two files for one address is refused, not resolved by order", () => {
    const result = derivePageRoutes([
      "pages/index.vue",
      "pages/activity.vue",
      "pages/activity/index.vue",
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain('both answer at "/activity"');
  });

  test("views with no index leave the page blank on arrival", () => {
    const result = derivePageRoutes(["pages/activity.vue"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("pages/index.vue");
    expect(formatRouteTable(result)).toStartWith("(invalid —");
  });
});

describe("compiling a page that has views", () => {
  test("mounts with its route table, and links the views from two levels down", async () => {
    const result = await compilePageCode({ source: SHELL, files: VIEWS });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));

    // The table the SDK mounts with — paths and names, in the bundle.
    expect(result.compiled.js).toContain(
      `{ path: "/", name: "index", component:`,
    );
    expect(result.compiled.js).toContain(
      `{ path: "/deal/:id", name: "deal-id", component:`,
    );
    // The bundler renames the entry's component binding when it concatenates,
    // so the stable half is the call and its options.
    expect(result.compiled.js).toMatch(
      /__fretikMountPage\(__page__\d*, \{ routes \}\)/,
    );
    // `vue-router` resolves through the import map, like `vue` — a bundled
    // second copy would give the views a router the shell is not on.
    expect(result.compiled.js).toContain('from "vue-router"');
    // Two directories down, `../../__components.js` — the depth-1 specifier
    // this replaced would have resolved to `pages/__components.js`, and the
    // bundler would have refused the link with a file the agent never wrote.
    expect(result.compiled.js).toContain("DealRow");
  }, 30_000);

  test("a page with no views mounts exactly as it always did", async () => {
    const result = await compilePageCode({
      source: `<template><div class="p-6">Alone</div></template>`,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.compiled.js).toContain("__fretikMountPage(__page__);");
    expect(result.compiled.js).not.toContain("routes");
  }, 30_000);

  test("an incoherent pages/ directory refuses the compile", async () => {
    const result = await compilePageCode({
      source: SHELL,
      files: { "pages/deal/[id].vue": `<template><p>x</p></template>` },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.message).toContain("pages/index.vue");
  }, 30_000);
});

describe("what the lints say about views", () => {
  test("a shell with no outlet is refused: every view is unreachable", () => {
    const findings = lintPageProject({
      source: `<template><div class="p-6"><h1 class="text-2xl">No outlet</h1></div></template>`,
      files: VIEWS,
    });
    const missing = findings.find(
      (finding) => finding.rule === "router-view-missing",
    );
    expect(missing?.severity).toBe("error");
    expect(missing?.path).toBe("Page.vue");
  });

  test("a page with no views is never asked for an outlet", () => {
    const findings = lintPageProject({
      source: `<template><div class="p-6">Alone</div></template>`,
    });
    expect(findings.map((finding) => finding.rule)).not.toContain(
      "router-view-missing",
    );
  });

  test("a link to an address no file answers is a warning, once per address", () => {
    const findings = lintPageProject({
      source: `<template>
  <div class="p-6">
    <ULink to="/nope">gone</ULink>
    <ULink to="/nope">gone again</ULink>
    <ULink to="/deal/7">fine</ULink>
    <ULink :to="\`/deal/\${row.id}\`">also fine</ULink>
    <RouterView />
  </div>
</template>`,
      files: VIEWS,
    });
    const unknown = findings.filter(
      (finding) => finding.rule === "route-link-unknown",
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.severity).toBe("warning");
    expect(unknown[0]?.message).toContain('"/nope"');
  });
});

describe("a page with views in a real browser", () => {
  test("mounts on its index view, with the router the shell and the views share", async () => {
    const compileResult = await compilePageCode({
      source: SHELL,
      files: VIEWS,
    });
    if (!compileResult.ok)
      throw new Error(JSON.stringify(compileResult.errors));

    const result = await renderPage({
      compiled: compileResult.compiled,
      definition: definitionFor(compileResult.compiled),
      teamId: "00000000-0000-7000-8000-000000000000",
      userId: null,
      pageName: "Routes probe",
    });

    // No browser here (CI without Chrome) is not a page defect.
    if (result.degraded !== undefined) {
      expect(result.shots).toHaveLength(0);
      return;
    }

    expect(result.mounted).toBe(true);
    expect(result.pageErrors).toEqual([]);
    // `useRoute()` returning undefined — the failure a second vue-router
    // instance causes — throws inside the view and leaves the outlet empty.
    expect(result.consoleErrors.join(" ")).not.toContain("resolve component");
    expect(result.layout["desktop"]?.textLength ?? 0).toBeGreaterThan(0);

    closeRenderViews();
  }, 120_000);
});
