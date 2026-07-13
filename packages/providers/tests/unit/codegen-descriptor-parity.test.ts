import { manifestToDescriptor } from "@fretik/shared/external-apps/manifest-to-descriptor";
import { listProviderManifests } from "@fretik/shared/external-apps/registry";
import { externalAppDescriptorSchema } from "@fretik/shared/schemas/external-app-descriptor";
import { describe, expect, test } from "bun:test";
import { emitProviderModule } from "../../src/codegen";
// Register the 6 providers (side-effect import).
// eslint-disable-next-line import/no-unassigned-import -- registers providers
import "../../src/index";

/**
 * The `ExternalAppDescriptor` IR is a structural superset of the codegen's
 * `CodegenProvider` view. These tests pin that contract: a descriptor built
 * from a manifest must (a) validate against its own schema, and (b) drive
 * the deterministic codegen to byte-identical output vs the manifest itself.
 * If this passes, the MCP path (M2) can build a descriptor and reuse the
 * exact same emitters with confidence.
 */
describe("manifestToDescriptor parity", () => {
  const manifests = listProviderManifests();

  test("registers the 6 first-party providers", () => {
    expect(manifests.length).toBeGreaterThanOrEqual(6);
  });

  for (const manifest of manifests) {
    describe(manifest.key, () => {
      const descriptor = manifestToDescriptor(manifest);

      test("descriptor validates against the IR schema", () => {
        expect(() =>
          externalAppDescriptorSchema.parse(descriptor),
        ).not.toThrow();
      });

      test("descriptor carries every action, kind preserved", () => {
        expect(descriptor.actions.length).toBe(manifest.actions.length);
        for (const action of descriptor.actions) {
          const source = manifest.actions.find((a) => a.name === action.name);
          expect(source).toBeDefined();
          if (source === undefined) continue;
          expect(action.kind).toBe(source.kind);
          // Manifest actions are fully trusted: read → auto, write → approval.
          expect(action.approvalDefault).toBe(
            source.kind === "read" ? "auto" : "approval",
          );
          expect(action.kindSource).toBe("manifest");
        }
      });

      test("codegen(manifest) === codegen(descriptor)", () => {
        expect(emitProviderModule(descriptor)).toBe(
          emitProviderModule(manifest),
        );
      });
    });
  }
});
