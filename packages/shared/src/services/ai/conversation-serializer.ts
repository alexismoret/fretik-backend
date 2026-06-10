import type {
  aiConversationMembers,
  aiConversations,
  user,
} from "../../db/schema";

/**
 * Single source of truth for serialising a collaborative conversation.
 *
 * Every read path (`get`, `list`) loads a conversation with the same
 * `conversationWith` relation selection and projects it through
 * `serializeConversation`, so the API shape can never drift between paths.
 * The projection exposes the full member roster plus the *current user's*
 * own per-conversation state (role, email opt-in, unread, action-required).
 *
 * Input types are derived from the Drizzle `$inferSelect` row types so they
 * stay locked to the schema; only the computed output shape is hand-written.
 */

export type ConversationMemberRole =
  (typeof aiConversationMembers.$inferSelect)["role"];

/** A member row joined to its user, as loaded by `conversationWith`. */
export type ConversationMemberRow = Pick<
  typeof aiConversationMembers.$inferSelect,
  | "userId"
  | "role"
  | "emailOnCompletion"
  | "lastReadAt"
  | "mentionedAt"
  | "joinedAt"
> & {
  user: Pick<
    typeof user.$inferSelect,
    "id" | "name" | "email" | "image"
  > | null;
};

/** A conversation row joined to its members, as loaded by `conversationWith`. */
export type ConversationRowWithMembers = typeof aiConversations.$inferSelect & {
  members: ConversationMemberRow[];
};

/** A participant as exposed to the API (user fields flattened onto the row). */
export type ConversationMember = Pick<
  typeof aiConversationMembers.$inferSelect,
  "userId" | "role"
> &
  Pick<typeof user.$inferSelect, "name" | "email" | "image">;

/** The API projection of a conversation for one viewing user. */
export type SerializedConversation = Omit<
  typeof aiConversations.$inferSelect,
  "activeStreamId"
> & {
  /** Full participant roster (humans only — the bot is never a member). */
  members: ConversationMember[];
  /** The current user's role in this conversation. */
  role: ConversationMemberRole;
  /** The current user's *personal* end-of-turn email opt-in. */
  emailOnCompletion: boolean;
  /** When the current user last read the conversation (catch-up anchor). */
  lastReadAt: Date | null;
  /** When the current user joined — catch-up fallback when never read. */
  joinedAt: Date;
  /** New activity since the current user last opened the conversation. */
  unread: boolean;
  /** The current user was @mentioned and hasn't read since. */
  actionRequired: boolean;
};

/**
 * Relation + column selection shared by every enriched read. Spread into a
 * `db.query.aiConversations.find*({ with: conversationWith })`.
 */
export const conversationWith = {
  members: {
    columns: {
      userId: true,
      role: true,
      emailOnCompletion: true,
      lastReadAt: true,
      mentionedAt: true,
      joinedAt: true,
    },
    with: {
      user: {
        columns: { id: true, name: true, email: true, image: true },
      },
    },
  },
} as const;

export const serializeConversation = (
  row: ConversationRowWithMembers,
  userId: string,
): SerializedConversation => {
  const { activeStreamId: _activeStreamId, members, ...conversation } = row;
  const current = members.find((m) => m.userId === userId);
  const lastReadAt = current?.lastReadAt ?? null;
  const mentionedAt = current?.mentionedAt ?? null;

  return {
    ...conversation,
    members: members.map((m) => ({
      userId: m.userId,
      name: m.user?.name ?? "",
      email: m.user?.email ?? "",
      image: m.user?.image ?? null,
      role: m.role,
    })),
    role: current?.role ?? "member",
    emailOnCompletion: current?.emailOnCompletion ?? false,
    lastReadAt,
    joinedAt: current?.joinedAt ?? row.createdAt,
    unread: lastReadAt === null || lastReadAt < row.updatedAt,
    actionRequired:
      mentionedAt !== null && (lastReadAt === null || mentionedAt > lastReadAt),
  };
};
