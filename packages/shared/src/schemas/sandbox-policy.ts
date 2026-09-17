import { z } from "@hono/zod-openapi";

/**
 * Per-organization egress policy for the code sandbox.
 *
 * The sandbox runs agent-authored code, so its outbound network is the one
 * place where a prompt injection turns into an exfiltration. The policy is
 * therefore deny-by-default and composed from TIERS, only one of which an
 * admin edits:
 *
 *  - **platform** — the Fretik backend host. Always allowed: without it the
 *    code-mode SDK cannot call back, and it is a host we own.
 *  - **providers** — hosts the team's ACTIVE external-app connections need to
 *    move bytes (a SharePoint tenant serves its own download URLs). Derived
 *    from the connections, never typed by hand: disconnecting the app removes
 *    the host. Always allowed, for the same reason as platform.
 *  - **packages** — the public package registries. On in every mode but
 *    `platform_only`.
 *  - **org** — extra domains the admin adds, honoured only in
 *    `packages_plus_domains`.
 *
 * Anything else the agent needs from the web goes through a tool that fetches
 * SERVER-side (`downloadFile` for bytes, `webFetch` for text), so the VM never
 * needs a general-purpose internet connection.
 */

export const SANDBOX_EGRESS_MODES = [
  "platform_only",
  "packages",
  "packages_plus_domains",
] as const;
export const sandboxEgressModeSchema = z.enum(SANDBOX_EGRESS_MODES);
export type SandboxEgressMode = (typeof SANDBOX_EGRESS_MODES)[number];

/** Ceiling on the admin-managed list. Measured: E2B accepts 75+ entries. */
export const SANDBOX_MAX_EXTRA_DOMAINS = 50;

const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_PATTERN = new RegExp(
  `^(\\*\\.)?(?:${DOMAIN_LABEL}\\.)+[a-z]{2,63}$`,
);

/**
 * Wildcard bases broad enough that allowing `*.<base>` hands the sandbox every
 * tenant, user page or app on a shared platform — the exact shape of an
 * exfiltration channel that looks like a legitimate allow rule. The list is
 * about SHARED namespaces, not about vendors we distrust: a specific host
 * under any of them (`contoso.sharepoint.com`) is still accepted.
 */
const SHARED_WILDCARD_BASES = new Set([
  "amazonaws.com",
  "azurewebsites.net",
  "blob.core.windows.net",
  "cloudfront.net",
  "co.jp",
  "co.uk",
  "com.au",
  "com.br",
  "github.io",
  "githubusercontent.com",
  "googleapis.com",
  "herokuapp.com",
  "netlify.app",
  "pages.dev",
  "r2.dev",
  "sharepoint.com",
  "storage.googleapis.com",
  "vercel.app",
  "workers.dev",
]);

/**
 * The SHAPE an egress entry may take: a hostname, or a `*.` wildcard over one.
 * Deliberately NOT an IP, a CIDR, a URL or a port — E2B matches domains by
 * SNI, so anything else either cannot be enforced or widens the policy in a
 * way nobody reading the list can see.
 *
 * This is the schema for entries WE write: provider manifests, which are code
 * and get reviewed. `sandboxDomainSchema` adds the rule that only applies to
 * entries a person types into a settings page.
 */
export const sandboxHostPatternSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(253)
  .regex(
    DOMAIN_PATTERN,
    "Enter a hostname such as files.example.com, or a wildcard such as *.example.com",
  )
  .refine(
    (value) => !value.startsWith("*.") || value.slice(2).split(".").length >= 2,
    "A wildcard needs at least two labels after it, such as *.example.com",
  );

/**
 * An entry an ADMIN types. Same shape, plus the shared-platform rule: a
 * manifest may legitimately need `*.sharepoint.com`, because that is where
 * Graph serves a tenant's own bytes and the entry is only ever added while a
 * connection to that app is live. A domain typed into a settings box has no
 * such bound, and `*.sharepoint.com` there would hand the sandbox every
 * tenant on the platform.
 */
export const sandboxDomainSchema = sandboxHostPatternSchema.refine(
  (value) =>
    !value.startsWith("*.") || !SHARED_WILDCARD_BASES.has(value.slice(2)),
  "That wildcard covers a shared platform and would open every tenant on it — name the exact host instead",
);

const extraDomainsSchema = z
  .array(sandboxDomainSchema)
  .max(
    SANDBOX_MAX_EXTRA_DOMAINS,
    `At most ${SANDBOX_MAX_EXTRA_DOMAINS.toString()} domains`,
  )
  .transform((domains) => [...new Set(domains)].sort());

export const organizationSandboxPolicySchema = z
  .object({
    egressMode: sandboxEgressModeSchema.default("packages"),
    extraDomains: extraDomainsSchema.default([]),
  })
  .openapi("OrganizationSandboxPolicy");
export type OrganizationSandboxPolicy = z.infer<
  typeof organizationSandboxPolicySchema
>;

/**
 * What a team gets before an admin has ever opened the page: package
 * registries reachable, nothing else. Matches what Claude and Codex default
 * to for a team workspace, and is what the agent's prompt describes.
 */
export const DEFAULT_ORGANIZATION_SANDBOX_POLICY: OrganizationSandboxPolicy = {
  egressMode: "packages",
  extraDomains: [],
};

/**
 * Read a stored (sparse, possibly legacy) policy into a complete one. Never
 * throws: a column written by an older shape must not break a chat turn, so an
 * unparseable value falls back to the default rather than failing the turn
 * that needed a sandbox.
 */
export const resolveSandboxPolicy = (
  stored: unknown,
): OrganizationSandboxPolicy => {
  const parsed = organizationSandboxPolicySchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : DEFAULT_ORGANIZATION_SANDBOX_POLICY;
};

/** PATCH body — a partial policy; omitted fields keep their stored value. */
export const organizationSandboxPolicyPatchSchema = z
  .object({
    egressMode: sandboxEgressModeSchema.optional(),
    extraDomains: extraDomainsSchema.optional(),
  })
  .openapi("OrganizationSandboxPolicyPatch");
export type OrganizationSandboxPolicyPatch = z.infer<
  typeof organizationSandboxPolicyPatchSchema
>;

/**
 * GET/PATCH response. Carries the tiers the admin does NOT control so the page
 * can show what is reachable without the reader having to trust a sentence:
 * the platform host, the package registries, and whether provider hosts are in
 * play at all.
 */
export const organizationSandboxPolicyResponseSchema = z
  .object({
    policy: organizationSandboxPolicySchema,
    defaults: organizationSandboxPolicySchema,
    limits: z.object({ maxDomains: z.number().int().positive() }),
    alwaysAllowed: z.object({
      platform: z.array(z.string()),
      packages: z.array(z.string()),
    }),
  })
  .openapi("OrganizationSandboxPolicyResponse");
export type OrganizationSandboxPolicyResponse = z.infer<
  typeof organizationSandboxPolicyResponseSchema
>;
