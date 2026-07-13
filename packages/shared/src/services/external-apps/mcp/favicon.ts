/**
 * Google's public favicon service — a logo fallback for a custom MCP server
 * added by raw URL, where the discovery catalog has no `iconUrl` to supply.
 * Returns null when the URL has no usable origin.
 */
export const faviconUrlForServer = (serverUrl: string): string | null => {
  try {
    const origin = new URL(serverUrl).origin;
    return `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(origin)}&size=128`;
  } catch {
    return null;
  }
};
