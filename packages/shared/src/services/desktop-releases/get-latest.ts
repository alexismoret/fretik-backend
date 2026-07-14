import { YAML } from "bun";
import { selectOrCache } from "../../lib/redis";
import type {
  DesktopReleaseAsset,
  DesktopReleaseResponse,
} from "../../schemas/desktop-releases";

/**
 * Public base of the desktop feed the CI workflow uploads to, e.g.
 * `https://s3.fr-par.scw.cloud/files.fretik.com/desktop` — same value as the
 * frontend CI's `DESKTOP_FEED_BASE`. Deliberately its own env var rather than
 * reusing `lib/s3`'s document-storage bucket: the two are configured
 * independently (this is a plain public HTTPS read, no S3 credentials
 * needed — the desktop app itself reads these same files the same way).
 */
const feedBase = process.env.DESKTOP_UPDATE_FEED_BASE;

interface UpdateFileInfo {
  url: string;
  sha512: string;
  size?: number;
}

interface UpdateInfoYaml {
  version: string;
  files: UpdateFileInfo[];
  releaseDate: string;
}

const emptyResponse: DesktopReleaseResponse = {
  available: false,
  version: null,
  releaseDate: null,
  mac: null,
  windows: null,
};

const fetchManifest = async (path: string): Promise<UpdateInfoYaml | null> => {
  try {
    const res = await fetch(`${feedBase}/${path}`);
    if (!res.ok) return null;
    return YAML.parse(await res.text()) as UpdateInfoYaml;
  } catch {
    return null;
  }
};

const findAsset = (
  files: UpdateFileInfo[],
  base: string,
  suffix: string,
): DesktopReleaseAsset | null => {
  const file = files.find((f) => f.url.endsWith(suffix));
  if (!file) return null;
  return { url: `${base}/${file.url}`, size: file.size ?? null };
};

const buildResponse = async (): Promise<DesktopReleaseResponse> => {
  if (!feedBase) return emptyResponse;

  const [mac, win] = await Promise.all([
    fetchManifest("mac/latest-mac.yml"),
    fetchManifest("win/latest.yml"),
  ]);
  if (!mac && !win) return emptyResponse;

  const macBase = `${feedBase}/mac`;
  const winBase = `${feedBase}/win`;

  return {
    available: true,
    version: mac?.version ?? win?.version ?? null,
    releaseDate: mac?.releaseDate ?? win?.releaseDate ?? null,
    mac: mac
      ? {
          arm64: {
            dmg: findAsset(mac.files, macBase, "-arm64.dmg"),
            zip: findAsset(mac.files, macBase, "-arm64.zip"),
          },
          x64: {
            dmg: findAsset(mac.files, macBase, "-x64.dmg"),
            zip: findAsset(mac.files, macBase, "-x64.zip"),
          },
        }
      : null,
    windows: win
      ? { x64: { exe: findAsset(win.files, winBase, "-x64.exe") } }
      : null,
  };
};

/** 5 min TTL — releases happen at most a few times a day, no need to hit
 * Scaleway on every page view. */
export const getLatestDesktopRelease =
  async (): Promise<DesktopReleaseResponse> =>
    selectOrCache(buildResponse, "desktop-releases:latest", 5 * 60);
