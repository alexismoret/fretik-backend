import { access } from "@fretik/shared/authz/http";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  notFound,
  teamRequired,
  throwHttpError,
} from "@fretik/shared/lib/errors";
import { bodyIdListSchema, paramsIdSchema } from "@fretik/shared/schemas";
import {
  AddConversationMembersSchema,
  ConversationBackgroundTasksResponseSchema,
  conversationListQuerySchema,
  ConversationResponseSchema,
  CreateConversationSchema,
  MemberPreferencesResponseSchema,
  MembersResponseSchema,
  MessagesResponseSchema,
  UpdateConversationSchema,
  UpdateMemberPreferencesSchema,
} from "@fretik/shared/schemas/ai";
import {
  nextCursorSchema,
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
import { setMemberPinned } from "@fretik/shared/services/ai/members/set-pinned";
import { getConversationMessages } from "@fretik/shared/services/ai/messages";
import { updateConversation } from "@fretik/shared/services/ai/update";
import { listConversationTasks } from "@fretik/shared/services/conversation-tasks/list";
import { serializeConversationTask } from "@fretik/shared/services/conversation-tasks/serialize";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

// ==================== //
// ROUTER SETUP         //
// ==================== //

/**
 * A chat belongs to its participants (`ai_conversation_members`): its owner
 * has full access, the others take part (`use`) — they read it, write in it,
 * rename it and bring colleagues in. Being in its team is not enough. The
 * routes on one conversation name that level (`access.resource`), and the
 * services stay gated on the caller's seat.
 */
const conversationRoutes = new OpenAPIHono<HonoLoggedAppType>();
conversationRoutes.use("*", authMiddleware);

// ==================== //
// ROUTE DEFINITIONS    //
// ==================== //

const listConversationsRoute = createRoute({
  method: "get",
  path: "/",
  middleware: access.session(
    "The conversations the caller takes part in, in the active team.",
  ),
  summary: "List AI conversations",
  description:
    "List conversations the current user participates in for a given agent type (defaults to chatbot), the caller's pinned ones first then most-recently-active. `pinned` narrows to one of those two blocks; `paginate=cursor` walks the unpinned block forward by key and returns `nextCursor` instead of an exact `count`.",
  tags: ["Conversations"],
  request: { query: conversationListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            count: z.number(),
            data: z.array(ConversationResponseSchema),
            // Only on the walk, where `count` is not computed.
            nextCursor: nextCursorSchema.optional(),
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
  middleware: access.session(
    "Starts a conversation in the active team, with the caller as its owner.",
  ),
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
  middleware: access.resource("conversation", "view"),
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
  middleware: access.resource("conversation", "use"),
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
  middleware: access.handler(
    "Only a conversation's owner deletes it; other ids are skipped (deleteConversations).",
  ),
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
  middleware: access.resource("conversation", "view"),
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
  middleware: access.resource("conversation", "view"),
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
  middleware: access.resource("conversation", "use"),
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
  middleware: access.resource("conversation", "use"),
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

const updateMemberPreferencesRoute = createRoute({
  method: "patch",
  path: "/{id}/members/me",
  middleware: access.resource("conversation", "use"),
  summary: "Update my own preferences on this conversation",
  description:
    "Email-on-completion and the pin are both PER MEMBER: a conversation is shared, and neither field changes what anyone else sees. Every field is optional and only the ones sent are written. Re-pinning something already pinned keeps its position instead of moving it to the top.",
  tags: ["Conversations"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": { schema: UpdateMemberPreferencesSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: MemberPreferencesResponseSchema },
      },
      description: "Preferences updated",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const markReadRoute = createRoute({
  method: "post",
  path: "/{id}/read",
  middleware: access.resource("conversation", "view"),
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

  const { agentType, pinned, paginate, cursor, ...params } =
    c.req.valid("query");

  const result = await listConversations({
    teamId: team.id,
    userId: user.id,
    agentType,
    params,
    pinned,
    paginate,
    ...(cursor ? { cursor } : {}),
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

conversationRoutes.openapi(updateMemberPreferencesRoute, async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const { id } = c.req.valid("param");
  const { emailOnCompletion, pinned } = c.req.valid("json");

  if (emailOnCompletion !== undefined) {
    await setMemberEmailPreference({
      conversationId: id,
      teamId: team.id,
      userId: user.id,
      emailOnCompletion,
    });
  }
  if (pinned !== undefined) {
    await setMemberPinned({
      conversationId: id,
      teamId: team.id,
      userId: user.id,
      pinned,
    });
  }

  // Read back rather than echo the request: `pinnedAt` is decided by the
  // database (`COALESCE(pinned_at, now())`), so the stored value is the only
  // one that can be reported honestly.
  const conversation = await getConversation({
    id,
    teamId: team.id,
    userId: user.id,
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  return c.json(
    {
      emailOnCompletion: conversation.emailOnCompletion,
      pinned: conversation.pinned,
      pinnedAt: conversation.pinnedAt,
    },
    200,
  );
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
