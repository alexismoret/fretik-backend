import type { PageDefinition } from "../../schemas/pages";

/**
 * The one-line description a page shows in the hub, in search, and in the
 * assistant's listing — taken from the brief when nobody wrote one.
 *
 * The builder writes `brief.product.job` before it writes a line of code, and
 * never fills `description`, so every agent-authored page used to list itself
 * as a bare name. The brief already holds the sentence, in the words the page
 * was asked for; copying it costs nothing and is what makes a listing readable.
 *
 * Returns `undefined` when there is nothing to derive or a description already
 * exists — a human sentence is never overwritten by a generated one.
 */
export const derivePageDescription = (params: {
  current: string | undefined;
  definition: PageDefinition | undefined;
}): string | undefined => {
  if (params.current !== undefined && params.current.trim() !== "") {
    return undefined;
  }
  const job = params.definition?.brief?.product.job.trim();
  return job ? job : undefined;
};
