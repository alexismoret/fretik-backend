/**
 * Curated "featured" MCP catalog — the SaaS apps businesses actually connect,
 * shown first in the hub with a real display name, a real brand logo, the
 * vendor's OWN first-party endpoint, and a known auth mode. The open registry is
 * a great long-tail source but a poor storefront (reverse-DNS names, ~9% logos,
 * community wrappers that masquerade as official — e.g. a fake "Google Maps"
 * that takes the API key as a tool argument). This hand-maintained head fixes
 * name/logo/trust/auth for the vendors that matter; the registry fills the tail
 * behind it, filtered to official namespaces.
 *
 * Every entry connects DIRECT to `serverUrl` via our own transport — no proxy.
 * `auth` is what inspect returns instead of a best-effort probe, so a curated
 * connection is reliable (oauth ⇒ Nango DCR, api-key ⇒ manual key form, none ⇒
 * connect immediately). Logos are the brand's real favicon (root marketing
 * domain), which renders the actual coloured mark — unlike the remote subdomain.
 *
 * NOT here (deliberately): OAuth suites whose official MCP has drop-in friction
 * — Google Workspace (Developer-Preview enrolment), Slack (needs a pre-registered
 * directory-published app), Microsoft 365 / Salesforce / ServiceNow / Snowflake
 * (tenant/org-scoped URLs). Those belong on the native OAuth (Nango) provider
 * layer, not a static MCP row. URLs verified live (initialize probe, 2026-07-13);
 * a stale one degrades gracefully (inspect marks it not-connectable).
 */

import { faviconUrlForServer } from "../../services/external-apps/mcp/favicon";
import type { McpServerEntry } from "./types";

export interface CuratedMcpEntry {
  /** Stable catalog id — the registry name when the vendor is listed there. */
  qualifiedName: string;
  displayName: string;
  description: string;
  /** Root marketing domain, used to derive the brand logo (favicon). */
  brandDomain: string;
  homepage: string;
  /** The vendor's own first-party remote endpoint. */
  serverUrl: string;
  transport: "http" | "sse";
  /** Known connect mode — inspect returns this instead of probing. */
  auth: "oauth" | "api-key" | "none";
}

