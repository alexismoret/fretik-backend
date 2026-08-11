import db from "../../db";
import type { Page } from "../../db/schema";
import type { PageDefinition } from "../../schemas/pages";

export type PageAccessResult =
  | {
      access: "ready";
      page: Page;
      /** The FROZEN definition — never the working one. */
      definition: PageDefinition;
    }
  | { access: "not_found" };

/**
 * Resolve the page behind a public token.
 *
 * A published page is open to anyone holding the link — there is no private
 * variant, unlike forms: publishing IS the decision to expose, and it is
 * confirmed explicitly at publish time. Unpublishing clears the token, so a
 * revoked link is indistinguishable from one that never existed.
 *
 * Returns `publishedDefinition`, never `definition`: edits made after
 * publishing must not reach anonymous viewers until the team republishes.
 */
export const resolvePageAccess = async (params: {
  token: string;
}): Promise<PageAccessResult> => {
  const page = await db.query.pages.findFirst({
    where: { publicToken: params.token },
  });
  if (!page) return { access: "not_found" };

  const definition = page.publishedDefinition;
  if (!definition) return { access: "not_found" };

  return { access: "ready", page, definition };
};
