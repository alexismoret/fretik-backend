import {
  compileScript,
  compileStyle,
  compileTemplate,
  parse,
} from "vue/compiler-sfc";
import { badRequest, throwHttpError } from "../../lib/errors";
import {
  PAGE_LIMITS,
  type PageCompiled,
  type PageDefinition,
} from "../../schemas/pages";
import { autofixPageSource, type PageAutofix } from "./autofix";

/**
 * Server-side compile of a page's Vue SFC — validation and build in one step.
 *
 * DELIBERATE DIVERGENCE from the sanitize-don't-reject doctrine that governs
 * the data half: code is binary. A definition with a wrong prop still renders
 * the rest of the page; a module with a syntax error renders NOTHING, so
 * persisting it and warning would report success on a blank screen. A compile
 * failure therefore refuses the write, with errors precise enough for the
 * agent to fix in the same turn (block + message + line where the compiler
 * gives one).
 *
 * The pipeline mirrors what @vitejs/plugin-vue does at build time, minus the
 * bundler: parse → compileScript (inlined template when `<script setup>`) →
 * TS strip (Bun.Transpiler — no type-CHECK in v1; the runtime-error feed
 * closes that loop) → import allowlist (`Bun.Transpiler.scanImports`) →
 * per-page Tailwind CSS (v4 CLI in a subprocess, fed the app's synced theme
 * tokens so utilities resolve against the runtime.css variables).
 */

export const PAGE_RUNTIME_VERSION = "v1";

/** Import specifiers the iframe's import map serves. Anything else cannot
 * resolve at runtime, so it is refused at compile time with its name.
 *
 * ADDING A LIBRARY — four edits, in three packages, and no constant can join
 * them: the Nuxt app is outside this workspace, so it cannot import from here.
 * The list is therefore duplicated by construction; the checklist is the only
 * thing holding it together.
 *
 *   1. `app/page-runtime/src/<name>-entry.ts` re-exporting the surface the
 *      pages may use, plus its `input` in `page-runtime/vite.config.ts`.
 *   2. Every specifier a page may write → that bundle, in the import map
 *      (`app/utils/pageSrcdoc.ts`). A specifier that passes the compiler but
 *      is unmapped fails at MOUNT, in the user's face, instead of at save
 *      with a named error.
 *   3. This set — the compile-time gate.
 *   4. The `## imports` line of `ai/src/tools/page-environment-guide.ts`, so
 *      the builder knows the library exists at all.
 *
 * A library earns a further file under
 * `ai/src/skills/bundled/building-pages/references/libraries/` on ONE test:
 * does misusing it fail SILENTLY? Pragmatic drag-and-drop does — a board whose
 * elements are registered wrongly renders, animates, and never drops, and the
 * visual review clicks rather than drags, so nothing downstream catches it. It
 * has a file. VueUse does not: an absent export fails at MOUNT with a named
 * error and a blank page, which the first render shows. Its curated list in
 * `app/page-runtime/src/vueuse-entry.ts` plus the guide line is the whole
 * documentation it needs. Resist a file per dependency — prose the builder
 * must read is the scarcest thing here.
 */
const ALLOWED_IMPORTS = new Set([
  "vue",
  "@nuxt/ui",
  "#fretik/sdk",
  "chart.js",
  "chart.js/auto",
  "@vueuse/core",
  "@internationalized/date",
  "@atlaskit/pragmatic-drag-and-drop/element/adapter",
  "@atlaskit/pragmatic-drag-and-drop/combine",
  "@atlaskit/pragmatic-drag-and-drop/reorder",
  "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge",
]);

export interface PageCompileError {
  /** Which part refused: structure | script | template | style | imports | tailwind | size. */
  block: string;
  message: string;
  line?: number;
  column?: number;
}

export type PageCompileResult =
  | {
      ok: true;
      compiled: PageCompiled;
      /**
       * Deterministic repairs applied before compiling, and the source they
       * produced. Present only when something was actually changed — and when
       * it is, `source` is what MUST be stored: the compiled artifacts belong
       * to it, and the agent's next edit anchors against it.
       */
      autofixes?: PageAutofix[];
      source?: string;
    }
  | { ok: false; errors: PageCompileError[] };

