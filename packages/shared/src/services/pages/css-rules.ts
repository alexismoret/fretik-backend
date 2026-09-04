/**
 * The one thing two Tailwind builds in one document cannot do for themselves:
 * agree on order.
 *
 * A page's frame loads `runtime.css` (Nuxt UI's theme, built with the runtime)
 * and then the page's own compiled stylesheet. Both are Tailwind output, and
 * Tailwind's property-order sort — the thing that makes `ps-7` beat `px-2` on
 * an element carrying both — holds only WITHIN one stylesheet. The second sheet
 * re-declaring a class the first already has silently moves it to the end of
 * the cascade, past rules that were sorted to beat it.
 *
 * Measured 2026-09-04, in a browser: a page whose own source used `px-2` made
 * `<UInput icon>` lose 20px of leading padding, and the icon drew on top of the
 * placeholder — on every page this product had ever generated, because the
 * component theme pairs a shorthand with a side-specific override and the
 * shorthand is a class any page might use.
 *
 * The fix is to give every class exactly ONE definition: a rule the runtime
 * already declares unconditionally is dropped from the page's sheet, so the
 * runtime's canonical order governs it. What remains — everything inside a
 * media or supports query, and every class only this page uses — stays where it
 * is, last, which is where a variant belongs. That direction matters: layering
 * the page's whole sheet UNDER the runtime's was tried first and broke the
 * opposite pair, `hidden sm:block`, because a losing layer beats a media query.
 */

interface CssItem {
  /** Comments and whitespace before the head. Tailwind's licence banner is one,
   * and it sits in front of the FIRST block of every sheet: folding it into the
   * head made that block unrecognisable as an at-rule, which silently exempted
   * whatever came first from every rule below. */
  prefix: string;
  /** `selector` for a plain rule, the prelude for an at-rule. */
  head: string;
  body: string;
  isAtRule: boolean;
  /** The item's whole text, prefix and braces included. */
  text: string;
}

/** Leading comments and whitespace, kept apart from the head they precede. */
const splitPrefix = (raw: string): { prefix: string; head: string } => {
  const match = /^(?:\s|\/\*[\s\S]*?\*\/)*/.exec(raw);
  const prefix = match?.[0] ?? "";
  return { prefix, head: raw.slice(prefix.length).trim() };
};

/**
 * One CSS block's top-level items, by brace matching.
 *
 * A parser, not a regex: minified Tailwind output nests `@layer`, `@media`,
 * `@supports` and `:is()` selectors freely, and a regex that finds `}` finds
 * the wrong one on the first nested block.
 */
const topLevelItems = (css: string): CssItem[] => {
  const out: CssItem[] = [];
  let start = 0;
  let i = 0;
  while (i < css.length) {
    const char = css[i];
    if (char === "{") {
      const { prefix, head } = splitPrefix(css.slice(start, i));
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        const inner = css[j];
        if (inner === "{") depth += 1;
        else if (inner === "}") depth -= 1;
        j += 1;
      }
      out.push({
        prefix,
        head,
        body: css.slice(i + 1, j - 1),
        isAtRule: head.startsWith("@"),
        text: css.slice(start, j),
      });
      i = j;
      start = j;
      continue;
    }
    // A statement at-rule with no block: `@layer a, b;`, `@charset "utf-8";`
    if (char === ";" && splitPrefix(css.slice(start, i)).head.startsWith("@")) {
      const { prefix, head } = splitPrefix(css.slice(start, i));
      out.push({
        prefix,
        head,
        body: "",
        isAtRule: true,
        text: css.slice(start, i + 1),
      });
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  return out;
};

/** `@layer` groups rules without conditioning them; `@media`/`@supports` do. */
const isTransparentAtRule = (head: string): boolean =>
  head.startsWith("@layer");

/** Split a selector list on its TOP-LEVEL commas — `:is(.a,.b)` is one selector. */
const splitSelectors = (head: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < head.length; i++) {
    const char = head[i];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      out.push(head.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(head.slice(start).trim());
  return out.filter((selector) => selector !== "");
};

/**
 * A bare class selector and nothing else — `.px-2`, `.w-\[7px\]`, `.bg-red\/50`.
 *
 * Only these are eligible to be dropped, and the exclusion is about SPECIFICITY,
 * not tidiness. Tailwind leans on source order only where specificity ties, so a
 * variant that adds a pseudo-class (`.hover\:bg-x:hover`) is safe wherever it
 * sits — but `dark:` compiles to `:where(.dark, .dark *)`, which adds NOTHING to
 * specificity and therefore ties with any plain class. Dropping the page's copy
 * of a plain class moves nothing (the runtime's copy sits in canonical order);
 * dropping a variant could move a tie the other way. So variants stay, always.
 */
const isPlainClassSelector = (selector: string): boolean => {
  if (!selector.startsWith(".") || selector.length < 2) return false;
  for (let i = 1; i < selector.length; i++) {
    const char = selector[i];
    if (char === "\\") {
      i += 1; // an escaped character is part of the class name
      continue;
    }
    if (char === undefined) return false;
    // Anything that reaches beyond this one class — a combinator, a
    // pseudo-class, a second compound — disqualifies it.
    if (":.,()[]>+~* \t\n".includes(char)) return false;
  }
  return true;
};

/**
 * Every bare class a stylesheet declares OUTSIDE any conditional at-rule.
 *
 * Deliberately does NOT descend into `@media` or `@supports`: a class the
 * runtime only defines under a media query must NOT license dropping a page's
 * unconditional copy of it. Under-collecting costs a missed dedupe (the old
 * behaviour, for that one class); over-collecting would delete a style the page
 * needs, so the asymmetry decides every rule in this file.
 */
export const unconditionalSelectors = (css: string): string[] => {
  const found = new Set<string>();
  const walk = (block: string): void => {
    for (const item of topLevelItems(block)) {
      if (!item.isAtRule) {
        for (const selector of splitSelectors(item.head)) {
          if (isPlainClassSelector(selector)) found.add(selector);
        }
        continue;
      }
      if (isTransparentAtRule(item.head) && item.body !== "") walk(item.body);
    }
  };
  walk(css);
  return [...found].sort();
};

/**
 * Drop every unconditional rule whose selectors are ALL already declared by
 * `known`. A rule listing several selectors is kept whole unless every one of
 * them is known — dropping half a selector list would change what the rule
 * matches.
 */
export const dropRulesDeclaredBy = (
  css: string,
  known: ReadonlySet<string>,
): string => {
  const prune = (block: string): string => {
    let out = "";
    for (const item of topLevelItems(block)) {
      if (item.isAtRule) {
        if (isTransparentAtRule(item.head) && item.body !== "") {
          const inner = prune(item.body);
          // A layer emptied by pruning is noise; a layer that still holds
          // something keeps its wrapper, because the name orders it.
          if (inner.trim() !== "")
            out += `${item.prefix}${item.head}{${inner}}`;
          continue;
        }
        out += item.text;
        continue;
      }
      const selectors = splitSelectors(item.head);
      if (
        selectors.length > 0 &&
        selectors.every((s) => isPlainClassSelector(s) && known.has(s))
      )
        continue;
      out += item.text;
    }
    return out;
  };
  return prune(css);
};
