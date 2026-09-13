import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  createApiError,
  teamRequired,
  throwHttpError,
  validationError,
} from "@fretik/shared/lib/errors";
import { redis } from "@fretik/shared/lib/redis";
import { chatSuggestionFeedbackSchema } from "@fretik/shared/schemas/chat-suggestions";
import { markChatSuggestion } from "@fretik/shared/services/chat-suggestions/mark";
import { OpenAPIHono } from "@hono/zod-openapi";
import { registryWarmMiddleware } from "../middlewares/registry-warm";
import { getOrRefreshSuggestions } from "../services/chat-suggestions/get-or-refresh";

/**
 * Personalized starter prompts for the chatbot home screen.
 *
 * Lives in @fretik/ai rather than @fretik/api for the same reason
 * `/model-profiles` does: it resolves a model through this package's registry,
 * which @fretik/api cannot import. The frontend already talks to this service.
 *
 * Plain Hono routes, like every chat-adjacent surface here — the payloads are
 * one enum and nothing else, and the OpenAPI document these would join is the
 * REST API's, not this service's.
 */

const chatSuggestionsRoutes = new OpenAPIHono<HonoLoggedAppType>();
chatSuggestionsRoutes.use("*", authMiddleware);
chatSuggestionsRoutes.use("*", registryWarmMiddleware);

/** A person mashing Refresh must not become a per-click LLM bill. */
const MANUAL_REFRESH_COOLDOWN_SECONDS = 300;

chatSuggestionsRoutes.get("/", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const suggestions = await getOrRefreshSuggestions({
    organizationId: team.organizationId,
    teamId: team.id,
    userId: user.id,
    language: user.language,
  });

  return c.json(suggestions, 200);
});

chatSuggestionsRoutes.post("/refresh", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  // The cooldown is the rate limit itself, not a guard in front of one: the
  // key's own TTL is what expires it, so there is no counter to reset.
  const acquired = await redis.set(
    `chat-suggestions:refresh:${team.id}:${user.id}`,
    "1",
    "EX",
    MANUAL_REFRESH_COOLDOWN_SECONDS,
    "NX",
  );
  if (acquired === null) {
    return throwHttpError(
      429,
      createApiError(
        "RATE_LIMITED",
        "Suggestions were refreshed a moment ago. Try again in a few minutes.",
      ),
    );
  }

  const suggestions = await getOrRefreshSuggestions({
    organizationId: team.organizationId,
    teamId: team.id,
    userId: user.id,
    language: user.language,
    force: true,
  });

  return c.json(suggestions, 200);
});

chatSuggestionsRoutes.post("/:id/feedback", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = chatSuggestionFeedbackSchema.safeParse(body);
  if (!parsed.success) {
    return throwHttpError(
      400,
      validationError("Expected { status: 'used' | 'dismissed' }"),
    );
  }

  await markChatSuggestion({
    id: c.req.param("id"),
    userId: user.id,
    teamId: team.id,
    status: parsed.data.status,
  });

  return c.json({ ok: true }, 200);
});

export { chatSuggestionsRoutes };
