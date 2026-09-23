import Bowser from "bowser";

/**
 * User-agent reading for auth surfaces, through `bowser` (MIT, maintained, the
 * same parser the frontend uses) rather than hand-rolled regexes, which miss
 * the cases that matter here: Edge and Opera carry "Chrome" in their UA, and
 * iOS Safari carries "Mac OS X".
 *
 * Everything returns null rather than guess when the UA says nothing usable.
 */

const parse = (ua: string | null | undefined) => (ua ? Bowser.parse(ua) : null);

/** A short "Browser · OS" label, e.g. "Chrome · macOS" or "Safari · iOS". */
export const describeUserAgent = (
  ua: string | null | undefined,
): string | null => {
  const parsed = parse(ua);
  const browser = parsed?.browser.name || null;
  const os = parsed?.os.name || null;
  if (browser && os) return `${browser} · ${os}`;
  return browser ?? os;
};

/** A Mac, iPhone or iPad (iPadOS in desktop mode reports itself as macOS). */
export const isAppleDevice = (ua: string | null | undefined): boolean => {
  const os = parse(ua)?.os.name;
  return os === "macOS" || os === "iOS";
};