export const CURATED_MCP_SERVERS: readonly CuratedMcpEntry[] = [
  // ── Productivity / docs / project management ──────────────────────────
  {
    qualifiedName: "com.notion/mcp",
    displayName: "Notion",
    description:
      "Search, read and update Notion pages, databases and comments.",
    brandDomain: "notion.so",
    homepage: "https://www.notion.so",
    serverUrl: "https://mcp.notion.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "app.linear/linear",
    displayName: "Linear",
    description: "Manage Linear issues, projects and cycles.",
    brandDomain: "linear.app",
    homepage: "https://linear.app",
    serverUrl: "https://mcp.linear.app/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.atlassian/atlassian-mcp-server",
    displayName: "Atlassian (Jira & Confluence)",
    description: "Manage Jira issues and Confluence pages.",
    brandDomain: "atlassian.com",
    homepage: "https://www.atlassian.com",
    serverUrl: "https://mcp.atlassian.com/v1/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.monday/monday.com",
    displayName: "monday.com",
    description: "Manage monday.com boards, items and updates.",
    brandDomain: "monday.com",
    homepage: "https://monday.com",
    serverUrl: "https://mcp.monday.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.asana/mcp",
    displayName: "Asana",
    description: "Manage Asana tasks, projects and portfolios.",
    brandDomain: "asana.com",
    homepage: "https://asana.com",
    serverUrl: "https://mcp.asana.com/sse",
    transport: "sse",
    auth: "oauth",
  },
  {
    qualifiedName: "com.clickup/mcp",
    displayName: "ClickUp",
    description: "Manage ClickUp tasks, docs and spaces.",
    brandDomain: "clickup.com",
    homepage: "https://clickup.com",
    serverUrl: "https://mcp.clickup.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.airtable/mcp",
    displayName: "Airtable",
    description: "Read and write Airtable bases, tables and records.",
    brandDomain: "airtable.com",
    homepage: "https://airtable.com",
    serverUrl: "https://mcp.airtable.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.miro/mcp",
    displayName: "Miro",
    description: "Work with Miro boards and items.",
    brandDomain: "miro.com",
    homepage: "https://miro.com",
    serverUrl: "https://mcp.miro.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.canva/mcp",
    displayName: "Canva",
    description: "Create and manage Canva designs and assets.",
    brandDomain: "canva.com",
    homepage: "https://www.canva.com",
    serverUrl: "https://mcp.canva.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.box/mcp",
    displayName: "Box",
    description: "Search and manage files in Box.",
    brandDomain: "box.com",
    homepage: "https://www.box.com",
    serverUrl: "https://mcp.box.com",
    transport: "http",
    auth: "oauth",
  },

  // ── Design / dev / infra ──────────────────────────────────────────────
  {
    qualifiedName: "io.github.github/github-mcp-server",
    displayName: "GitHub",
    description:
      "Work with GitHub repositories, issues, pull requests and actions.",
    brandDomain: "github.com",
    homepage: "https://github.com",
    serverUrl: "https://api.githubcopilot.com/mcp/",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.gitlab/mcp",
    displayName: "GitLab",
    description: "Work with GitLab projects, issues and merge requests.",
    brandDomain: "gitlab.com",
    homepage: "https://gitlab.com",
    serverUrl: "https://gitlab.com/api/v4/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.figma.mcp/mcp",
    displayName: "Figma",
    description: "Read Figma files, frames and design context.",
    brandDomain: "figma.com",
    homepage: "https://www.figma.com",
    serverUrl: "https://mcp.figma.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.sentry/mcp",
    displayName: "Sentry",
    description: "Investigate Sentry issues, events and releases.",
    brandDomain: "sentry.io",
    homepage: "https://sentry.io",
    serverUrl: "https://mcp.sentry.dev/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.vercel/mcp",
    displayName: "Vercel",
    description: "Manage Vercel projects, deployments and domains.",
    brandDomain: "vercel.com",
    homepage: "https://vercel.com",
    serverUrl: "https://mcp.vercel.com",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.netlify/mcp",
    displayName: "Netlify",
    description: "Manage Netlify sites, deploys and env vars.",
    brandDomain: "netlify.com",
    homepage: "https://www.netlify.com",
    serverUrl: "https://netlify-mcp.netlify.app/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.render/mcp",
    displayName: "Render",
    description: "Manage Render services and deploys.",
    brandDomain: "render.com",
    homepage: "https://render.com",
    serverUrl: "https://mcp.render.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.heroku/mcp",
    displayName: "Heroku",
    description: "Manage Heroku apps, dynos and add-ons.",
    brandDomain: "heroku.com",
    homepage: "https://www.heroku.com",
    serverUrl: "https://mcp.heroku.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "io.prisma/mcp",
    displayName: "Prisma",
    description: "Manage Prisma Postgres databases and schemas.",
    brandDomain: "prisma.io",
    homepage: "https://www.prisma.io",
    serverUrl: "https://mcp.prisma.io/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "tech.neon/mcp",
    displayName: "Neon",
    description: "Manage Neon Postgres projects and branches.",
    brandDomain: "neon.tech",
    homepage: "https://neon.tech",
    serverUrl: "https://mcp.neon.tech/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.supabase/mcp",
    displayName: "Supabase",
    description: "Manage Supabase projects, tables and edge functions.",
    brandDomain: "supabase.com",
    homepage: "https://supabase.com",
    serverUrl: "https://mcp.supabase.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.mongodb/mcp",
    displayName: "MongoDB Atlas",
    description: "Query and manage MongoDB Atlas clusters.",
    brandDomain: "mongodb.com",
    homepage: "https://www.mongodb.com",
    serverUrl: "https://mcp.mongodb.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.postman/mcp",
    displayName: "Postman",
    description: "Work with Postman collections and APIs.",
    brandDomain: "postman.com",
    homepage: "https://www.postman.com",
    serverUrl: "https://mcp.postman.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.cloudinary/mcp",
    displayName: "Cloudinary",
    description: "Manage Cloudinary media assets.",
    brandDomain: "cloudinary.com",
    homepage: "https://cloudinary.com",
    serverUrl: "https://asset-management.mcp.cloudinary.com/sse",
    transport: "sse",
    auth: "oauth",
  },
  {
    qualifiedName: "com.workos/mcp",
    displayName: "WorkOS",
    description: "Manage WorkOS organizations, users and SSO connections.",
    brandDomain: "workos.com",
    homepage: "https://workos.com",
    serverUrl: "https://mcp.workos.com/mcp",
    transport: "http",
    auth: "oauth",
  },

  // ── Observability / analytics ─────────────────────────────────────────
  {
    qualifiedName: "com.datadoghq/mcp",
    displayName: "Datadog",
    description: "Query Datadog metrics, logs, monitors and incidents.",
    brandDomain: "datadoghq.com",
    homepage: "https://www.datadoghq.com",
    serverUrl: "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.grafana/mcp",
    displayName: "Grafana",
    description: "Query Grafana dashboards, datasources and alerts.",
    brandDomain: "grafana.com",
    homepage: "https://grafana.com",
    serverUrl: "https://mcp.grafana.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.posthog/mcp",
    displayName: "PostHog",
    description: "Query PostHog analytics, insights and feature flags.",
    brandDomain: "posthog.com",
    homepage: "https://posthog.com",
    serverUrl: "https://mcp.posthog.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.amplitude/mcp",
    displayName: "Amplitude",
    description: "Query Amplitude analytics and charts.",
    brandDomain: "amplitude.com",
    homepage: "https://amplitude.com",
    serverUrl: "https://mcp.amplitude.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.mixpanel/mcp",
    displayName: "Mixpanel",
    description: "Query Mixpanel events, funnels and reports.",
    brandDomain: "mixpanel.com",
    homepage: "https://mixpanel.com",
    serverUrl: "https://mcp.mixpanel.com/mcp",
    transport: "http",
    auth: "oauth",
  },

  // ── Payments / finance ────────────────────────────────────────────────
  {
    qualifiedName: "com.stripe/mcp",
    displayName: "Stripe",
    description:
      "Query customers, payments, invoices and subscriptions in Stripe.",
    brandDomain: "stripe.com",
    homepage: "https://stripe.com",
    serverUrl: "https://mcp.stripe.com",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.paypal.mcp/mcp",
    displayName: "PayPal",
    description: "Manage PayPal orders, invoices, payments and disputes.",
    brandDomain: "paypal.com",
    homepage: "https://www.paypal.com",
    serverUrl: "https://mcp.paypal.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.squareup/mcp",
    displayName: "Square",
    description: "Manage Square payments, catalog and orders.",
    brandDomain: "squareup.com",
    homepage: "https://squareup.com",
    serverUrl: "https://mcp.squareup.com/sse",
    transport: "sse",
    auth: "oauth",
  },
  {
    qualifiedName: "com.plaid/mcp",
    displayName: "Plaid",
    description: "Work with Plaid financial data and connections.",
    brandDomain: "plaid.com",
    homepage: "https://plaid.com",
    serverUrl: "https://api.dashboard.plaid.com/mcp/sse",
    transport: "sse",
    auth: "oauth",
  },
  {
    qualifiedName: "com.ramp/mcp",
    displayName: "Ramp",
    description: "Query Ramp spend, transactions and cards.",
    brandDomain: "ramp.com",
    homepage: "https://ramp.com",
    serverUrl: "https://mcp.ramp.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.mercury/mcp",
    displayName: "Mercury",
    description: "Query Mercury banking accounts and transactions.",
    brandDomain: "mercury.com",
    homepage: "https://mercury.com",
    serverUrl: "https://mcp.mercury.com/mcp",
    transport: "http",
    auth: "oauth",
  },

  // ── CRM / sales / support ─────────────────────────────────────────────
  {
    qualifiedName: "com.hubspot/mcp",
    displayName: "HubSpot",
    description: "Work with HubSpot contacts, deals, tickets and companies.",
    brandDomain: "hubspot.com",
    homepage: "https://www.hubspot.com",
    serverUrl: "https://app.hubspot.com/mcp/v1/http",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.attio/mcp",
    displayName: "Attio",
    description: "Manage Attio records, lists and objects.",
    brandDomain: "attio.com",
    homepage: "https://attio.com",
    serverUrl: "https://mcp.attio.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.close/mcp",
    displayName: "Close",
    description: "Manage Close CRM leads, contacts and opportunities.",
    brandDomain: "close.com",
    homepage: "https://close.com",
    serverUrl: "https://mcp.close.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.pipedrive/mcp",
    displayName: "Pipedrive",
    description: "Manage Pipedrive deals, contacts and activities.",
    brandDomain: "pipedrive.com",
    homepage: "https://www.pipedrive.com",
    serverUrl: "https://mcp.pipedrive.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.intercom/mcp",
    displayName: "Intercom",
    description:
      "Read and manage Intercom conversations, contacts and tickets.",
    brandDomain: "intercom.com",
    homepage: "https://www.intercom.com",
    serverUrl: "https://mcp.intercom.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "io.gong/mcp",
    displayName: "Gong",
    description: "Query Gong calls, deals and insights.",
    brandDomain: "gong.io",
    homepage: "https://www.gong.io",
    serverUrl: "https://mcp.gong.io/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "ai.fireflies/mcp",
    displayName: "Fireflies",
    description: "Query Fireflies meeting transcripts and summaries.",
    brandDomain: "fireflies.ai",
    homepage: "https://fireflies.ai",
    serverUrl: "https://mcp.fireflies.ai/mcp",
    transport: "http",
    auth: "oauth",
  },

  // ── Web / content / commerce ──────────────────────────────────────────
  {
    qualifiedName: "com.webflow/mcp",
    displayName: "Webflow",
    description: "Manage Webflow sites, CMS collections and items.",
    brandDomain: "webflow.com",
    homepage: "https://webflow.com",
    serverUrl: "https://mcp.webflow.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.wix/mcp",
    displayName: "Wix",
    description: "Manage Wix sites, stores and bookings.",
    brandDomain: "wix.com",
    homepage: "https://www.wix.com",
    serverUrl: "https://mcp.wix.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.retool/mcp",
    displayName: "Retool",
    description: "Work with Retool apps and resources.",
    brandDomain: "retool.com",
    homepage: "https://retool.com",
    serverUrl: "https://mcp.retool.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.dropbox/mcp",
    displayName: "Dropbox",
    description: "Search and manage files in Dropbox.",
    brandDomain: "dropbox.com",
    homepage: "https://www.dropbox.com",
    serverUrl: "https://mcp.dropbox.com/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "ai.devrev/mcp",
    displayName: "DevRev",
    description: "Work with DevRev tickets, issues and parts.",
    brandDomain: "devrev.ai",
    homepage: "https://devrev.ai",
    serverUrl: "https://api.devrev.ai/mcp/v1",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "com.stackoverflow/mcp",
    displayName: "Stack Overflow",
    description: "Search Stack Overflow for Teams knowledge.",
    brandDomain: "stackoverflow.com",
    homepage: "https://stackoverflow.com",
    serverUrl: "https://mcp.stackoverflow.com",
    transport: "http",
    auth: "oauth",
  },

  // ── AI / research utilities (API-key or open) ─────────────────────────
  {
    qualifiedName: "co.huggingface/mcp",
    displayName: "Hugging Face",
    description: "Search Hugging Face models, datasets and spaces.",
    brandDomain: "huggingface.co",
    homepage: "https://huggingface.co",
    serverUrl: "https://huggingface.co/mcp",
    transport: "http",
    auth: "oauth",
  },
  {
    qualifiedName: "ai.exa/mcp",
    displayName: "Exa",
    description: "Neural web search and content retrieval.",
    brandDomain: "exa.ai",
    homepage: "https://exa.ai",
    serverUrl: "https://mcp.exa.ai/mcp",
    transport: "http",
    auth: "api-key",
  },
  {
    qualifiedName: "dev.firecrawl/mcp",
    displayName: "Firecrawl",
    description: "Crawl and scrape websites into clean data.",
    brandDomain: "firecrawl.dev",
    homepage: "https://firecrawl.dev",
    serverUrl: "https://mcp.firecrawl.dev/mcp",
    transport: "http",
    auth: "api-key",
  },
  {
    qualifiedName: "com.browserbase/mcp",
    displayName: "Browserbase",
    description: "Drive headless browser sessions for the web.",
    brandDomain: "browserbase.com",
    homepage: "https://www.browserbase.com",
    serverUrl: "https://mcp.browserbase.com/mcp",
    transport: "http",
    auth: "api-key",
  },
  {
    qualifiedName: "so.tally/mcp",
    displayName: "Tally",
    description: "Read Tally forms and responses.",
    brandDomain: "tally.so",
    homepage: "https://tally.so",
    serverUrl: "https://api.tally.so/mcp",
    transport: "http",
    auth: "api-key",
  },
  {
    qualifiedName: "com.deepwiki/mcp",
    displayName: "DeepWiki",
    description: "Ask questions about any public GitHub repo.",
    brandDomain: "deepwiki.com",
    homepage: "https://deepwiki.com",
    serverUrl: "https://mcp.deepwiki.com/mcp",
    transport: "http",
    auth: "none",
  },
];