/** One line per error, agent-facing — travels verbatim inside the 400 that
 * refuses a write, and as dry_run warnings. */
export const formatPageCompileErrors = (errors: PageCompileError[]): string =>
  [
    "Page code failed to compile — nothing was saved. Fix the source and resend it:",
    ...errors.map(
      (error) =>
        `- [${error.block}] ${error.message}${
          error.line !== undefined ? ` (line ${error.line.toString()})` : ""
        }`,
    ),
  ].join("\n");

const packageRoot = new URL("../../..", import.meta.url).pathname;
const themeTokensUrl = new URL(
  "./compile-assets/theme-tokens.css",
  import.meta.url,
);
const themeTokensHashUrl = new URL(
  "./compile-assets/theme-tokens.hash.json",
  import.meta.url,
);

let themeAssetsPromise: Promise<{ css: string; hash: string }> | null = null;
/** The synced app theme tokens (see app/page-runtime/scripts/sync-theme-tokens.ts).
 * Read once — the file only changes with a runtime rebuild + redeploy. */
const themeAssets = (): Promise<{ css: string; hash: string }> => {
  themeAssetsPromise ??= (async () => {
    const [css, hashJson] = await Promise.all([
      Bun.file(themeTokensUrl).text(),
      Bun.file(themeTokensHashUrl).json() as Promise<{ sha256: string }>,
    ]);
    return { css, hash: hashJson.sha256 };
  })();
  return themeAssetsPromise;
};

const sha256 = (text: string): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
};

export const pageSourceHash = async (source: string): Promise<string> => {
  const theme = await themeAssets();
  return sha256(`${source}\0${PAGE_RUNTIME_VERSION}\0${theme.hash}`);
};

interface LocatedError {
  message: string;
  loc?: { start?: { line?: number; column?: number } };
}

const toError = (block: string, error: unknown): PageCompileError => {
  const located = error as LocatedError;
  const message =
    error instanceof Error ? error.message : String(located.message ?? error);
  return {
    block,
    // Compiler messages can embed whole code frames — keep the first lines.
    message: message.split("\n").slice(0, 4).join("\n").slice(0, 1_000),
    line: located.loc?.start?.line,
    column: located.loc?.start?.column,
  };
};

