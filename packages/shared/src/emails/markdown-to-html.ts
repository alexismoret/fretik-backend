import { Marked, Renderer } from "marked";

/**
 * Markdown → email-safe HTML.
 *
 * Email clients (Outlook, Gmail web/iOS, Apple Mail, …) wildly disagree on
 * what CSS they apply to injected HTML inside `<mj-text>`. The MJML inliner
 * (juice) only inlines styles that match selectors found AT MJML compile
 * time — it cannot reach the markdown HTML we splice in via Handlebars'
 * triple-stache. So instead of relying on `<mj-style inline="inline">` for
 * the prose, every element we emit carries its own `style="…"` attribute.
 *
 * The visual target is the chatbot's own answer rendering (see
 * `app/components/chat/ChatMessageItem.vue`) in the app's identity — zinc
 * greys, links in the teal of its solid buttons (teal-500), square corners
 * (2px) — minimised to the subset of CSS Outlook actually honours. Block-level elements that need a background or
 * a border (code blocks, blockquotes) are wrapped in `<table>` because
 * Outlook's Word-based renderer ignores `padding`/`background` on `<div>`.
 */

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const escapeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * Detect URLs that already carry their own origin (or are otherwise
 * meant to stay as-is). Anything starting with a scheme (`http:`,
 * `https:`, `mailto:`, `tel:`, `data:`, …), a protocol-relative `//`,
 * or an in-page anchor `#` is left untouched.
 */
const isAbsoluteHref = (href: string): boolean => {
  if (href.startsWith("//")) return true;
  if (href.startsWith("#")) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
};

/**
 * Promote a path-only href (`/chatbot/abc`, `/documents/42`) to the
 * full app URL. The chatbot routinely emits links without an origin
 * because in-app they go through the SPA router; in an email they'd
 * 404 against the user's mail client. Anything that isn't an
 * absolute URL **and** doesn't start with `/` is left alone — bare
 * fragments (`page.html`) are too ambiguous to rewrite safely.
 */
const resolveHref = (href: string, baseUrl: string): string => {
  if (isAbsoluteHref(href)) return href;
  if (!href.startsWith("/")) return href;
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  return `${trimmedBase}${href}`;
};

const HEADING_STYLES: Record<number, string> = {
  1: "margin: 24px 0 12px; font-size: 22px; font-weight: 700; line-height: 1.3; color: #18181b;",
  2: "margin: 20px 0 10px; font-size: 18px; font-weight: 700; line-height: 1.35; color: #18181b;",
  3: "margin: 16px 0 8px; font-size: 16px; font-weight: 600; line-height: 1.4; color: #18181b;",
  4: "margin: 14px 0 6px; font-size: 15px; font-weight: 600; line-height: 1.4; color: #18181b;",
  5: "margin: 12px 0 4px; font-size: 14px; font-weight: 600; line-height: 1.4; color: #18181b;",
  6: "margin: 12px 0 4px; font-size: 13px; font-weight: 600; line-height: 1.4; color: #71717a; text-transform: uppercase; letter-spacing: 0.05em;",
};

