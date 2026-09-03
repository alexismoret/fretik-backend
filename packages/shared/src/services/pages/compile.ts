import {
  compileScript,
  compileStyle,
  compileTemplate,
  parse,
} from "vue/compiler-sfc";
import { badRequest, throwHttpError } from "../../lib/errors";
import {
  eachPageFile,
  PAGE_ENTRY_FILE,
  PAGE_LIMITS,
  pageCodeChars,
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
  /** Which file of the project, when it is not the entry. */
  file?: string;
}

export type PageCompileResult =
  | {
      ok: true;
      compiled: PageCompiled;
      /**
       * Deterministic repairs applied before compiling, and the files they
       * produced. Present only when something was actually changed — and when
       * it is, these are what MUST be stored: the compiled artifacts belong to
       * them, and the agent's next edit anchors against them.
       */
      autofixes?: PageAutofix[];
      source?: string;
      files?: Record<string, string>;
    }
  | { ok: false; errors: PageCompileError[] };

/** One line per error, agent-facing — travels verbatim inside the 400 that
 * refuses a write, and as dry_run warnings. */
export const formatPageCompileErrors = (errors: PageCompileError[]): string =>
  [
    "Page code failed to compile — nothing was saved. Fix the source and resend it:",
    ...errors.map(
      (error) =>
        `- ${error.file !== undefined ? `${error.file} ` : ""}[${error.block}] ${error.message}${
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

/**
 * The recompile trigger for a whole project.
 *
 * A one-file page hashes exactly as it always did — same bytes, same key, so
 * nothing already stored is invalidated by the arrival of the project model.
 * With files, every path and every byte goes in: renaming a component changes
 * the build even when the text does not.
 */
export const pageProjectHash = async (
  project: [string, string][],
): Promise<string> => {
  const [entry, ...rest] = project;
  if (rest.length === 0) return await pageSourceHash(entry?.[1] ?? "");
  const theme = await themeAssets();
  const body = project
    .map(([path, content]) => `${path}\0${content}`)
    .join("\0");
  return sha256(`${body}\0${PAGE_RUNTIME_VERSION}\0${theme.hash}`);
};

interface LocatedError {
  message: string;
  loc?: { start?: { line?: number; column?: number } };
}

/**
 * A `generateCodeFrame` caret row — `   |        ^`. Vue prints its frame with
 * `range = 2`, so the caret sits ~3 rows below the frame's first line.
 */
const CARET_ROW = /^\s*\|\s*\^+\s*$/;
const MAX_MESSAGE_LINES = 14;
const MAX_MESSAGE_CHARS = 2_000;

/**
 * Keep the compiler's message AND the whole code frame down to its caret.
 *
 * This used to be `slice(0, 4)`, which — for a thrown babel error inside
 * `[vue/compiler-sfc]` — kept the message, a blank line, `page.vue`, and
 * exactly ONE frame row: the line two ABOVE the error. The offending line and
 * the caret under it were always cut off. On 2026-08-28 that cost an agent
 * seven identical retries against an invisible combining accent it was never
 * shown. An error frame that omits the thing it points at is not an error
 * message.
 */
const trimCompilerMessage = (message: string): string => {
  const lines = message.split("\n");
  const caretAt = lines.findIndex((line) => CARET_ROW.test(line));
  // Two rows past the caret keeps the frame's trailing context; with no caret
  // (a plain message, no frame) the old four-line budget is already generous.
  const keep = caretAt === -1 ? 4 : Math.min(caretAt + 3, MAX_MESSAGE_LINES);
  return lines.slice(0, keep).join("\n").slice(0, MAX_MESSAGE_CHARS);
};

/**
 * Name the codepoint a lexer choked on. `Unexpected character '́'` prints the
 * character itself, and the characters that actually reach this path are the
 * ones nothing renders: a combining mark shows as an accent on whatever
 * precedes it, a zero-width joiner shows as nothing at all. Told `U+0301`, an
 * agent can find and delete it; shown the glyph, it cannot.
 */
const UNEXPECTED_CHAR = /Unexpected character '(.)'/u;
const describeUnexpectedChar = (message: string): string => {
  const match = UNEXPECTED_CHAR.exec(message);
  const whole = match?.[0];
  const char = match?.[1];
  if (whole === undefined || char === undefined) return message;
  const code = char.codePointAt(0);
  if (code === undefined) return message;
  const hex = code.toString(16).toUpperCase().padStart(4, "0");
  return message.replace(
    whole,
    `Unexpected character U+${hex} (invisible in most editors — delete it, do not retype the line around it)`,
  );
};

const toError = (block: string, error: unknown): PageCompileError => {
  const located = error as LocatedError;
  const message =
    error instanceof Error ? error.message : String(located.message ?? error);
  return {
    block,
    message: trimCompilerMessage(describeUnexpectedChar(message)),
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

/**
 * parse → compileScript/compileTemplate → one ES module per SFC.
 *
 * The ENTRY's module mounts itself (`mountPage`); every other file exports its
 * component and nothing more — it is imported, not run.
 */
const compileSfc = (
  source: string,
  options: { path: string; isEntry: boolean } = {
    path: PAGE_ENTRY_FILE,
    isEntry: true,
  },
):
  | { ok: true; output: SfcOutput }
  | { ok: false; errors: PageCompileError[] } => {
  const filename = options.isEntry ? "page.vue" : options.path;
  const at = (errors: PageCompileError[]): PageCompileError[] =>
    options.isEntry
      ? errors
      : errors.map((error) => ({ ...error, file: options.path }));

  const { descriptor, errors: parseErrors } = parse(source, { filename });
  if (parseErrors.length > 0) {
    return {
      ok: false,
      errors: at(parseErrors.map((e) => toError("structure", e))),
    };
  }

  const structural = structuralErrors(descriptor);
  if (structural.length > 0) return { ok: false, errors: at(structural) };

  // Salted with the path: two files with identical content would otherwise
  // share a scope id, and one's scoped styles would leak into the other.
  const scopeHash = sha256(`${options.path}\0${source}`).slice(0, 8);
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
        filename,
        source: descriptor.template?.content ?? "",
        scoped,
        compilerOptions: scoped ? { scopeId } : undefined,
      });
      if (template.errors.length > 0) {
        return {
          ok: false,
          errors: at(template.errors.map((e) => toError("template", e))),
        };
      }
      js = `${scriptContent}\n${template.code}\n__page__.render = render;`;
    }
  } catch (error) {
    return { ok: false, errors: at([toError("script", error)]) };
  }

  if (scoped) js += `\n__page__.__scopeId = ${JSON.stringify(scopeId)};`;
  js += options.isEntry
    ? `\nimport { mountPage as __fretikMountPage } from "#fretik/sdk";\n__fretikMountPage(__page__);\nexport default __page__;`
    : `\nexport default __page__;`;

  if (isTs) {
    try {
      js = new Bun.Transpiler({ loader: "ts" }).transformSync(js);
    } catch (error) {
      return { ok: false, errors: at([toError("script", error)]) };
    }
  }

  let css = "";
  for (const style of descriptor.styles) {
    if (style.scoped) {
      const compiled = compileStyle({
        source: style.content,
        filename,
        id: scopeId,
        scoped: true,
      });
      if (compiled.errors.length > 0) {
        return {
          ok: false,
          errors: at(compiled.errors.map((e) => toError("style", e))),
        };
      }
      css += `${compiled.code}\n`;
    } else {
      css += `${style.content}\n`;
    }
  }

  return { ok: true, output: { js, css } };
};

/**
 * Refuse any import the iframe's import map cannot serve.
 *
 * `declared` is the project's own files: a relative specifier is legitimate
 * exactly when it names one of them. On a single-file page there are none, so
 * every relative import is refused, as it always was.
 */
const importErrors = (
  js: string,
  context: { from: string; declared: ReadonlySet<string> } = {
    from: PAGE_ENTRY_FILE,
    declared: new Set(),
  },
): PageCompileError[] => {
  // A `.ts` helper is scanned as it was written, types and all; everything
  // else reaching here is compiled output.
  const transpiler = new Bun.Transpiler({
    loader: context.from.endsWith(".ts") ? "ts" : "js",
  });
  const errors: PageCompileError[] = [];
  const at = (message: string): PageCompileError => ({
    block: "imports",
    message,
    ...(context.from === PAGE_ENTRY_FILE ? {} : { file: context.from }),
  });
  for (const found of transpiler.scanImports(js)) {
    if (ALLOWED_IMPORTS.has(found.path)) continue;
    if (found.path.startsWith("./") || found.path.startsWith("../")) {
      const target = resolveProjectImport(context.from, found.path);
      if (target !== null && context.declared.has(target)) continue;
      errors.push(
        at(
          context.declared.size === 0
            ? `relative import "${found.path}" — this page has no other files; write one (components/…, composables/…, lib/…) or inline the code.`
            : `relative import "${found.path}" resolves to "${target ?? found.path}", which this page does not have. Its files are: ${[...context.declared].join(", ")}.`,
        ),
      );
      continue;
    }
    errors.push(
      at(
        `import "${found.path}" is not available in the page runtime. Allowed: ${[...ALLOWED_IMPORTS].join(", ")}.`,
      ),
    );
  }
  return errors;
};

/**
 * Where a relative specifier points, as a project path — or null when it walks
 * outside the project.
 *
 * `.ts` is implied the way a bundler implies it: the model writes
 * `../composables/usePageData`, which is what every Vue project it has read
 * looks like.
 */
const resolveProjectImport = (
  from: string,
  specifier: string,
): string | null => {
  const segments = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  const path = segments.join("/");
  if (path === "") return null;
  return /\.(ts|vue)$/.test(path) ? path : `${path}.ts`;
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
  files: [string, string][],
): Promise<
  { ok: true; css: string } | { ok: false; error: PageCompileError }
> => {
  const theme = await themeAssets();
  const entries = resolveTailwindEntries();
  const dir = `${SCRATCH_ROOT}/${Bun.randomUUIDv7()}`;
  const inputCss = [
    `@import "${entries.theme}" layer(theme) reference;`,
    `@import "${entries.utilities}" layer(utilities) source(none);`,
    // Explicit globs rather than a bare directory: `@source "./src"` leans on
    // Tailwind's own content heuristics (ignore files, extension guesses), and
    // a class silently unscanned is a page that renders unstyled.
    '@source "./src/**/*.vue";',
    '@source "./src/**/*.ts";',
    theme.css,
  ].join("\n");

  await acquireTailwindSlot();
  try {
    await Promise.all(
      files.map(([path, content]) => Bun.write(`${dir}/src/${path}`, content)),
    );
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

/**
 * The component registry every template resolves against.
 *
 * `components/KpiStrip.vue` is `<KpiStrip>` anywhere in the page, with no
 * import — the Nuxt convention the model already writes by habit, and the one
 * that removes the whole class of "I forgot the import" failures.
 *
 * Read through GETTERS rather than copied into an object literal, because two
 * components that use each other form an import cycle: at the moment a module
 * body runs, its cyclic partner's default export may still be uninitialised,
 * and a literal would capture `undefined` for good. A getter reads the live
 * binding when Vue actually resolves the tag.
 */
const componentRegistryModule = (componentPaths: string[]): string => {
  const lines = ["export const components = {};"];
  componentPaths.forEach((path, index) => {
    const name = path.slice("components/".length, -".vue".length);
    lines.unshift(
      `import __c${index.toString()} from "./${modulePath(path)}";`,
    );
    lines.push(
      `Object.defineProperty(components, ${JSON.stringify(name)}, { get: () => __c${index.toString()}, enumerable: true });`,
    );
  });
  return lines.join("\n");
};

/** Where a project path's compiled module sits in the build scratch. */
const modulePath = (path: string): string =>
  path.endsWith(".vue") ? `${path}.js` : path;

/** How a module at `from` reaches the registry at the build root. */
const registrySpecifier = (from: string): string =>
  from.includes("/") ? "../__components.js" : "./__components.js";

/**
 * Link the project's modules into the ONE ES module the iframe loads.
 *
 * Bun's bundler resolves only what is INSIDE the project — everything the
 * import map serves stays an import, exactly as the single-file path leaves it.
 */
const bundleProject = async (
  modules: [string, string][],
): Promise<
  { ok: true; js: string } | { ok: false; error: PageCompileError }
> => {
  const id = Bun.randomUUIDv7();
  const dir = `${SCRATCH_ROOT}/${id}`;
  try {
    await Promise.all(
      modules.map(([path, content]) => Bun.write(`${dir}/${path}`, content)),
    );
    const built = await Bun.build({
      entrypoints: [`${dir}/${modulePath(PAGE_ENTRY_FILE)}`],
      external: [...ALLOWED_IMPORTS],
      target: "browser",
      format: "esm",
      minify: false,
      throw: false,
    });
    if (!built.success) {
      const [first] = built.logs;
      return {
        ok: false,
        error: {
          block: "imports",
          message: `the page's files could not be linked together: ${first?.message ?? "unknown bundler error"}`,
        },
      };
    }
    const [output] = built.outputs;
    if (output === undefined) {
      return {
        ok: false,
        error: { block: "imports", message: "the bundler produced no module." },
      };
    }
    // Bun labels each concatenated module with its path relative to the CWD,
    // so the stored artifact would otherwise carry `…/tmp/<uuid>/…` — a leak
    // of the machine that built it, and a module whose bytes differ on every
    // compile of identical source. Cutting at the scratch id leaves the
    // project-relative path, which is the only part that means anything.
    const js = (await output.text()).replace(
      new RegExp(`[^\\s"']*${id}/`, "g"),
      "",
    );
    return { ok: true, js };
  } catch (error) {
    return {
      ok: false,
      error: {
        block: "imports",
        message: `the page's files could not be linked together: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  } finally {
    void Bun.$`rm -rf ${dir}`.quiet().nothrow();
  }
};

/**
 * Compile every file, then link them.
 *
 * A one-file page takes the path it always took — its module IS the compiled
 * SFC, byte for byte, with no bundler in the way. Files turn that module into
 * an entry point: each component compiles on its own, a generated registry
 * makes them resolvable by name, and Bun links the graph.
 */
const buildModules = async (
  project: [string, string][],
): Promise<
  { ok: true; output: SfcOutput } | { ok: false; errors: PageCompileError[] }
> => {
  const declared = new Set(project.map(([path]) => path));
  const componentPaths = project
    .map(([path]) => path)
    .filter((path) => path.startsWith("components/"));

  const modules: [string, string][] = [];
  const errors: PageCompileError[] = [];
  let css = "";

  for (const [path, content] of project) {
    if (!path.endsWith(".vue")) {
      // A `.ts` helper is handed to the bundler as it was written; Bun strips
      // its types the same way the SFC path does.
      errors.push(...importErrors(content, { from: path, declared }));
      modules.push([path, content]);
      continue;
    }
    const isEntry = path === PAGE_ENTRY_FILE;
    const sfc = compileSfc(content, { path, isEntry });
    if (!sfc.ok) {
      errors.push(...sfc.errors);
      continue;
    }
    errors.push(...importErrors(sfc.output.js, { from: path, declared }));
    css += sfc.output.css;
    const registry =
      componentPaths.length > 0
        ? `\nimport { components as __fretikComponents } from ${JSON.stringify(registrySpecifier(path))};\n__page__.components = __fretikComponents;`
        : "";
    modules.push([modulePath(path), `${sfc.output.js}${registry}`]);
  }
  if (errors.length > 0) return { ok: false, errors };

  const entry = modules.find(([path]) => path === modulePath(PAGE_ENTRY_FILE));
  if (entry === undefined) {
    return {
      ok: false,
      errors: [
        { block: "structure", message: `${PAGE_ENTRY_FILE} is missing.` },
      ],
    };
  }
  if (project.length === 1) return { ok: true, output: { js: entry[1], css } };

  modules.push(["__components.js", componentRegistryModule(componentPaths)]);
  const linked = await bundleProject(modules);
  if (!linked.ok) return { ok: false, errors: [linked.error] };
  return { ok: true, output: { js: linked.js, css } };
};

/** Every ceiling a project has to clear before anything is compiled. */
const projectSizeError = (
  source: string,
  files: Record<string, string>,
): PageCompileError | null => {
  if (source.length > PAGE_LIMITS.maxSourceChars) {
    return {
      block: "size",
      message: `source is ${source.length.toString()} chars; the ceiling is ${PAGE_LIMITS.maxSourceChars.toString()}.`,
    };
  }
  const paths = Object.keys(files);
  if (paths.length > PAGE_LIMITS.maxFiles) {
    return {
      block: "size",
      message: `${paths.length.toString()} files besides ${PAGE_ENTRY_FILE}; the ceiling is ${PAGE_LIMITS.maxFiles.toString()}.`,
    };
  }
  for (const [path, content] of Object.entries(files)) {
    if (content.length > PAGE_LIMITS.maxFileChars) {
      return {
        block: "size",
        file: path,
        message: `${content.length.toString()} chars; the ceiling for one file is ${PAGE_LIMITS.maxFileChars.toString()}. Split it.`,
      };
    }
  }
  const total = pageCodeChars({ source, files });
  if (total > PAGE_LIMITS.maxProjectChars) {
    return {
      block: "size",
      message: `the project is ${total.toString()} chars; the ceiling is ${PAGE_LIMITS.maxProjectChars.toString()}.`,
    };
  }
  return null;
};

/** In-flight dedupe: create + its dry-run (or two turns racing) compile one
 * source once. Keyed by content hash; entries clear on settle. */
const inflight = new Map<string, Promise<PageCompileResult>>();

export const compilePageCode = async (params: {
  source: string;
  /** The rest of the project, keyed by path. Absent for a one-file page. */
  files?: Record<string, string> | undefined;
}): Promise<PageCompileResult> => {
  // Repair first, then hash: the artifacts, the dedupe key and the stored
  // source must all describe the SAME text. Hashing the original would cache a
  // compile under a source nobody keeps.
  const repair = autofixPageSource(params.source);
  const source = repair.source;
  const repairs = [...repair.autofixes];
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(params.files ?? {})) {
    const fixed = autofixPageSource(content);
    files[path] = fixed.source;
    for (const fix of fixed.autofixes) repairs.push({ ...fix, file: path });
  }
  const project = eachPageFile({ source, files });
  const changed = repairs.length > 0;

  const key = await pageProjectHash(project);
  const running = inflight.get(key);
  if (running) return running;

  const task = (async (): Promise<PageCompileResult> => {
    const sizeError = projectSizeError(source, files);
    if (sizeError) return { ok: false, errors: [sizeError] };

    const built = await buildModules(project);
    if (!built.ok) return { ok: false, errors: built.errors };

    const tailwind = await compileTailwind(project);
    if (!tailwind.ok) return { ok: false, errors: [tailwind.error] };

    const sfc = built;
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
      ...(changed
        ? {
            autofixes: repairs,
            source,
            ...(Object.keys(files).length > 0 ? { files } : {}),
          }
        : {}),
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
  const files = definition.code.files;
  // `files` travels through every branch below. A path that reconstructs
  // `code` from `source` alone drops the rest of the project on the floor —
  // the page still compiles, from the entry file only, and every component it
  // used is gone.
  const keep = files !== undefined ? { files } : {};
  if (source.trim().length === 0) {
    return {
      definition: { ...definition, code: { source, ...keep } },
      autofixes: [],
    };
  }
  const hash = await pageProjectHash(eachPageFile({ source, files }));
  if (definition.code.compiled?.sourceHash === hash) {
    return { definition, autofixes: [] };
  }
  if (options?.previous?.sourceHash === hash) {
    return {
      definition: {
        ...definition,
        code: { source, ...keep, compiled: options.previous },
      },
      autofixes: [],
    };
  }
  const result = await compilePageCode({ source, files });
  if (!result.ok) {
    return throwHttpError(
      400,
      badRequest(formatPageCompileErrors(result.errors)),
    );
  }
  // When a repair fired, the REPAIRED text is what gets stored — the compiled
  // artifacts belong to it, and a stored source the agent's edits could not
  // anchor against would be worse than the mistake it fixed.
  const repaired = result.files ?? files;
  return {
    definition: {
      ...definition,
      code: {
        source: result.source ?? source,
        ...(repaired !== undefined ? { files: repaired } : {}),
        compiled: result.compiled,
      },
    },
    autofixes: result.autofixes ?? [],
  };
};
