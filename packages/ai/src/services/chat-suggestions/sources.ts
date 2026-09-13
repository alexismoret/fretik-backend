import type {
  DashboardActivityItem,
  DashboardAttentionItem,
} from "@fretik/shared/schemas/dashboard";
import { listMemoryTreeWithContent } from "@fretik/shared/services/ai-memory/list-tree";
import type { SerializedConversation } from "@fretik/shared/services/ai/conversation-serializer";
import { listConversations } from "@fretik/shared/services/ai/list";
import {
  listRecentSuggestionLabels,
  type ResolvedSuggestionLabel,
} from "@fretik/shared/services/chat-suggestions/list-recent-feedback";
import { getDashboardActivity } from "@fretik/shared/services/dashboard/get-activity";
import { getDashboardAttention } from "@fretik/shared/services/dashboard/get-attention";
import {
  listStandingEpisodes,
  type StandingEpisode,
} from "@fretik/shared/services/episodes/list-standing";
import { listPages } from "@fretik/shared/services/pages/retrieve";
import { listWorkflows } from "@fretik/shared/services/workflows/list";
import { withSoftTimeout } from "../../lib/stream-errors";

/**
 * Everything the suggestion writer is allowed to know, gathered in one fan-out.
 *
 * Nothing here is new: every loader already serves a turn, a dashboard card or
 * a settings page. That is deliberate — the suggestions must describe the same
 * workspace the rest of the product describes, and a second way of reading
 * "what happened lately" would drift from the first one within a month.
 *
 * PER READER. `listStandingEpisodes` and `listMemoryTreeWithContent` both
 * filter `user_id IS NULL OR user_id = :caller`, so a colleague's private
 * episodes and private memories cannot reach this pack — which is also why the
 * generated rows are stored per user and never shared.
 *
 * Every source soft-fails to empty on its own timer, like
 * `assembleContextFragments`: this runs while somebody watches a skeleton, and
 * one slow query must cost its own section rather than the screen.
 */

/** Per-source ceiling. Generous — the caller is behind one LLM call anyway. */
const SOURCE_TIMEOUT_MS = 4_000;

const RECENT_CONVERSATIONS = 10;
const RECENT_ACTIVITY = 12;
const MAX_MEMORY_FILES = 8;
const MAX_CAPABILITIES = 12;

export interface TeamCapability {
  kind: "workflow" | "page";
  id: string;
  name: string;
  description: string | null;
}

export interface SuggestionSources {
  episodes: StandingEpisode[];
  conversations: SerializedConversation[];
  memories: { scope: string; path: string; content: string; updatedAt: Date }[];
  attention: DashboardAttentionItem[];
  activity: DashboardActivityItem[];
  capabilities: TeamCapability[];
  resolvedLabels: ResolvedSuggestionLabel[];
}

export interface SuggestionScope {
  organizationId: string;
  teamId: string;
  userId: string;
}

const soft = async <T>(
  promise: Promise<T>,
  fallback: T,
  label: string,
): Promise<T> =>
  withSoftTimeout(
    promise.catch((error: unknown) => {
      console.warn(
        `[chat-suggestions] ${label} failed, continuing without it:`,
        error instanceof Error ? error.message : error,
      );
      return fallback;
    }),
    SOURCE_TIMEOUT_MS,
    fallback,
    `chat-suggestions:${label}`,
  );

export const loadSuggestionSources = async (
  scope: SuggestionScope,
): Promise<SuggestionSources> => {
  const requester = { userId: scope.userId, isAdmin: false };

  const [
    episodes,
    conversations,
    memories,
    attention,
    activity,
    workflows,
    pages,
    resolvedLabels,
  ] = await Promise.all([
    soft(
      listStandingEpisodes(scope),
      { items: [], visibleInWindow: 0 },
      "episodes",
    ),
    soft(
      listConversations({
        teamId: scope.teamId,
        userId: scope.userId,
        agentType: "chatbot",
        params: { limit: RECENT_CONVERSATIONS, page: 0 },
      }),
      { count: 0, data: [] },
      "conversations",
    ),
    soft(listMemoryTreeWithContent(scope), [], "memories"),
    soft(
      getDashboardAttention({ teamId: scope.teamId, userId: scope.userId }),
      { count: 0, items: [] },
      "attention",
    ),
    soft(
      getDashboardActivity({ teamId: scope.teamId, limit: RECENT_ACTIVITY }),
      { items: [] },
      "activity",
    ),
    soft(listWorkflows({ teamId: scope.teamId, requester }), [], "workflows"),
    soft(
      listPages({ teamId: scope.teamId, requester, limit: MAX_CAPABILITIES }),
      [],
      "pages",
    ),
    soft(
      listRecentSuggestionLabels({
        userId: scope.userId,
        teamId: scope.teamId,
      }),
      [],
      "resolved-labels",
    ),
  ]);

  const capabilities: TeamCapability[] = [
    ...workflows
      .filter((workflow) => workflow.status !== "archived")
      .map((workflow) => ({
        kind: "workflow" as const,
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
      })),
    ...pages.map((page) => ({
      kind: "page" as const,
      id: page.id,
      name: page.name,
      description: page.description,
    })),
  ].slice(0, MAX_CAPABILITIES);

  return {
    episodes: episodes.items,
    conversations: conversations.data,
    // Newest first, then capped: a memory store grows without bound and the
    // recently touched files are the ones describing current work.
    memories: [...memories]
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, MAX_MEMORY_FILES)
      .map((entry) => ({
        scope: entry.scope,
        path: entry.path,
        content: entry.content,
        updatedAt: entry.updatedAt,
      })),
    attention: attention.items,
    activity: activity.items,
    capabilities,
    resolvedLabels,
  };
};
