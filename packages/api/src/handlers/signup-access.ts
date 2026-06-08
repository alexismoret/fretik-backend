import {
  authMiddleware,
  type HonoLoggedAppType,
  superAdminMiddleware,
} from "@fretik/shared/lib/auth-middleware";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  addAllowedDomain,
  addToAllowlist,
  listAllowedDomains,
  listAllowlist,
  removeAllowedDomain,
  removeFromAllowlist,
} from "@fretik/shared/services/auth/signup-access";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Closed-beta sign-up access control. Super-admin only — `authMiddleware`
 * authenticates, `superAdminMiddleware` enforces the operator flag. Manages
 * the per-email allowlist and the allowed-domains list that the `signup-gate`
 * reads on every self-serve registration.
 */
const signupAccessRoutes = new OpenAPIHono<HonoLoggedAppType>();
signupAccessRoutes.use("*", authMiddleware);
signupAccessRoutes.use("*", superAdminMiddleware);

const emailEntrySchema = z.object({
  email: z.string(),
  note: z.string().nullable(),
  createdAt: z.date(),
});
const domainEntrySchema = z.object({
  domain: z.string(),
  note: z.string().nullable(),
  createdAt: z.date(),
});

// --- Allowed emails --------------------------------------------------------

const listEmailsRoute = createRoute({
  method: "get",
  path: "/emails",
  summary: "List allowlisted sign-up emails (super-admin)",
  tags: ["Signup access"],
  responses: {
    200: {
      content: { "application/json": { schema: z.array(emailEntrySchema) } },
      description: "Allowlisted emails",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const addEmailRoute = createRoute({
  method: "post",
  path: "/emails",
  summary: "Allowlist a sign-up email (super-admin)",
  tags: ["Signup access"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ email: z.email(), note: z.string().optional() }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ email: z.string() }) },
      },
      description: "Email added",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const removeEmailRoute = createRoute({
  method: "delete",
  path: "/emails",
  summary: "Remove an allowlisted sign-up email (super-admin)",
  tags: ["Signup access"],
  request: { query: z.object({ email: z.email() }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
      description: "Email removed",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// --- Allowed domains -------------------------------------------------------

const domainSchema = z
  .string()
  .min(3)
  .regex(/^@?[a-z0-9.-]+\.[a-z]{2,}$/i, "Invalid domain");

const listDomainsRoute = createRoute({
  method: "get",
  path: "/domains",
  summary: "List allowed sign-up domains (super-admin)",
  tags: ["Signup access"],
  responses: {
    200: {
      content: { "application/json": { schema: z.array(domainEntrySchema) } },
      description: "Allowed domains",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const addDomainRoute = createRoute({
  method: "post",
  path: "/domains",
  summary: "Allow a sign-up domain (super-admin)",
  tags: ["Signup access"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            domain: domainSchema,
            note: z.string().optional(),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ domain: z.string() }) },
      },
      description: "Domain added",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const removeDomainRoute = createRoute({
  method: "delete",
  path: "/domains",
  summary: "Remove an allowed sign-up domain (super-admin)",
  tags: ["Signup access"],
  request: { query: z.object({ domain: domainSchema }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
      description: "Domain removed",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

signupAccessRoutes.openapi(listEmailsRoute, async (c) =>
  c.json(await listAllowlist(), 200),
);
signupAccessRoutes.openapi(addEmailRoute, async (c) => {
  const { email, note } = c.req.valid("json");
  return c.json({ email: await addToAllowlist(email, note) }, 200);
});
signupAccessRoutes.openapi(removeEmailRoute, async (c) => {
  await removeFromAllowlist(c.req.valid("query").email);
  return c.json({ ok: true }, 200);
});

signupAccessRoutes.openapi(listDomainsRoute, async (c) =>
  c.json(await listAllowedDomains(), 200),
);
signupAccessRoutes.openapi(addDomainRoute, async (c) => {
  const { domain, note } = c.req.valid("json");
  return c.json({ domain: await addAllowedDomain(domain, note) }, 200);
});
signupAccessRoutes.openapi(removeDomainRoute, async (c) => {
  await removeAllowedDomain(c.req.valid("query").domain);
  return c.json({ ok: true }, 200);
});

export { signupAccessRoutes };
