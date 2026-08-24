import { Chromiumly, LibreOffice } from "chromiumly";

// Lazy: Chromiumly.configure runs on first convert call, not at module
// load. Lets consumers boot without GOTENBERG_* set (services that
// never convert non-PDF documents — e.g. cron-only entrypoints — don't
// need them). First convertXxx call throws loudly if env is missing.
let configured = false;
const requireEndpoint = (): string => {
  const endpoint = process.env.GOTENBERG_ENDPOINT;
  if (!endpoint) throw new Error("Missing GOTENBERG_ENDPOINT env");
  return endpoint.replace(/\/$/, "");
};

const ensureConfigured = () => {
  if (configured) return;
  Chromiumly.configure({
    endpoint: requireEndpoint(),
    username: process.env.GOTENBERG_API_BASIC_AUTH_USERNAME,
    password: process.env.GOTENBERG_API_BASIC_AUTH_PASSWORD,
  });
  configured = true;
};

type LibreOfficeFileExtension = Extract<
  Parameters<typeof LibreOffice.convert>[0]["files"][number],
  { ext: string }
>["ext"];

/**
 * Converts the first page of a document to PDF using Gotenberg.
 * The result is ephemeral (not saved to S3) — used for thumbnail
 * generation and as pre-extraction input for Excel/CSV files (spreadsheets
 * are often multi-sheet monsters whose extra sheets don't help with
 * classification).
 */
export const convertFirstPageToPdf = async (
  buffer: Uint8Array,
  extension: string,
): Promise<Uint8Array> => {
  ensureConfigured();
  const ext = extension.replace(
    /^\./,
    "",
  ) as unknown as LibreOfficeFileExtension;

  const result = await LibreOffice.convert({
    files: [{ data: Buffer.from(buffer), ext }],
    properties: { nativePageRanges: { from: 1, to: 1 } },
  });

  return new Uint8Array(result);
};

/**
 * Converts an entire document to PDF using Gotenberg (no page range limit).
 * Used as pre-extraction input for Word/PowerPoint files — Mistral OCR
 * expects a PDF or image, and we want the LLM to see all pages, not
 * just page 1.
 */
export const convertDocumentToPdf = async (
  buffer: Uint8Array,
  extension: string,
): Promise<Uint8Array> => {
  ensureConfigured();
  const ext = extension.replace(
    /^\./,
    "",
  ) as unknown as LibreOfficeFileExtension;

  const result = await LibreOffice.convert({
    files: [{ data: Buffer.from(buffer), ext }],
  });

  return new Uint8Array(result);
};

// ==================== //
// CHROMIUM SCREENSHOTS //
// ==================== //

/**
 * Viewport used to render HTML / markdown thumbnails. Roughly A4-shaped
 * and clipped to one screen, so a long page yields the same "first page"
 * framing Poppler gives a PDF instead of an unreadably tall strip.
 */
const SCREENSHOT_WIDTH = 900;
const SCREENSHOT_HEIGHT = 1160;

/**
 * POST a Chromium screenshot job to Gotenberg. Called directly rather
 * than through Chromiumly: its screenshot classes only accept file PATHS,
 * and everything here is already in memory.
 */
const captureScreenshot = async (
  route: "html" | "markdown",
  files: { name: string; bytes: Uint8Array }[],
): Promise<Uint8Array> => {
  const form = new FormData();
  for (const file of files) {
    form.append("files", new Blob([file.bytes]), file.name);
  }
  form.append("format", "png");
  form.append("width", String(SCREENSHOT_WIDTH));
  form.append("height", String(SCREENSHOT_HEIGHT));
  form.append("clip", "true");

  const username = process.env.GOTENBERG_API_BASIC_AUTH_USERNAME;
  const password = process.env.GOTENBERG_API_BASIC_AUTH_PASSWORD;
  const headers: Record<string, string> =
    username && password
      ? { Authorization: `Basic ${btoa(`${username}:${password}`)}` }
      : {};

  const response = await fetch(
    `${requireEndpoint()}/forms/chromium/screenshot/${route}`,
    { method: "POST", headers, body: form },
  );

  if (!response.ok) {
    throw new Error(
      `Gotenberg ${route} screenshot failed (${response.status.toString()}): ${await response.text()}`,
    );
  }

  return new Uint8Array(await response.arrayBuffer());
};

/** Render an HTML document to a PNG of its first screen. */
export const captureHtmlScreenshot = (html: Uint8Array): Promise<Uint8Array> =>
  captureScreenshot("html", [{ name: "index.html", bytes: html }]);

/**
 * Shell for Gotenberg's markdown route, which renders an HTML page that
 * pulls the markdown in through its `toHTML` template function.
 *
 * The styles are deliberately self-contained rather than the app's own
 * CSS: Comark styles markdown through Vue components and Nuxt UI classes
 * that Gotenberg's Go renderer never emits, and the compiled
 * `page-runtime` bundle is utility-only — its Tailwind reset flattens
 * `h1`–`h6` to body text, so injecting it would make thumbnails worse.
 */
const MARKDOWN_SHELL = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        margin: 0;
        padding: 48px 56px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        font-size: 15px;
        line-height: 1.6;
        color: #1f2328;
        background: #ffffff;
      }
      h1, h2, h3 { line-height: 1.25; margin: 0 0 12px; }
      pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
      pre { background: #f6f8fa; padding: 12px; border-radius: 6px; overflow: hidden; }
      table { border-collapse: collapse; }
      td, th { border: 1px solid #d0d7de; padding: 4px 8px; }
      img { max-width: 100%; }
    </style>
  </head>
  <body>{{ toHTML "file.md" }}</body>
</html>`;

/** Render a markdown document to a PNG of its first screen. */
export const captureMarkdownScreenshot = (
  markdown: Uint8Array,
): Promise<Uint8Array> =>
  captureScreenshot("markdown", [
    { name: "index.html", bytes: new TextEncoder().encode(MARKDOWN_SHELL) },
    { name: "file.md", bytes: markdown },
  ]);
