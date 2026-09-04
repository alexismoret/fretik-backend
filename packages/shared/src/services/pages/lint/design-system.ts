import type { PageLintFinding } from "./types";
import { templateElements, templateRegions } from "./walk-template";

/**
 * The two system-level constraints a page inherits and cannot renegotiate: the
 * palette it is painted in, and the layer it is drawn on. Neither is about what
 * a page shows — they hold for a board, a directory, a console or a feed, over
 * any team's data — which is why they are lints and not advice.
 *
 * Both were already absolutes in prose. `design.md` opens with "never write a
 * hex or a raw `gray-500`" and `data.md` gives the recipe for a schema colour;
 * the pages measured on 2026-09-04 carried ~100 hand-picked hue classes and not
 * one `var(--color-…)`. That doctrine is in the builder's system prompt
 * VERBATIM, so those are not pages that failed to read it — it is the lesson
 * the native controls taught in August, a second time: a rule nothing measures
 * is a suggestion.
 */

/**
 * Every Tailwind hue that is NOT one of the app's own scales.
 *
 * `primary`, `secondary`, `success`, `info`, `warning`, `error` and `neutral`
 * are absent on purpose and that absence is the whole rule: Nuxt UI aliases
 * those onto the team's palette, so `text-primary-500` and `bg-neutral-100`
 * move with the theme and belong in a page. What is listed here is a colour
 * picked by hand, wrong twice over — it ignores the app's accent, and it has to
 * be re-picked for dark mode one usage at a time.
 */
const RAW_HUE_RE =
  /\b(?:bg|text|border|ring|outline|divide|from|via|to|fill|stroke|shadow|accent|caret|decoration|placeholder)-(slate|gray|zinc|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]50|[1-9]00)\b/g;

/**
 * Scanned as TEXT, not through the template AST, and deliberately: a page's
 * colours are rarely all in its markup. They collect in the lookup objects a
 * page builds for its own categories — a map from a value to a class string —
 * and those live in `lib/*.ts`, where a template walker never looks. Every
 * file, then, not every element.
 *
 * ONE finding per file, however many classes it holds. Measured on three pages
 * of the 2026-09-04 run: 137 occurrences, which as 137 blocking findings is a
 * wall rather than an instruction — and dishonest about the work, because a
 * page does not have 137 colour problems. It has one per file, and the repair
 * is one edit: delete the lookup and read the value's own colour.
 */
const EXAMPLES_SHOWN = 4;

export const lintRawPalette = (
  path: string,
  source: string,
): PageLintFinding[] => {
  const seen = new Set<string>();
  let line = 0;
  let occurrences = 0;

  for (const [index, text] of source.split("\n").entries()) {
    for (const match of text.matchAll(RAW_HUE_RE)) {
      const hue = match[1];
      if (hue === undefined) continue;
      occurrences += 1;
      if (line === 0) line = index + 1;
      seen.add(match[0]);
    }
  }
  if (occurrences === 0) return [];

  const examples = [...seen].slice(0, EXAMPLES_SHOWN).join(", ");
  const rest = seen.size > EXAMPLES_SHOWN ? ", …" : "";
  return [
    {
      path,
      line,
      rule: "raw-palette",
      severity: "blocking",
      message: `${occurrences.toString()} hand-picked colour${occurrences === 1 ? "" : "s"} (${examples}${rest}). Chrome uses the semantic tokens — text-muted, bg-elevated, border-default, and the primary/success/warning/error scales; a colour that belongs to a DATA value comes from that value's own schema, bound as \`var(--color-<option.color>-500)\` and never as a class assembled from it. A page that picks its own hues ignores the team's accent and has to re-pick every one of them for dark mode.`,
    },
  ];
};

/**
 * A page reaching into the app's layer order.
 *
 * A page owns its content; it does not own the stack. Everything that must
 * float above the whole app — an overlay, a dropdown, a tooltip, a toast — is a
 * component that portals OUT of the page, and the runtime keeps those layers
 * above whatever the page draws. Page code that builds one of them by hand, or
 * that claims a high z-index of its own, is competing for an order it cannot
 * see: its own sticky chrome then paints over its own overlays, and which one
 * wins depends on which ancestor happened to open a stacking context.
 *
 * So the rule is a ceiling, not a ban. Sticky headers, floating bars and
 * layered cards are ordinary page composition and stay; the overlay layer is
 * off limits.
 *
 * `blocking`, on the native-controls precedent: the page renders, a person hits
 * the defect, and the repair is swapping one component for another.
 */
