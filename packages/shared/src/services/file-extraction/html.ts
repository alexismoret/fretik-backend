import { htmlToMarkdown } from "mdream";

/**
 * HTML → markdown, for the `html` extraction route and for the HTML
 * bodies of e-mails.
 *
 * The ORIGINAL markup is never replaced by this: the agent still reads
 * an HTML document raw (`agentAccess: "raw-text"`) so it can inspect or
 * rewrite the markup itself. This rendering exists for the surfaces that
 * want prose — the manifest preview, the search index, a summary.
 *
 * `mdream` is a zero-dependency streaming converter built for exactly
 * this (HTML → markdown for an LLM), so no DOM is allocated for a page
 * we only read once.
 */
export const convertHtmlToMarkdown = (html: string): string =>
  htmlToMarkdown(html).trim();