const buildEmailRenderer = (baseUrl: string): Renderer => {
  const renderer = new Renderer();

  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const clamped = Math.min(Math.max(depth, 1), 6);
    const style = HEADING_STYLES[clamped] ?? HEADING_STYLES[3];
    return `<h${String(clamped)} style="${style}">${text}</h${String(clamped)}>\n`;
  };

  renderer.paragraph = function ({ tokens }) {
    const text = this.parser.parseInline(tokens);
    return `<p style="margin: 0 0 12px; line-height: 1.6; color: #3f3f46; font-size: 15px;">${text}</p>\n`;
  };

  renderer.list = function (token) {
    const tag = token.ordered ? "ol" : "ul";
    const startAttr =
      token.ordered && typeof token.start === "number" && token.start !== 1
        ? ` start="${String(token.start)}"`
        : "";
    const body = token.items
      .map((item) => renderer.listitem.call(this, item))
      .join("");
    return `<${tag}${startAttr} style="margin: 8px 0; padding-left: 24px; color: #3f3f46; font-size: 15px; line-height: 1.6;">\n${body}</${tag}>\n`;
  };

  renderer.listitem = function (item) {
    // Task list checkbox prefix (GFM).
    let prefix = "";
    if (item.task) {
      prefix = item.checked
        ? '<span style="display:inline-block; width:14px; height:14px; margin-right:6px; vertical-align:middle; background:#14b8a6; border-radius:2px; color:#fff; text-align:center; line-height:14px; font-size:11px;">✓</span>'
        : '<span style="display:inline-block; width:14px; height:14px; margin-right:6px; vertical-align:middle; border:1px solid #d4d4d8; border-radius:2px;"></span>';
    }
    const body = this.parser.parse(item.tokens);
    return `<li style="margin: 4px 0;">${prefix}${body}</li>\n`;
  };

  // The task box is drawn by `listitem` above, as a styled span: marked's own
  // checkbox is an `<input>`, which Apple Mail renders beside ours and Gmail
  // strips — either way not the box the app shows.
  renderer.checkbox = function () {
    return "";
  };

  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
    const resolved = resolveHref(href, baseUrl);
    return `<a href="${escapeAttr(resolved)}"${titleAttr} style="color: #14b8a6; text-decoration: underline;">${text}</a>`;
  };

  renderer.strong = function ({ tokens }) {
    return `<strong style="font-weight: 600;">${this.parser.parseInline(tokens)}</strong>`;
  };

  renderer.em = function ({ tokens }) {
    return `<em style="font-style: italic;">${this.parser.parseInline(tokens)}</em>`;
  };

  renderer.del = function ({ tokens }) {
    return `<del style="text-decoration: line-through; color: #71717a;">${this.parser.parseInline(tokens)}</del>`;
  };

  renderer.hr = function () {
    return '<hr style="border: 0; border-top: 1px solid #e4e4e7; margin: 16px 0;" />\n';
  };

  renderer.code = function ({ text, lang }) {
    const langAttr = lang ? ` data-lang="${escapeAttr(lang)}"` : "";
    return [
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 12px 0; border-collapse: collapse;"${langAttr}>`,
      "  <tr>",
      `    <td style="background: #fafafa; border: 1px solid #e4e4e7; border-radius: 2px; padding: 12px 14px; font-family: 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; line-height: 1.5; color: #18181b; white-space: pre-wrap; word-break: break-word;">${escapeHtml(text)}</td>`,
      "  </tr>",
      "</table>\n",
    ].join("\n");
  };

  renderer.codespan = function ({ text }) {
    return `<code style="background: #fafafa; border: 1px solid #e4e4e7; border-radius: 2px; padding: 1px 5px; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 0.9em; color: #18181b;">${text}</code>`;
  };

  renderer.blockquote = function ({ tokens }) {
    const inner = this.parser.parse(tokens);
    return [
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 12px 0; border-collapse: collapse;">',
      "  <tr>",
      `    <td style="border-left: 3px solid #d4d4d8; padding: 4px 14px; color: #71717a; font-style: italic;">${inner}</td>`,
      "  </tr>",
      "</table>\n",
    ].join("\n");
  };

  renderer.image = function ({ href, title, text }) {
    const altAttr = escapeAttr(text || "");
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
    const resolved = resolveHref(href, baseUrl);
    return `<img src="${escapeAttr(resolved)}" alt="${altAttr}"${titleAttr} style="max-width: 100%; height: auto; display: block; margin: 12px 0; border: 0;" />`;
  };

  renderer.table = function ({ header, rows }) {
    const headerHtml = header
      .map((cell) => {
        const align = cell.align ? ` text-align: ${cell.align};` : "";
        return `<th style="border: 1px solid #e4e4e7; padding: 8px 12px; background: #fafafa; font-weight: 600; color: #18181b;${align}">${this.parser.parseInline(cell.tokens)}</th>`;
      })
      .join("");
    const bodyHtml = rows
      .map((row) => {
        const cells = row
          .map((cell) => {
            const align = cell.align ? ` text-align: ${cell.align};` : "";
            return `<td style="border: 1px solid #e4e4e7; padding: 8px 12px; color: #3f3f46;${align}">${this.parser.parseInline(cell.tokens)}</td>`;
          })
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("\n");
    return [
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px;">',
      `  <thead><tr>${headerHtml}</tr></thead>`,
      `  <tbody>${bodyHtml}</tbody>`,
      "</table>\n",
    ].join("\n");
  };

  return renderer;
};

/**
 * Convert a Markdown string produced by the chatbot into email-safe HTML
 * with inline styles. The output is meant to be embedded inside an
 * `<mj-text>` block via Handlebars' triple-stache (`{{{assistantHtml}}}`).
 *
 * `baseUrl` is the app origin (e.g. `https://app.fretik.com`); we use it
 * to promote path-only links the chatbot emits (`/chatbot/abc`,
 * `/documents/42`) to absolute URLs so they actually resolve when the
 * user clicks them in their mail client.
 *
 * Keep in mind: every style must be a single declaration string —
 * `<style>` blocks and class selectors are stripped or ignored by major
 * email clients (Outlook 365 desktop especially). The Marked instance is
 * rebuilt per call because the renderer closes over `baseUrl`; cheap
 * compared to the surrounding I/O (DB read, S3 fetches, SMTP).
 */
export const renderMarkdownToEmailHtml = (
  markdown: string,
  baseUrl: string,
): string => {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) return "";
  const marked = new Marked({
    gfm: true,
    breaks: true,
    renderer: buildEmailRenderer(baseUrl),
  });
  const result = marked.parse(trimmed);
  // `marked.parse` returns a Promise only when async extensions are
  // registered. We don't register any, so the sync overload applies.
  return typeof result === "string" ? result : "";
};
