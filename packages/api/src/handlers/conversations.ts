import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  notFound,
  teamRequired,
  throwHttpError,
} from "@fretik/shared/lib/errors";
import {
  bodyIdListSchema,
  paramsIdSchema,
  paramsListSchema,
} from "@fretik/shared/schemas";
import {
  aiAgentTypeSchema,
  ConversationResponseSchema,
  CreateConversationSchema,
  MessagesResponseSchema,
  UpdateConversationSchema,
} from "@fretik/shared/schemas/ai";
import {
  responseCreatedSchemaBuilder,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
  responseSuccessDeletedSchema,
} from "@fretik/shared/schemas/common/responses";
import { createConversation } from "@fretik/shared/services/ai/create";
import { deleteConversations } from "@fretik/shared/services/ai/delete";
import { getConversation } from "@fretik/shared/services/ai/get";
import { listConversations } from "@fretik/shared/services/ai/list";
import { getConversationMessages } from "@fretik/shared/services/ai/messages";
import { updateConversation } from "@fretik/shared/services/ai/update";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

// ==================== //
// ROUTER SETUP         //
// ==================== //

const conversationRoutes = new OpenAPIHono<HonoLoggedAppType>();
conversationRoutes.use("*", authMiddleware);

// ==================== //
// ROUTE DEFINITIONS    //
// ==================== //

const listConversationsRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List AI conversations",
  description:
    "List conversations owned by the current user for a given agent type (defaults to chatbot).",
  tags: ["Conversations"],
  request: {
    query: paramsListSchema.extend({
      agentType: aiAgentTypeSchema.optional().default("chatbot"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            count: z.number(),
            data: z.array(ConversationResponseSchema),
          }),
        },
      },
      description: "Conversations retrieved successfully",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createConversationRoute = createRoute({
  method: "post",
  path: "/",
  summary: "Create an AI conversation",
  description: "Create a new conversation scoped to the current user and team.",
  tags: ["Conversations"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateConversationSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    ...responseCreatedSchemaBuilder(
      ConversationResponseSchema,
      "Conversation created",
    ),
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getConversationRoute = createRoute({
  method: "get",
  path: "/{id}",
  summary: "Get an AI conversation",
  description:
    "Return the metadata of a single conversation owned by the current user (title, emailOnCompletion toggle, …).",
  tags: ["Conversations"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: ConversationResponseSchema },
      },
      description: "Conversation retrieved successfully",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const updateConversationRoute = createRoute({
  method: "patch",
  path: "/{id}",
  summary: "Update an AI conversation",
  description:
    "Rename a conversation and/or toggle the `emailOnCompletion` notification flag. At least one field must be provided.",
  tags: ["Conversations"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": {
          schema: UpdateConversationSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: ConversationResponseSchema },
      },
      description: "Conversation updated",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteConversationsRoute = createRoute({
  method: "delete",
  path: "/",
  summary: "Delete AI conversations",
  description: "Delete multiple conversations by id.",
  tags: ["Conversations"],
  request: {
    body: {
      content: {
        "application/json": { schema: bodyIdListSchema },
      },
    },
  },
  responses: {
    ...responseSuccessDeletedSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getMessagesRoute = createRoute({
  method: "get",
  path: "/{id}/messages",
  summary: "Get messages of an AI conversation",
  description:
    "Return the full message history as Vercel AI SDK UIMessage objects, ready to inject into the Chat class on the client.",
  tags: ["Conversations"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: MessagesResponseSchema },
      },
      description: "Messages retrieved successfully",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// ==================== //
// ROUTE HANDLERS       //
// ==================== //

conversationRoutes.openapi(listConversationsRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { agentType, ...params } = c.req.valid("query");

  const result = await listConversations({
    teamId: team.id,
    userId: user.id,
    agentType,
    params,
  });

  return c.json(result, 200);
});

conversationRoutes.openapi(createConversationRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  const organization = c.get("organization");
  if (!team) return throwHttpError(403, teamRequired());

  const { title, agentType } = c.req.valid("json");

  const row = await createConversation({
    organizationId: organization.id,
    teamId: team.id,
    userId: user.id,
    title,
    agentType,
  });

  return c.json(row, 201);
});

conversationRoutes.openapi(getConversationRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { id } = c.req.valid("param");

  const conversation = await getConversation({
    id,
    teamId: team.id,
    userId: user.id,
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  return c.json(conversation, 200);
});

conversationRoutes.openapi(updateConversationRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { id } = c.req.valid("param");
  const updates = c.req.valid("json");

  const updated = await updateConversation({
    id,
    teamId: team.id,
    userId: user.id,
    updates,
  });

  return c.json(updated, 200);
});

conversationRoutes.openapi(deleteConversationsRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { ids } = c.req.valid("json");

  const res = await deleteConversations({
    ids,
    teamId: team.id,
    userId: user.id,
  });

  return c.json({ rowCount: res.rowCount }, 200);
});

conversationRoutes.openapi(getMessagesRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { id } = c.req.valid("param");

  const conversation = await getConversation({
    id,
    teamId: team.id,
    userId: user.id,
  });

  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  const messages = await getConversationMessages(conversation.id);

  return c.json(messages, 200);
});

export { conversationRoutes };