/** Structural rules the compiler does not enforce but the sandbox requires. */
const structuralErrors = (
  descriptor: ReturnType<typeof parse>["descriptor"],
): PageCompileError[] => {
  const errors: PageCompileError[] = [];
  const fail = (block: string, message: string): void => {
    errors.push({ block, message });
  };

  if (!descriptor.template || descriptor.template.content.trim() === "") {
    fail("structure", "the SFC needs a non-empty <template> block.");
  }
  if (descriptor.template?.lang) {
    fail(
      "template",
      "template preprocessors (pug, …) are not supported — write plain HTML.",
    );
  }
  for (const block of [
    descriptor.template,
    descriptor.script,
    descriptor.scriptSetup,
    ...descriptor.styles,
  ]) {
    if (block?.src) {
      fail(
        "structure",
        "`src` imports on SFC blocks are not supported — inline the content.",
      );
    }
  }
  const scriptLang = descriptor.scriptSetup?.lang ?? descriptor.script?.lang;
  if (scriptLang && scriptLang !== "ts" && scriptLang !== "js") {
    fail(
      "script",
      `script lang="${scriptLang}" is not supported — use ts or js.`,
    );
  }
  if (descriptor.script && descriptor.scriptSetup) {
    fail(
      "script",
      "use ONE script block — <script setup> (put non-setup needs in it).",
    );
  }
  for (const style of descriptor.styles) {
    if (style.lang) {
      fail(
        "style",
        `style lang="${style.lang}" is not supported — plain CSS (Tailwind classes cover most needs).`,
      );
    }
    if (/@import\b/.test(style.content) || /\burl\s*\(/.test(style.content)) {
      fail(
        "style",
        "styles may not use @import or url(…) — the sandbox blocks external resources; use Tailwind classes, inline SVG or data: images in the template.",
      );
    }
  }
  return errors;
};

interface SfcOutput {
  js: string;
  css: string;
}

/** parse → compileScript/compileTemplate → assemble one ES module whose
 * default export is the page component and whose footer mounts it. */
const compileSfc = (
  source: string,
):
  | { ok: true; output: SfcOutput }
  | { ok: false; errors: PageCompileError[] } => {
  const { descriptor, errors: parseErrors } = parse(source, {
    filename: "page.vue",
  });
  if (parseErrors.length > 0) {
    return {
      ok: false,
      errors: parseErrors.map((e) => toError("structure", e)),
    };
  }

  const structural = structuralErrors(descriptor);
  if (structural.length > 0) return { ok: false, errors: structural };

  const scopeHash = sha256(source).slice(0, 8);
  const scoped = descriptor.styles.some((style) => style.scoped);
  const scopeId = `data-v-${scopeHash}`;
  const isTs =
    (descriptor.scriptSetup?.lang ?? descriptor.script?.lang) === "ts";

  let js: string;
  try {
    if (descriptor.scriptSetup) {
      const script = compileScript(descriptor, {
        id: scopeHash,
        inlineTemplate: true,
        genDefaultAs: "__page__",
        templateOptions: {
          scoped,
          compilerOptions: scoped ? { scopeId } : undefined,
        },
      });
      js = script.content;
    } else {
      let scriptContent = "const __page__ = {};";
      if (descriptor.script) {
        const script = compileScript(descriptor, {
          id: scopeHash,
          genDefaultAs: "__page__",
        });
        scriptContent = script.content;
      }
      const template = compileTemplate({
        id: scopeHash,
        filename: "page.vue",
        source: descriptor.template?.content ?? "",
        scoped,
        compilerOptions: scoped ? { scopeId } : undefined,
      });
      if (template.errors.length > 0) {
        return {
          ok: false,
          errors: template.errors.map((e) => toError("template", e)),
        };
      }
      js = `${scriptContent}\n${template.code}\n__page__.render = render;`;
    }
  } catch (error) {
    return { ok: false, errors: [toError("script", error)] };
  }

  if (scoped) js += `\n__page__.__scopeId = ${JSON.stringify(scopeId)};`;
  js += `\nimport { mountPage as __fretikMountPage } from "#fretik/sdk";\n__fretikMountPage(__page__);\nexport default __page__;`;

  if (isTs) {
    try {
      js = new Bun.Transpiler({ loader: "ts" }).transformSync(js);
    } catch (error) {
      return { ok: false, errors: [toError("script", error)] };
    }
  }

  let css = "";
  for (const style of descriptor.styles) {
    if (style.scoped) {
      const compiled = compileStyle({
        source: style.content,
        filename: "page.vue",
        id: scopeId,
        scoped: true,
      });
      if (compiled.errors.length > 0) {
        return {
          ok: false,
          errors: compiled.errors.map((e) => toError("style", e)),
        };
      }
      css += `${compiled.code}\n`;
    } else {
      css += `${style.content}\n`;
    }
  }

  return { ok: true, output: { js, css } };
};

/** Refuse any import the iframe's import map cannot serve. */
const importErrors = (js: string): PageCompileError[] => {
  const transpiler = new Bun.Transpiler({ loader: "js" });
  const errors: PageCompileError[] = [];
  for (const found of transpiler.scanImports(js)) {
    if (ALLOWED_IMPORTS.has(found.path)) continue;
    if (found.path.startsWith("./") || found.path.startsWith("../")) {
      errors.push({
        block: "imports",
        message: `relative import "${found.path}" — a page is ONE file; inline the code.`,
      });
      continue;
    }
    errors.push({
      block: "imports",
      message: `import "${found.path}" is not available in the page runtime. Allowed: ${[...ALLOWED_IMPORTS].join(", ")}.`,
    });
  }
  return errors;
};

const TAILWIND_TIMEOUT_MS = 10_000;
/** Tailwind subprocesses are CPU-bound — two at a time is plenty. */
let tailwindSlots = 2;
const tailwindQueue: (() => void)[] = [];

const acquireTailwindSlot = async (): Promise<void> => {
  if (tailwindSlots > 0) {
    tailwindSlots -= 1;
    return;
  }
  await new Promise<void>((resolve) => tailwindQueue.push(resolve));
};

const releaseTailwindSlot = (): void => {
  const next = tailwindQueue.shift();
  if (next) next();
  else tailwindSlots += 1;
};

/**
 * Scratch root for the Tailwind subprocess — `/tmp`, and NOT the source
 * tree.
 *
 * It used to be `${packageRoot}node_modules/.cache/`, which works on a dev
 * machine and fails on EVERY production write: the images install as root and
 * then drop to the unprivileged `bun` user, so nothing under `/app` is
 * creatable at runtime. The symptom hides the cause — `Bun.write` opens first,
 * gets ENOENT, retries after an mkdir that is denied, and reports the ORIGINAL
 * `ENOENT: … open '…/page.vue'`, which reads like a missing file rather than a
 * refused directory.
 */
const SCRATCH_ROOT = "/tmp/fretik-page-css";

let tailwindEntries: { theme: string; utilities: string } | null = null;
/** Resolved lazily: a missing Tailwind must fail the page write, not the
 * service boot. Resolution is what frees the scratch dir from the package —
 * see `compileTailwind`. */
const resolveTailwindEntries = (): { theme: string; utilities: string } => {
  tailwindEntries ??= {
    theme: Bun.resolveSync("tailwindcss/theme.css", packageRoot),
    utilities: Bun.resolveSync("tailwindcss/utilities.css", packageRoot),
  };
  return tailwindEntries;
};

/**
 * Generate the page's utility CSS: Tailwind v4 scans the SFC source and emits
 * ONLY the used utilities, as `var(--…)` references the runtime.css resolves
 * in the iframe.
 *
 * Two hard-won specifics (each broke every page write when wrong):
 * - the two Tailwind entry points are imported by ABSOLUTE path. Tailwind
 *   resolves a bare `@import "tailwindcss/…"` by walking up from the INPUT
 *   FILE's directory (the subprocess cwd is irrelevant), so a scratch dir
 *   outside the package would find no node_modules. Resolving the paths here
 *   instead of pinning the scratch dir under `node_modules/` is what lets it
 *   live in a writable `/tmp` — see SCRATCH_ROOT;
 * - `theme.css` is imported `reference` (token NAMES only — runtime.css owns
 *   the values) while `utilities.css` is NOT: `reference` on the utilities
 *   layer suppresses the scanned output itself, yielding an empty stylesheet.
 */
const compileTailwind = async (
  source: string,
): Promise<
  { ok: true; css: string } | { ok: false; error: PageCompileError }
> => {
  const theme = await themeAssets();
  const entries = resolveTailwindEntries();
  const dir = `${SCRATCH_ROOT}/${Bun.randomUUIDv7()}`;
  const inputCss = [
    `@import "${entries.theme}" layer(theme) reference;`,
    `@import "${entries.utilities}" layer(utilities) source(none);`,
    '@source "./page.vue";',
    theme.css,
  ].join("\n");

  await acquireTailwindSlot();
  try {
    await Bun.write(`${dir}/page.vue`, source);
    await Bun.write(`${dir}/input.css`, inputCss);

    const proc = Bun.spawn(
      [
        "bunx",
        "@tailwindcss/cli",
        "-i",
        `${dir}/input.css`,
        "-o",
        `${dir}/out.css`,
        "--minify",
      ],
      // cwd = this package, where tailwindcss/@tailwindcss/cli are installed —
      // bunx must never fall back to a network install inside a request.
      { cwd: packageRoot, stdout: "pipe", stderr: "pipe" },
    );

    const timeout = setTimeout(() => proc.kill(), TAILWIND_TIMEOUT_MS);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return {
        ok: false,
        error: {
          block: "tailwind",
          message: `Tailwind failed on this source: ${stderr.split("\n").slice(0, 4).join(" ").slice(0, 600) || `exit ${exitCode.toString()}`}`,
        },
      };
    }
    const css = await Bun.file(`${dir}/out.css`).text();
    return { ok: true, css };
  } finally {
    releaseTailwindSlot();
    void Bun.$`rm -rf ${dir}`.quiet().nothrow();
  }
};

