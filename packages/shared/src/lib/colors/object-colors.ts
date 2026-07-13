/**
 * Named accent palette for object types and select options — the single source
 * of truth shared by the write services (server-side auto-assignment) and the
 * frontend picker/badges. These are entity-data accents, not semantic UI state;
 * the frontend maps each token to a CSS `--color-<token>-500` value.
 *
 * The set is every main Tailwind/Nuxt UI chromatic hue (so there are plenty of
 * distinct colors) plus `zinc`, the neutral default/fallback. `zinc` is excluded
 * from auto-assignment so colored values stand out from un-colored ones. The
 * previous 7-token set is a subset, so stored values stay valid.
 */
export const OBJECT_COLOR_TOKENS = [
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
  "zinc",
] as const;

export type ObjectColorToken = (typeof OBJECT_COLOR_TOKENS)[number];

export const DEFAULT_OBJECT_COLOR: ObjectColorToken = "zinc";

/**
 * Order auto-assignment cycles through — every chromatic hue (no neutral),
 * sequenced so adjacent picks are visually distinct rather than walking the
 * spectrum.
 */
const AUTO_COLOR_CYCLE: readonly ObjectColorToken[] = [
  "blue",
  "amber",
  "green",
  "violet",
  "rose",
  "cyan",
  "orange",
  "teal",
  "pink",
  "lime",
  "indigo",
  "red",
  "emerald",
  "fuchsia",
  "sky",
  "yellow",
  "purple",
];

const COLOR_SET: ReadonlySet<string> = new Set(OBJECT_COLOR_TOKENS);

/** True if `name` is a known palette token. */
export const isValidObjectColor = (name: string): boolean =>
  COLOR_SET.has(name);

/** The auto-color for position `index` (options) — cycles the chromatic palette. */
export const autoColorAt = (index: number): ObjectColorToken => {
  const n = AUTO_COLOR_CYCLE.length;
  return AUTO_COLOR_CYCLE[((index % n) + n) % n] ?? DEFAULT_OBJECT_COLOR;
};

/** Stable auto-color derived from a key (object types) — same key → same color. */
export const autoColorForKey = (key: string): ObjectColorToken => {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return autoColorAt(Math.abs(hash));
};
