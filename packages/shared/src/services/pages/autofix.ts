/**
 * Repairs that need no model.
 *
 * A composable used without its import costs a full round trip today: the
 * compiler refuses the write, the agent reads the error, edits, resends. It is
 * mechanically decidable, so it is fixed here — a round trip becomes a line of
 * text the agent reads AFTER its page was saved. Measured on a real build, two
 * of its compile failures were exactly this.
 *
 * Every repair is REPORTED. A silent fix would teach the agent that its habit
 * works, and the stored source would drift from what it believes it wrote,
 * so its next `edits` anchors would miss.
 *
 * The rule this module lives by: never guess. A repair happens only where
 * exactly one correct answer exists.
 *
 * ICON NAMES ARE DELIBERATELY NOT REPAIRED, and the reason is worth keeping.
 * An icon autofixer was written, and sweeping the team's real pages seemed to
 * prove it necessary — 11 of 24 pages carried a name absent from
 * `lib/icons/search`. Every one of them was a false alarm: that catalog is 480
 * CURATED entries behind the `searchIcons` tool and the hub's icon picker,
 * while the page runtime bundles the whole Lucide set — 1817 icons plus 217
 * aliases (`page-runtime/vite.config.ts`). `filter-x`, `folder-lock` and
 * `pie-chart` render perfectly; `alert-triangle` and `check-circle` are live
 * aliases. Shipping the fixer would have rewritten working pages, turning
 * "clear the filter" into "filter". There is no icon defect to repair.
 */

export interface PageAutofix {
  /** Agent-facing, one line: what was changed and why. */
  message: string;
}

export interface PageAutofixResult {
  source: string;
  autofixes: PageAutofix[];
}

/**
 * Symbols the runtime exports that a page reaches for constantly and forgets
 * to import. Deliberately NOT the whole of `vue` — the list stops where
 * certainty stops. `defineProps`/`defineEmits` are compiler macros and need no
 * import; adding one would break the page.
 */
const VUE_AUTO_IMPORT = new Set([
  "ref",
  "shallowRef",
  "computed",
  "reactive",
  "watch",
  "watchEffect",
  "nextTick",
  "onMounted",
  "onBeforeUnmount",
  "onUnmounted",
  "toRef",
  "toRefs",
  "provide",
  "inject",
  "defineAsyncComponent",
]);

/** The two `@nuxt/ui` composables a page uses; the rest are components. */
const NUXT_UI_AUTO_IMPORT = new Set(["useToast", "useOverlay"]);

const SCRIPT_BLOCK = /<script\b[^>]*\bsetup\b[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * The script setup block, or null when the file is not the single-block shape
 * the compiler requires. Returning null means "do nothing" — a malformed file
 * is the compiler's to refuse, and guessing at its structure here could only
 * make the error harder to read.
 */
const scriptSetupBlock = (
  source: string,
): { content: string; start: number; end: number } | null => {
  SCRIPT_BLOCK.lastIndex = 0;
  const matches = [...source.matchAll(SCRIPT_BLOCK)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (match?.index === undefined || match[1] === undefined) return null;
  return {
    content: match[1],
    start: match.index + match[0].indexOf(match[1]),
    end: match.index + match[0].indexOf(match[1]) + match[1].length,
  };
};

/** Every name the script already binds — imported, declared, or destructured. */
const boundNames = (script: string): Set<string> => {
  const bound = new Set<string>();
  for (const match of script.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from/g,
  )) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) bound.add(name);
    }
  }
  for (const match of script.matchAll(
    /import\s+(?:type\s+)?(\w+)\s*(?:,|from)/g,
  )) {
    if (match[1]) bound.add(match[1]);
  }
  for (const match of script.matchAll(
    /(?:^|\n)\s*(?:const|let|var|function|class)\s+(\w+)/g,
  )) {
    if (match[1]) bound.add(match[1]);
  }
  return bound;
};

/** Names called as functions in the script — `ref(`, `computed(`, … */
const calledNames = (script: string): Set<string> => {
  const called = new Set<string>();
  for (const match of script.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (match[1]) called.add(match[1]);
  }
  return called;
};

/** Insert or extend `import { … } from "<module>"` at the top of the script. */
const addImports = (
  script: string,
  moduleName: string,
  names: string[],
): string => {
  const existing = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*["']${moduleName.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    )}["'];?`,
  ).exec(script);
  if (existing?.[1] !== undefined) {
    const merged = `${existing[1].trim().replace(/,\s*$/, "")}, ${names.join(", ")}`;
    return script.replace(
      existing[0],
      `import { ${merged} } from "${moduleName}";`,
    );
  }
  const line = `import { ${names.join(", ")} } from "${moduleName}";`;
  // After the last existing import, so the injected line joins the block
  // instead of splitting it.
  const imports = [...script.matchAll(/^[ \t]*import\b.*$/gm)];
  const last = imports.at(-1);
  if (last?.index !== undefined) {
    const at = last.index + last[0].length;
    return `${script.slice(0, at)}\n${line}${script.slice(at)}`;
  }
  return `\n${line}${script}`;
};

/**
 * Apply every certain repair to a page's source.
 *
 * Runs BEFORE the compiler: the point is to prevent the refusal, not to
 * explain it afterwards.
 */
export const autofixPageSource = (source: string): PageAutofixResult => {
  const autofixes: PageAutofix[] = [];
  let fixed = source;

  const block = scriptSetupBlock(fixed);
  if (block) {
    const bound = boundNames(block.content);
    const called = calledNames(block.content);
    let script = block.content;

    for (const [moduleName, catalog] of [
      ["vue", VUE_AUTO_IMPORT],
      ["@nuxt/ui", NUXT_UI_AUTO_IMPORT],
    ] as const) {
      const missing = [...catalog].filter(
        (name) => called.has(name) && !bound.has(name),
      );
      if (missing.length === 0) continue;
      script = addImports(script, moduleName, missing);
      autofixes.push({
        message: `Added the missing import { ${missing.join(", ")} } from "${moduleName}" — it was used but never imported.`,
      });
    }

    if (script !== block.content) {
      fixed = fixed.slice(0, block.start) + script + fixed.slice(block.end);
    }
  }

  return { source: fixed, autofixes };
};
