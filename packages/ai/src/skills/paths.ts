import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Single source of truth for the on-disk skill-asset directories shipped
 * inside this package. Both the bootstrap pusher (`conversation-storage`)
 * and the Bun-side skill reader (`read-skill-file`) resolve their paths
 * from here so the two never drift.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Bundled skill bundles: `bundled/<name>/SKILL.md` (+ scripts/, references/). */
export const BUNDLED_SKILLS_DIR = resolve(__dirname, "bundled");

/** Per-provider external-app skills: `sandbox-assets/skills/<providerKey>/SKILL.md`. */
export const EXTERNAL_APP_SKILLS_DIR = resolve(
  __dirname,
  "..",
  "..",
  "sandbox-assets",
  "skills",
);
