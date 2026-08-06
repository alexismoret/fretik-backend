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
  AddConversationMembersSchema,
  aiAgentTypeSchema,
  ConversationBackgroundTasksResponseSchema,
  ConversationResponseSchema,
  CreateConversationSchema,
  MembersResponseSchema,
  MessagesResponseSchema,
  SetMemberEmailPreferenceSchema,
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
import { addConversationMembers } from "@fretik/shared/services/ai/members/add";
import { markConversationRead } from "@fretik/shared/services/ai/members/mark-read";
import { removeConversationMember } from "@fretik/shared/services/ai/members/remove";
import { setMemberEmailPreference } from "@fretik/shared/services/ai/members/set-email-preference";
import { getConversationMessages } from "@fretik/shared/services/ai/messages";
import { updateConversation } from "@fretik/shared/services/ai/update";
import { listConversationTasks } from "@fretik/shared/services/conversation-tasks/list";
import { serializeConversationTask } from "@fretik/shared/services/conversation-tasks/serialize";
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
    "List conversations the current user participates in for a given agent type (defaults to chatbot), most-recently-active first.",
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
    "Return a single conversation the current user participates in: metadata, member roster, the caller's role and email opt-in, plus unread / action-required flags.",
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
    "Rename a conversation. Any participant may rename. The email-on-completion opt-in is per-member and lives on PATCH /{id}/members/me.",
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
    "Return the message history as Vercel AI SDK UIMessage objects, ready to inject into the Chat class on the client. `limit` returns only the last N messages (still oldest-first) — the mount path uses it to keep reload payloads bounded.",
  tags: ["Conversations"],
  request: {
    params: paramsIdSchema,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
  },
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

const getBackgroundTasksRoute = createRoute({
  method: "get",
  path: "/{id}/background-tasks",
  summary: "List background work a conversation is waiting on",
  description:
    "Workflow runs the agent launched from this conversation: everything still running, plus what finished recently. The conversation is resumed automatically once they are all done.",
  tags: ["Conversations"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ConversationBackgroundTasksResponseSchema,
        },
      },
      description: "Background tasks retrieved successfully",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const memberIdParamsSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
});

const addMembersRoute = createRoute({
  method: "post",
  path: "/{id}/members",
  summary: "Add conversation members",
  description:
    "Add team members as participants. Ids that aren't real team members are ignored. Returns the refreshed roster.",
  tags: ["Conversations"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: AddConversationMembersSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: MembersResponseSchema } },
      description: "Members added",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const removeMemberRoute = createRoute({
  method: "delete",
  path: "/{id}/members/{userId}",
  summary: "Remove a conversation member",
  description:
    "Remove a participant. The conversation owner cannot be removed. Returns the refreshed roster.",
  tags: ["Conversations"],
  request: { params: memberIdParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: MembersResponseSchema } },
      description: "Member removed",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const setMemberEmailRoute = createRoute({
  method: "patch",
  path: "/{id}/members/me",
  summary: "Set my email-on-completion preference",
  description:
    "Toggle the current user's personal opt-in to be emailed at the end of every assistant turn. Affects only the caller.",
  tags: ["Conversations"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: SetMemberEmailPreferenceSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: SetMemberEmailPreferenceSchema },
      },
      description: "Preference updated",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const markReadRoute = createRoute({
  method: "post",
  path: "/{id}/read",
  summary: "Mark a conversation as read",
  description:
    "Clear the unread indicator and any action-required badge for the current user.",
  tags: ["Conversations"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ success: z.boolean() }) },
      },
      description: "Marked as read",
    },
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

  const { title, agentType, modelProfileKey } = c.req.valid("json");

  const row = await createConversation({
    organizationId: organization.id,
    teamId: team.id,
    userId: user.id,
    title,
    agentType,
    modelProfileKey,
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

  const { limit } = c.req.valid("query");
  const messages = await getConversationMessages(conversation.id, limit);

  return c.json(messages, 200);
});

conversationRoutes.openapi(getBackgroundTasksRoute, async (c) => {
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

  const tasks = await listConversationTasks(conversation.id);

  return c.json({ tasks: tasks.map(serializeConversationTask) }, 200);
});

conversationRoutes.openapi(addMembersRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { id } = c.req.valid("param");
  const { userIds } = c.req.valid("json");

  const members = await addConversationMembers({
    conversationId: id,
    teamId: team.id,
    requesterId: user.id,
    userIds,
  });

  return c.json(members, 200);
});

conversationRoutes.openapi(removeMemberRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { id, userId } = c.req.valid("param");

  const members = await removeConversationMember({
    conversationId: id,
    teamId: team.id,
    requesterId: user.id,
    targetUserId: userId,
  });

  return c.json(members, 200);
});

conversationRoutes.openapi(setMemberEmailRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { id } = c.req.valid("param");
  const { emailOnCompletion } = c.req.valid("json");

  const result = await setMemberEmailPreference({
    conversationId: id,
    teamId: team.id,
    userId: user.id,
    emailOnCompletion,
  });

  return c.json(result, 200);
});

conversationRoutes.openapi(markReadRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { id } = c.req.valid("param");

  await markConversationRead({ conversationId: id, userId: user.id });

  return c.json({ success: true }, 200);
});

export { conversationRoutes };
