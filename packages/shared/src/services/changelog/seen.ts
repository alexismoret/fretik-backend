import { eq } from "drizzle-orm";
import db from "../../db";
import { changelogReads } from "../../db/schema";

/**
 * Product-update read receipts. Two statements, no business rules — the
 * decision of WHICH update to announce is the frontend's, because it is the
 * only side that holds the entries (see `db/schema/changelog-reads.ts`).
 */

/**
 * Every entry this user has already been shown.
 *
 * Returned whole rather than paged: a slug is ~30 bytes and entries are
 * written by hand a few times a month, so the list stays in the low hundreds
 * for the lifetime of the product. The caller diffs it against the entries it
 * has bundled.
 */
export const listSeenChangelogSlugs = async (
  userId: string,
): Promise<string[]> => {
  const rows = await db
    .select({ slug: changelogReads.slug })
    .from(changelogReads)
    .where(eq(changelogReads.userId, userId));
  return rows.map((row) => row.slug);
};

/**
 * Record that this user has been shown these entries.
 *
 * Idempotent, and deliberately so: the modal marks on dismiss, and a dismiss
 * that races with a second tab (or a retry after a flaky response) must not
 * fail. `onConflictDoNothing` also preserves the FIRST `seen_at`, which is the
 * timestamp the adoption metric wants.
 *
 * Returns how many rows were new, which is what distinguishes "the user just
 * read this" from "the client replayed a list it already sent".
 */
export const markChangelogSeen = async (params: {
  userId: string;
  slugs: string[];
}): Promise<number> => {
  const slugs = [...new Set(params.slugs)];
  if (slugs.length === 0) return 0;

  const inserted = await db
    .insert(changelogReads)
    .values(slugs.map((slug) => ({ userId: params.userId, slug })))
    .onConflictDoNothing()
    .returning({ slug: changelogReads.slug });

  return inserted.length;
};