const BY_QUALIFIED_NAME: ReadonlyMap<string, CuratedMcpEntry> = new Map(
  CURATED_MCP_SERVERS.map((e) => [e.qualifiedName, e]),
);

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
};

/** Registry names + remote hosts already covered by a curated entry (dedup). */
export const CURATED_QUALIFIED_NAMES: ReadonlySet<string> = new Set(
  CURATED_MCP_SERVERS.map((e) => e.qualifiedName),
);
export const CURATED_REMOTE_HOSTS: ReadonlySet<string> = new Set(
  CURATED_MCP_SERVERS.map((e) => hostOf(e.serverUrl)),
);

/** The curated entry for a qualified name, or undefined. */
export const findCuratedMcp = (
  qualifiedName: string,
): CuratedMcpEntry | undefined => BY_QUALIFIED_NAME.get(qualifiedName);

/** Brand logo for a curated entry — the real favicon of its marketing domain. */
export const curatedIconUrl = (entry: CuratedMcpEntry): string | null =>
  faviconUrlForServer(`https://${entry.brandDomain}`);

/** A curated entry as a catalog list item (always `verified`). */
export const toCuratedServerEntry = (
  entry: CuratedMcpEntry,
): McpServerEntry => ({
  qualifiedName: entry.qualifiedName,
  displayName: entry.displayName,
  description: entry.description,
  iconUrl: curatedIconUrl(entry),
  homepage: entry.homepage,
  verified: true,
});

/** Curated entries matching a query (name/description), all when no query. */
export const matchCuratedEntries = (
  q: string | undefined,
): McpServerEntry[] => {
  const entries = CURATED_MCP_SERVERS.map(toCuratedServerEntry);
  if (q === undefined || q === "") return entries;
  const needle = q.toLowerCase();
  return entries.filter(
    (e) =>
      e.displayName.toLowerCase().includes(needle) ||
      e.description.toLowerCase().includes(needle) ||
      e.qualifiedName.toLowerCase().includes(needle),
  );
};
