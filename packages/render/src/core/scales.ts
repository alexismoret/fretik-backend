import { z } from "zod";

/**
 * Closed styling scales — named steps, never free CSS.
 *
 * Two reasons they are closed. Tailwind is scanned at BUILD time, so a value
 * invented at runtime has no class to resolve to and renders unstyled; and a
 * fixed vocabulary is what keeps independently generated surfaces looking like
 * one product rather than 45 unrelated opinions.
 *
 * Shared across catalogs on purpose: a `gap` means the same thing on a page
 * and in a form.
 */

/**
 * The seven SEMANTIC colour tokens. They carry meaning and follow the
 * workspace theme: a `success` badge stays green when the org re-themes.
 */
export const SEMANTIC_COLORS = [
  "primary",
  "secondary",
  "success",
  "info",
  "warning",
  "error",
  "neutral",
] as const;

/**
 * Every Tailwind hue, usable anywhere a semantic token is — raw accents for
 * entity data and decoration (a chart series, a category chip, a themed band)
 * where "info blue" would be a lie about meaning.
 *
 * They render through the SAME Nuxt UI machinery, not a parallel styling path:
 * a hue re-points `--ui-primary` for that node's subtree and the component is
 * still asked for `color="primary"`, so every variant, focus ring and
 * dark-mode step keeps working and only the hue moves.
 *
 * Tailwind's own `neutral` family is left out — the name is taken by the
 * semantic token above, and `zinc`/`gray`/`slate`/`stone` cover grey.
 */
export const HUES = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
  "slate",
  "gray",
  "zinc",
  "stone",
] as const;

export const SCALES = {
  gap: ["none", "xs", "sm", "md", "lg", "xl"],
  pad: ["none", "xs", "sm", "md", "lg", "xl"],
  size: ["xs", "sm", "md", "lg", "xl"],
  color: [...SEMANTIC_COLORS, ...HUES],
  variant: ["solid", "outline", "soft", "subtle", "ghost", "link"],
  align: ["start", "center", "end", "stretch", "baseline"],
  justify: ["start", "center", "end", "between", "around", "evenly"],
  direction: ["row", "col"],
  cols: ["1", "2", "3", "4", "5", "6", "12"],
  span: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "full"],
  radius: ["none", "sm", "md", "lg", "xl", "full"],
  weight: ["normal", "medium", "semibold", "bold"],
  tone: ["default", "muted", "dimmed", "highlighted"],
  textSize: ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl"],
  textAlign: ["start", "center", "end"],
  transform: ["none", "upper", "lower"],
  tracking: ["tight", "normal", "wide", "wider"],
  /** How much visual weight a tile claims relative to its neighbours. */
  emphasis: ["none", "highlight", "hero"],
  /** `section` shapes — same props, four densities of presentation. */
  sectionVariant: ["default", "hero", "feature", "cta", "plain"],
  ratio: ["auto", "square", "video", "wide", "portrait"],
  fit: ["cover", "contain"],
  /** Background tiers a `box` may claim, straight off the theme tokens. */
  surface: ["none", "muted", "elevated", "accented", "tint"],
  density: ["compact", "default", "comfortable"],
  format: [
    "text",
    "number",
    "money",
    "percent",
    "date",
    "datetime",
    "relative",
    "duration",
    "bytes",
  ],
} as const satisfies Record<string, readonly [string, ...string[]]>;

export type ScaleName = keyof typeof SCALES;

/** A scale as a zod enum, for a component's props. */
export const scale = <N extends ScaleName>(name: N) => z.enum(SCALES[name]);
