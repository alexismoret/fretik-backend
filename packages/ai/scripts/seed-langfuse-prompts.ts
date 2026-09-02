#!/usr/bin/env bun
/**
 * Publish the repo's managed prompts to Langfuse — by hand.
 *
 * The work itself lives in `src/lib/langfuse-prompts/seed.ts`, because the AI
 * service now runs it automatically as a RELEASE TASK, once per deployed
 * version (`src/release-tasks.ts`). This script is the operator's door to the
 * same function: bootstrapping a fresh Langfuse project, or publishing a
 * prompt edit without waiting for a deploy.
 *
 * Idempotent: a prompt whose text matches the current `production` version is
 * skipped, so re-runs never stack no-op versions.
 *
 * Usage: `bun run langfuse:seed-prompts` (needs LANGFUSE_* in `.env`).
 */
import {
  langfuseCredentialsPresent,
  seedLangfusePrompts,
} from "../src/lib/langfuse-prompts/seed";

if (!langfuseCredentialsPresent()) {
  console.error(
    "Missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL — nothing to publish to.",
  );
  process.exit(1);
}

const { published, unchanged } = await seedLangfusePrompts();

for (const name of unchanged) console.log(`✓ ${name} — unchanged, skipped`);
for (const name of published) {
  console.log(`↑ ${name} — new version published (production)`);
}
console.log(
  `\n${published.length.toString()} published, ${unchanged.length.toString()} unchanged.`,
);
