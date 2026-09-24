import { legacyPrivacyWhere } from "../../authz/legacy-privacy";
import type { Principal } from "../../authz/principal";
import type { AccessLevel } from "../../schemas/access";

/**
 * Which pages a principal reaches, and at what level — decided by the access
 * engine (`authz/`): the page's owner, its grants, and its container (its
 * project, else its team) unless the page is restricted.
 *
 * Every page service takes a PRINCIPAL. There is no "no requester" path any
 * more, and no admin widening: an organization admin reads a colleague's
 * private page exactly like anyone else — through a grant. A caller with no
 * person behind it (the public page resolver, which authorised through the
 * token) passes `systemPrincipal(reason)`, and says why.
 *
 * The filter is spread into a relational `where`; an invisible page, or one
 * the principal reaches below `level`, is simply not found. Routes and tools
 * check the level first (`access.resource`, `requireAccess`) so a person who
 * can see the page gets a 403 that says why, not this 404.
 */
export const pageAccessWhere = (principal: Principal, level: AccessLevel) =>
  legacyPrivacyWhere({ principal, level, resourceType: "page" });
