import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  notFound,
  teamRequired,
  throwHttpError,
} from "@fretik/shared/lib/errors";
import { ANTI_BUFFERING_HEADERS } from "@fretik/shared/lib/sse-headers";
import {
  clearConversationActiveStream,
  getConversationActiveStream,
} from "@fretik/shared/services/ai/active-stream";
import {
  getTurnLogStatus,
  readTurnLogAsSse,
  TURN_LOG_ORPHAN_MS,
} from "@fretik/shared/services/ai/turn-log";
import { isOrgAdmin } from "@fretik/shared/services/organization/member-role";
import { getWorkflowRunRow } from "@fretik/shared/services/workflows/get-run";
import { OpenAPIHono } from "@hono/zod-openapi";
import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { uuidv7TimestampMs } from "../lib/uuidv7-time";

/**
 * Live workflow-run transcript — the browser-facing half of the turn-log
 * pump in `handlers/workflow.ts` (`executeTurn`). The REST transcript
 * (`GET /workflows/runs/:id/transcript` on the API) serves the persisted
 * turns; this endpoint streams the turn currently being generated, chunk
 * by chunk, same wire format as the chat's reconnection endpoint.
 *
 * Auth mirrors the API transcript route: Better Auth cookie + the run's
 * team + the parent workflow's visibility gate — NOT conversation
 * membership, because workflow conversations have no member roster.
 */

/** Same benefit-of-the-doubt window as the chat's reconnection endpoint:
 * the log is opened right after the slot write, so a missing log usually
 * means Redis lost the key — unless the claim is only milliseconds old. */
const STREAM_CLAIM_GRACE_MS = 15_000;

/** Redis Stream entry-id shape (`<ms>-<n>`); anything else falls to 0-0. */
const TURN_LOG_CURSOR_RE = /^\d+-\d+$/;

const workflowTranscriptRoutes = new OpenAPIHono<HonoLoggedAppType>();
workflowTranscriptRoutes.use("*", authMiddleware);

/**
 * GET /workflow-runs/:runId/transcript/stream
 *
 * Semantics (same contract as `GET /chatbot/:id/stream`):
 *   - 204 No Content   → no turn is streaming right now. The client keeps
 *                        its REST transcript and retries later.
 *   - 200 event-stream → the live turn's log replayed from the requested
 *                        cursor (`Last-Event-ID` header or `?cursor=`;
 *                        absent → `0-0`). Frames carry `id: <entry-id>`
 *                        so a reconnect resumes with zero overlap, and the
 *                        stream ends with `[DONE]` when the turn closes.
 */
workflowTranscriptRoutes.get("/:runId/transcript/stream", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const runId = c.req.param("runId");
  const run = await getWorkflowRunRow({
    id: runId,
    teamId: team.id,
    requester: {
      userId: user.id,
      isAdmin: await isOrgAdmin(team.organizationId, user.id),
    },
  });
  if (!run) return throwHttpError(404, notFound("Run not found"));
  const conversationId = run.conversationId;
  if (conversationId === null) return new Response(null, { status: 204 });

  const activeStreamId = await getConversationActiveStream(conversationId);
  if (!activeStreamId) {
    return new Response(null, { status: 204 });
  }

  const status = await getTurnLogStatus(activeStreamId);
  if (!status.exists) {
    const claimedAt = uuidv7TimestampMs(activeStreamId);
    const isFreshClaim =
      claimedAt !== null && Date.now() - claimedAt < STREAM_CLAIM_GRACE_MS;
    if (!isFreshClaim) {
      await clearConversationActiveStream(conversationId, activeStreamId);
    }
    return new Response(null, { status: 204 });
  }
  if (!status.ended && Date.now() - status.lastEntryMs > TURN_LOG_ORPHAN_MS) {
    // Dead producer (deploy/crash mid-turn): a live pump pings its log
    // every 5s. Clear the slot so the next turn's force-set is not even
    // needed for the viewer to recover; the client falls back to the
    // persisted transcript.
    await clearConversationActiveStream(conversationId, activeStreamId);
    return new Response(null, { status: 204 });
  }

  const rawCursor = c.req.header("Last-Event-ID") ?? c.req.query("cursor");
  const cursor =
    rawCursor && TURN_LOG_CURSOR_RE.test(rawCursor) ? rawCursor : "0-0";
  return new Response(readTurnLogAsSse(activeStreamId, cursor), {
    status: 200,
    headers: {
      ...UI_MESSAGE_STREAM_HEADERS,
      ...ANTI_BUFFERING_HEADERS,
    },
  });
});

export { workflowTranscriptRoutes };
