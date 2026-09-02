import { z } from "@hono/zod-openapi";

/**
 * Per-user sidebar pins — the contract shared by the API boundary and
 * `services/pins/*`. Kept db-free (pure Zod, like `schemas/pages.ts`): the
 * `.openapi()` extension is patched in by the API entrypoint, so this file
 * imports nothing but `zod`.
 */

/**
 * A sidebar that scrolls forever stops being a shortcut. The cap is enforced
 * on write (`pinTarget`) and mirrored on the reorder payload, so a client
 * cannot smuggle more entries in through the ordering endpoint.
 */
export const MAX_PINS_PER_USER_TEAM = 50;

export const pinTargetTypeSchema = z.enum(["collection", "page", "workflow"]);

export type PinTargetType = z.infer<typeof pinTargetTypeSchema>;

/** The natural key of a pin, minus the scope the session already carries. */
export const pinTargetSchema = z.object({
  targetType: pinTargetTypeSchema,
  targetId: z.uuid(),
});

export type PinTarget = z.infer<typeof pinTargetSchema>;

/**
 * One rendered sidebar entry. Carries everything the nav item needs — label,
 * icon, color, route key — so the sidebar never fans out into one request per
 * pin just to learn what to draw.
 *
 * `key` is the collection's route slug (a collection is addressed by `key`,
 * not by id) and is NULL for a page or a workflow, both addressed by id.
 */
export const pinItemSchema = z.object({
  targetType: pinTargetTypeSchema,
  targetId: z.uuid(),
  key: z.string().nullable(),
  label: z.string(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  displayOrder: z.number().int(),
  pinnedAt: z.coerce.date(),
});

export type PinItem = z.infer<typeof pinItemSchema>;

export const pinListResponseSchema = z.object({
  data: z.array(pinItemSchema),
});

export const createPinRequestSchema = pinTargetSchema;

/**
 * The FULL pin list in its new order — never a partial one. Ordering is a
 * dense 0…n-1 rewrite: rows left out of the payload would keep indices that
 * collide with the ones just assigned, and the next read would order them
 * arbitrarily. The service refuses a payload that does not cover exactly the
 * caller's current set.
 */
export const reorderPinsRequestSchema = z.object({
  items: z.array(pinTargetSchema).max(MAX_PINS_PER_USER_TEAM),
});

export const pinOkResponseSchema = z.object({ ok: z.boolean() });
