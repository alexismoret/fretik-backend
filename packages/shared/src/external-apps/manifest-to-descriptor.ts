import type {
  ExternalAppDescriptor,
  ExternalAppDescriptorAction,
} from "../schemas/external-app-descriptor";
import type { ProviderManifest } from "./manifest-schema";

/**
 * Content hash of a manifest — the same value used as the generated
 * SKILL.md `version`, reused as the descriptor `fingerprint`. sha256 of
 * the manifest JSON, truncated to 12 hex chars.
 */
export const manifestFingerprint = (manifest: ProviderManifest): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(manifest));
  return hasher.digest("hex").slice(0, 12);
};

/**
 * Compile a hand-written `ProviderManifest` into the unified
 * `ExternalAppDescriptor` IR. Pure structural transform — params / returns /
 * types are passed through by reference, so feeding the result into the
 * deterministic codegen yields byte-identical output to feeding the manifest
 * directly (guarded by a parity test).
 *
 * Manifest actions are fully trusted, so read → `auto`, write → `approval`
 * (the current gate behaviour), and every classification is tagged
 * `kindSource: "manifest"`.
 */
export const manifestToDescriptor = (
  manifest: ProviderManifest,
): ExternalAppDescriptor => {
  const actions: ExternalAppDescriptorAction[] = manifest.actions.map(
    (action) => ({
      name: action.name,
      kind: action.kind,
      kindSource: "manifest",
      summary: action.summary,
      approvalDefault: action.kind === "read" ? "auto" : "approval",
      params: action.params,
      returns: action.returns,
    }),
  );

  return {
    key: manifest.key,
    displayName: manifest.displayName,
    description: manifest.description,
    source: "manifest",
    transport: manifest.transport.kind,
    fingerprint: manifestFingerprint(manifest),
    categories: manifest.categories,
    types: manifest.types,
    actions,
    triggers: [],
  };
};
