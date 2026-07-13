#!/usr/bin/env bun
/**
 * Deterministic generator — turns every provider manifest into the Python
 * SDK pushed into the chatbot sandbox (`fretik_apps/<provider>.py`) and
 * the SKILL.md the agent reads when it first reaches for an external app.
 *
 * Zero LLM in this pipeline — the manifest is the source of truth and the
 * transformation is pure templating. This script owns only discovery +
 * file IO + the manifest version hash; all templating lives in the
 * importable `src/codegen` lib, which the connection-time MCP path (M2)
 * reuses to generate stubs for introspected servers.
 *
 *   bun run gen:sdk   →  backend/packages/ai/sandbox-assets/{fretik_apps,skills}/...
 *
 * The generated files are committed to the repo (reproducibility, code
 * review). A CI test re-runs the generator and `git diff --exit-code`s
 * the output to catch any drift between manifest and SDK.
 */

import type { ProviderManifest } from "@fretik/shared/external-apps/manifest-schema";
import { providerManifestSchema } from "@fretik/shared/external-apps/manifest-schema";
import { listProviderManifests } from "@fretik/shared/external-apps/registry";
import {
  emitInit,
  emitManifestSkill,
  emitProviderModule,
  STATIC_MODULE_TEMPLATES,
} from "../src/codegen";
// Side-effect import: running the package index calls `setProviders(...)`, so
// every provider is registered and discoverable below — no hardcoded list to
// keep in sync when adding a provider.
// eslint-disable-next-line import/no-unassigned-import -- registers providers
import "../src/index";

// ── Provider discovery (from the registry) ────────────────────────────
//
// Providers are enumerated from the registry; each provider's `guidance.md`
// lives in `src/<key>/` (folder name == manifest key). Adding a provider
// requires no change here.

interface ProviderInput {
  manifest: ProviderManifest;
  guidancePath: string;
}

const PROVIDERS: ProviderInput[] = listProviderManifests().map((manifest) => ({
  manifest,
  guidancePath: `${import.meta.dir}/../src/${manifest.key}/guidance.md`,
}));

/** Same transform the codegen lib uses — kebab manifest key → snake module. */
const pyModuleName = (key: string): string => key.replace(/-/g, "_");

// ── Paths ─────────────────────────────────────────────────────────────

const ROOT = `${import.meta.dir}/..`;
const OUT_DIR = `${ROOT}/../ai/sandbox-assets`;
const SDK_DIR = `${OUT_DIR}/fretik_apps`;
const SKILLS_DIR = `${OUT_DIR}/skills`;
const RUNTIME_TEMPLATE_PATH = `${import.meta.dir}/sdk-templates/_runtime.py`;

/**
 * SKILL.md `version` — sha256 of the manifest JSON, first 12 hex chars.
 * Computed here (not in the codegen lib) so the hash covers the FULL
 * manifest, not the narrower `CodegenProvider` view the emitter sees.
 */
const manifestVersion = (manifest: ProviderManifest): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(manifest));
  return hasher.digest("hex").slice(0, 12);
};

// ── Main ──────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  // Validate every manifest.
  for (const p of PROVIDERS) providerManifestSchema.parse(p.manifest);

  // Runtime template — copied verbatim.
  const runtime = await Bun.file(RUNTIME_TEMPLATE_PATH).text();

  // Static (non-manifest) modules — copied verbatim, like `_runtime.py`.
  const staticModules = await Promise.all(
    STATIC_MODULE_TEMPLATES.map(async (name) => ({
      name,
      source: await Bun.file(
        `${import.meta.dir}/sdk-templates/${name}.py`,
      ).text(),
    })),
  );

  // Write all provider files in parallel (one writer per file).
  await Promise.all([
    Bun.write(`${SDK_DIR}/_runtime.py`, runtime),
    ...staticModules.map((m) => Bun.write(`${SDK_DIR}/${m.name}.py`, m.source)),
    Bun.write(
      `${SDK_DIR}/__init__.py`,
      emitInit(PROVIDERS.map((p) => p.manifest)),
    ),
    ...PROVIDERS.flatMap((p) => [
      Bun.write(
        `${SDK_DIR}/${pyModuleName(p.manifest.key)}.py`,
        emitProviderModule(p.manifest),
      ),
      Bun.file(p.guidancePath)
        .text()
        .then((guidance) =>
          Bun.write(
            `${SKILLS_DIR}/${p.manifest.key}/SKILL.md`,
            emitManifestSkill({
              provider: p.manifest,
              guidance,
              version: manifestVersion(p.manifest),
            }),
          ),
        ),
    ]),
  ]);

  console.log(
    `✓ Generated SDK + SKILL.md for ${PROVIDERS.length.toString()} provider(s) into ${OUT_DIR}`,
  );
};

await main();
