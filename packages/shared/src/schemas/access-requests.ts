import { z } from "@hono/zod-openapi";
import { accessLevelSchema } from "./access";
import { accessRequestSchema } from "./access-sharing";

export { accessRequestSchema, type AccessRequestView } from "./access-sharing";

/**
 * Asking for more access to a resource one can already see, and deciding such
 * a request. The shapes of `/access/resources/{type}/{id}/requests` and
 * `/access/requests`.
 *
 * Only a resource the person can see is asked for: one they cannot see
 * answers like one that does not exist, and a request would say otherwise.
 */

/** A note to whoever decides: why the access is needed. */
export const MAX_ACCESS_REQUEST_MESSAGE = 500;

export const requestAccessSchema = z
  .object({
    level: accessLevelSchema,
    message: z.string().trim().max(MAX_ACCESS_REQUEST_MESSAGE).optional(),
  })
  .openapi("RequestAccess");
export type RequestAccessInput = z.infer<typeof requestAccessSchema>;

export const accessRequestListSchema = z
  .object({
    /** Pending requests on resources the caller may share. */
    toDecide: z.array(accessRequestSchema),
    /** The caller's own pending requests. */
    mine: z.array(accessRequestSchema),
  })
  .openapi("AccessRequestList");
export type AccessRequestList = z.infer<typeof accessRequestListSchema>;

export const decideAccessRequestSchema = z
  .object({
    decision: z.enum(["approve", "deny"]),
    /** The level to grant, when it differs from the one asked for. */
    level: accessLevelSchema.optional(),
  })
  .openapi("DecideAccessRequest");
export type DecideAccessRequestInput = z.infer<
  typeof decideAccessRequestSchema
>;

export const accessRequestParamsSchema = z.object({
  requestId: z.uuid().openapi({ param: { name: "requestId", in: "path" } }),
});
