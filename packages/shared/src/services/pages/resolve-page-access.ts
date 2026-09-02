import db from "../../db";
import type { Page } from "../../db/schema";
import type { PageDefinition } from "../../schemas/pages";

/** Any RFC 4122 version — `publicToken` is minted as v7, older ones exist. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  // `public_token` is a uuid column, so a token that is not one cannot match a
  // row — but sending it anyway makes Postgres raise `invalid input syntax for
  // type uuid`, which reaches an anonymous caller as a 500 carrying a database
  // message. The public API route checks this too, and keeps doing so: there
  // it also saves the round trip, on the one endpoint whose request rate an
  // abuser controls. Here it is what makes the SERVICE safe to call, rather
  // than one caller safe to have written.
  if (!UUID.test(params.token)) return { access: "not_found" };

  const page = await db.query.pages.findFirst({
    where: { publicToken: params.token },
  });
  if (!page) return { access: "not_found" };

  const definition = page.publishedDefinition;
  if (!definition) return { access: "not_found" };

  return { access: "ready", page, definition };
};
