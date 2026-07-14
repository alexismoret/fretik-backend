import { z } from "zod";

/**
 * Public "download the desktop app" surface. Sourced from the `latest-mac.yml`
 * / `latest.yml` manifests electron-builder already writes on every release
 * (the same files `electron-updater` reads at runtime) — no separate
 * "latest" alias needs to exist on the bucket, this just reads the existing
 * pointer. See `services/desktop-releases/get-latest.ts`.
 */

export const desktopReleaseAssetSchema = z.object({
  url: z.string().url(),
  size: z.number().nonnegative().nullable(),
});
export type DesktopReleaseAsset = z.infer<typeof desktopReleaseAssetSchema>;

export const desktopReleaseResponseSchema = z.object({
  available: z
    .boolean()
    .describe(
      "False when the desktop feed isn't configured yet (env unset) or the manifests couldn't be fetched.",
    ),
  version: z.string().nullable(),
  releaseDate: z.string().nullable(),
  mac: z
    .object({
      arm64: z.object({
        dmg: desktopReleaseAssetSchema.nullable(),
        zip: desktopReleaseAssetSchema.nullable(),
      }),
      x64: z.object({
        dmg: desktopReleaseAssetSchema.nullable(),
        zip: desktopReleaseAssetSchema.nullable(),
      }),
    })
    .nullable(),
  windows: z
    .object({
      x64: z.object({
        exe: desktopReleaseAssetSchema.nullable(),
      }),
    })
    .nullable(),
});
export type DesktopReleaseResponse = z.infer<
  typeof desktopReleaseResponseSchema
>;
