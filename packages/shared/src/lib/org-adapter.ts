import { getOrgAdapter } from "better-auth/plugins/organization";
import { auth } from "./auth";
import { ORG_ADAPTER_OPTIONS } from "./auth-constants";

/**
 * Better Auth's organization data layer, for the writes our own endpoints make
 * — the team endpoints, whose rules (a team's leads manage it) are ours, not
 * the plugin's organization-role permissions.
 *
 * The adapter, not hand-written rows: it owns the `team_member` uniqueness
 * key, the durable `team.member_count` the seat limit is enforced against,
 * and the ordering that keeps both safe under concurrency (the same choice
 * `auth-hooks.ts` makes inside a hook). It fires NO organization hook, so
 * every caller runs the lifecycle the hook would have (`auth-membership.ts`).
 */

type AdapterContext = Parameters<typeof getOrgAdapter>[0];

export const organizationAdapter = async () => {
  // `auth.$context` is the context every plugin endpoint receives. Its type
  // carries our exact options, which TypeScript will not relate back to the
  // generic `BetterAuthOptions` the adapter is declared against; the adapter
  // reads only `adapter` and `internalAdapter` from it.
  const context = (await auth.$context) as unknown as AdapterContext;
  return getOrgAdapter(context, ORG_ADAPTER_OPTIONS);
};