const PAGE_Z_CEILING = 30;

const Z_INDEX_RE = /\bz-(\d{1,4})\b/g;

const classesOf = (element: { props: unknown[] }): string => {
  const parts: string[] = [];
  for (const prop of element.props) {
    if (typeof prop !== "object" || prop === null) continue;
    if (Reflect.get(prop, "name") === "class") {
      const value = Reflect.get(prop, "value");
      if (typeof value === "object" && value !== null) {
        const content = Reflect.get(value, "content");
        if (typeof content === "string") parts.push(content);
      }
    }
    const arg = Reflect.get(prop, "arg");
    if (
      typeof arg === "object" &&
      arg !== null &&
      Reflect.get(arg, "content") === "class"
    ) {
      const exp = Reflect.get(prop, "exp");
      if (typeof exp === "object" && exp !== null) {
        const content = Reflect.get(exp, "content");
        if (typeof content === "string") parts.push(content);
      }
    }
  }
  return parts.join(" ");
};

export const lintStacking = (
  path: string,
  source: string,
): PageLintFinding[] => {
  const findings: PageLintFinding[] = [];
  for (const element of templateElements(source)) {
    const classes = classesOf(element);

    // A component doing this to itself is the library's business; the rule is
    // about page code building an app-level layer out of a plain box.
    if (!/^[A-Z]/.test(element.tag) && /\bfixed\b/.test(classes)) {
      if (/\binset-0\b/.test(classes)) {
        findings.push({
          path,
          line: element.line,
          rule: "hand-rolled-overlay",
          severity: "blocking",
          message: `<${element.tag} class="fixed inset-0"> builds an app-level overlay by hand — use USlideover, UModal or UDrawer. They portal out of the page, so nothing the page stacks around them can paint over them; one built inside the page shares the page's stacking context and loses to its own sticky chrome.`,
        });
        continue;
      }
    }

    for (const match of classes.matchAll(Z_INDEX_RE)) {
      const value = Number(match[1]);
      if (!Number.isFinite(value) || value <= PAGE_Z_CEILING) continue;
      findings.push({
        path,
        line: element.line,
        rule: "page-z-ceiling",
        severity: "blocking",
        message: `\`${match[0]}\` reaches into the layer the app keeps for overlays, dropdowns and toasts. Page content stacks below z-${PAGE_Z_CEILING.toString()}; anything that must float above the whole app is a component that portals out of the page, not a z-index.`,
      });
    }
  }
  return findings;
};

/**
 * A screen whose every region is a bordered box has no hierarchy.
 *
 * This is the shape the multi-file model made easy and then made default. A
 * component drawn on its own comes out self-contained — its own border, its
 * own title, its own padding — and a page assembled from those is a grid of
 * slabs where nothing leads, which reads worse than the same page written in
 * one file. The doctrine says it ("regions of one composition share edges and
 * alignment; they do not each announce themselves") and the pages kept coming
 * back as card stacks, because the doctrine is prose and the file boundary is
 * a habit.
 *
 * Deliberately narrow, so that what it catches is only ever the failure:
 *
 * - `UCard` only. `UPageCard` in a `UPageGrid` is a card grid, which is a
 *   design and not a symptom.
 * - Top-level siblings only. Cards INSIDE one region are that region's
 *   business.
 * - A majority of them, and at least four. Two cards beside three other
 *   regions is a page that chose; five out of six is a page that did not.
 *
 * A warning: a page of cards is legible, it works, and refusing it would trade
 * a working page for none. What it must not be is invisible.
 */
const MIN_CARD_REGIONS = 4;
const CARD_REGION_SHARE = 0.6;

export const lintCardRegions = (
  path: string,
  source: string,
): PageLintFinding[] => {
  const regions = templateRegions(source);
  if (regions.length < MIN_CARD_REGIONS) return [];

  const cards = regions.filter((region) => region.tag === "UCard");
  if (
    cards.length < MIN_CARD_REGIONS ||
    cards.length < regions.length * CARD_REGION_SHARE
  ) {
    return [];
  }

  const first = cards[0];
  return [
    {
      path,
      line: first?.line ?? 0,
      rule: "card-regions",
      severity: "warning",
      message: `${cards.length.toString()} of this screen's ${regions.length.toString()} top-level regions are UCard — a stack of equal boxes, which is what a page looks like when its composition was never decided. Regions of one composition share edges and alignment: give the one that leads its own weight and let the rest sit on the page. A container earns a border when its content is a unit that could move elsewhere whole.`,
    },
  ];
};
