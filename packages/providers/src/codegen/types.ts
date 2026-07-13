import type {
  ParamSpec,
  ReturnSpec,
} from "@fretik/shared/external-apps/manifest-schema";

/**
 * Narrow, source-agnostic view the deterministic codegen consumes.
 *
 * Both a hand-written `ProviderManifest` (compile-time) and an
 * MCP-introspected descriptor (connection-time) satisfy this shape — so
 * the SAME Python-SDK / SKILL emitters serve every source. Keeping the
 * contract this narrow (only the fields the emitters actually read) is
 * what lets an MCP snapshot flow through `generateProviderModule(...)`
 * without synthesizing a full manifest.
 */
export interface CodegenAction {
  /** Snake-case action name — becomes the Python function name. */
  name: string;
  /** `read` → eager function; `write` → `.op(...)` builder + run_plan sugar. */
  kind: "read" | "write";
  /** One-line description — SDK docstring + SKILL.md reference line. */
  summary: string;
  params: Record<string, ParamSpec>;
  returns: ReturnSpec;
}

export interface CodegenProvider {
  /** Provider key (kebab-case); the Python module uses its snake_case form. */
  key: string;
  displayName: string;
  /**
   * Agent-facing one-liner — becomes the SKILL.md front-matter
   * `description` (skill discovery). Falls back to `displayName` when absent.
   */
  description?: string;
  categories: readonly string[];
  /** Named reusable object types referenced by `returns` / params. */
  types: Record<string, Record<string, ParamSpec>>;
  actions: readonly CodegenAction[];
}
