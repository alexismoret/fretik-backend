import { z } from "@hono/zod-openapi";

/**
 * Product-update read receipts — the contract shared by the API boundary and
 * `services/changelog/*`. Kept db-free (pure Zod, like `schemas/pins.ts`).
 *
 * The API knows nothing about the updates themselves: their text, media and
 * ordering live in the frontend repo and never reach this service. All it
 * stores is "this person has seen the entry called X", which is why the only
 * vocabulary here is a slug.
 */

/** Matches `varchar(128)` on `changelog_reads.slug`. */
export const CHANGELOG_SLUG_MAX_LENGTH = 128;

/**
 * Upper bound on one mark-as-seen call. Dismissing the modal marks every
 * entry the reader had not seen yet — normally one, a handful for someone
 * back from a long absence — so anything past this is not a returning user.
 */
export const MAX_CHANGELOG_SLUGS_PER_CALL = 100;

/**
 * A slug is a directory name in the frontend repo, and the frontend is the
 * only thing that ever mints one. Constrained anyway: it becomes a primary-key
 * value, and an unbounded string from a client is an unbounded row.
 */
export const changelogSlugSchema = z
  .string()
  .min(1)
  .max(CHANGELOG_SLUG_MAX_LENGTH)
  .regex(
    /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/,
    "A slug is lowercase alphanumerics separated by - or .",
  );

export const changelogSeenResponseSchema = z.object({
  /** Every slug this user has been shown, in no particular order. */
  slugs: z.array(changelogSlugSchema),
});

export type ChangelogSeenResponse = z.infer<typeof changelogSeenResponseSchema>;

export const markChangelogSeenRequestSchema = z.object({
  slugs: z.array(changelogSlugSchema).min(1).max(MAX_CHANGELOG_SLUGS_PER_CALL),
});

export type MarkChangelogSeenRequest = z.infer<
  typeof markChangelogSeenRequestSchema
>;

export const markChangelogSeenResponseSchema = z.object({
  /** How many slugs were newly recorded (0 when everything was already seen). */
  added: z.number().int().nonnegative(),
});

export type MarkChangelogSeenResponse = z.infer<
  typeof markChangelogSeenResponseSchema
>;