/** In-flight dedupe: create + its dry-run (or two turns racing) compile one
 * source once. Keyed by content hash; entries clear on settle. */
const inflight = new Map<string, Promise<PageCompileResult>>();

export const compilePageCode = async (params: {
  source: string;
}): Promise<PageCompileResult> => {
  // Repair first, then hash: the artifacts, the dedupe key and the stored
  // source must all describe the SAME text. Hashing the original would cache a
  // compile under a source nobody keeps.
  const repair = autofixPageSource(params.source);
  const source = repair.source;
  const changed = repair.autofixes.length > 0;

  const key = await pageSourceHash(source);
  const running = inflight.get(key);
  if (running) return running;

  const task = (async (): Promise<PageCompileResult> => {
    if (source.length > PAGE_LIMITS.maxSourceChars) {
      return {
        ok: false,
        errors: [
          {
            block: "size",
            message: `source is ${source.length.toString()} chars; the ceiling is ${PAGE_LIMITS.maxSourceChars.toString()}.`,
          },
        ],
      };
    }

    const sfc = compileSfc(source);
    if (!sfc.ok) return sfc;

    const badImports = importErrors(sfc.output.js);
    if (badImports.length > 0) return { ok: false, errors: badImports };

    const tailwind = await compileTailwind(source);
    if (!tailwind.ok) return { ok: false, errors: [tailwind.error] };

    const css = `${tailwind.css}\n${sfc.output.css}`.trim();
    if (sfc.output.js.length > PAGE_LIMITS.maxCompiledJsChars) {
      return {
        ok: false,
        errors: [
          {
            block: "size",
            message:
              "compiled module exceeds the size ceiling — split or simplify the page.",
          },
        ],
      };
    }
    if (css.length > PAGE_LIMITS.maxCompiledCssChars) {
      return {
        ok: false,
        errors: [
          {
            block: "size",
            message:
              "compiled styles exceed the size ceiling — lean on Tailwind utilities instead of large <style> blocks.",
          },
        ],
      };
    }

    return {
      ok: true,
      compiled: {
        js: sfc.output.js,
        css,
        runtimeVersion: PAGE_RUNTIME_VERSION,
        sourceHash: key,
        compiledAt: new Date().toISOString(),
      },
      ...(changed ? { autofixes: repair.autofixes, source } : {}),
    };
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
};

/**
 * Bring a v3 definition's `compiled` artifacts in line with its `source`, for
 * the write path (create/update):
 * - empty source (data-first draft) → stored without artifacts;
 * - unchanged source (hash matches the incoming or previous compile) → reuse;
 * - otherwise compile, and REFUSE THE WRITE (400, message written for the
 *   agent) when it fails — a page that does not build must not be saved.
 */
export const ensurePageCompiled = async (
  definition: PageDefinition,
  options?: { previous?: PageCompiled },
): Promise<{ definition: PageDefinition; autofixes: PageAutofix[] }> => {
  const source = definition.code.source;
  if (source.trim().length === 0) {
    return { definition: { ...definition, code: { source } }, autofixes: [] };
  }
  const hash = await pageSourceHash(source);
  if (definition.code.compiled?.sourceHash === hash) {
    return { definition, autofixes: [] };
  }
  if (options?.previous?.sourceHash === hash) {
    return {
      definition: {
        ...definition,
        code: { source, compiled: options.previous },
      },
      autofixes: [],
    };
  }
  const result = await compilePageCode({ source });
  if (!result.ok) {
    return throwHttpError(
      400,
      badRequest(formatPageCompileErrors(result.errors)),
    );
  }
  // When a repair fired, the REPAIRED source is what gets stored — the
  // compiled artifacts belong to it, and a stored source the agent's edits
  // could not anchor against would be worse than the mistake it fixed.
  return {
    definition: {
      ...definition,
      code: { source: result.source ?? source, compiled: result.compiled },
    },
    autofixes: result.autofixes ?? [],
  };
};
