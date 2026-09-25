import { z } from "@hono/zod-openapi";
import { accessLevelSchema } from "./access";
import { sharingResourceTypeSchema } from "./access-sharing";

/**
 * What others have shared with a person, where they find it again: the shape
 * of `/access/shared-with-me`.
 */

/** How a share reaches the person: by name, or through a group they are in. */
export const SHARED_VIA = ["user", "team", "project", "organization"] as const;
export const sharedViaSchema = z.enum(SHARED_VIA);
export type SharedVia = z.infer<typeof sharedViaSchema>;

export const sharedItemSchema = z
  .object({
    resource: z.object({
      type: sharingResourceTypeSchema,
      id: z.string(),
      name: z.string(),
      teamId: z.string(),
      teamName: z.string().nullable(),
    }),
    /** What the person has on it now: other paths may give more than the share. */
    level: accessLevelSchema,
    via: sharedViaSchema,
    sharedBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
    sharedAt: z.date(),
    /** A document's file type, for its icon; null for everything else. */
    mimeType: z.string().nullable(),
  })
  .openapi("SharedItem");
export type SharedItem = z.infer<typeof sharedItemSchema>;

export const sharedWithMeSchema = z
  .object({ items: z.array(sharedItemSchema) })
  .openapi("SharedWithMe");
export type SharedWithMe = z.infer<typeof sharedWithMeSchema>;
