import { z } from "zod";

/**
 * Thinking depth a user or a team can request, as VALUES — the HTTP boundary
 * (chat stream request, workflow create/update) and two DB columns
 * (`team_ai_settings.flagship_reasoning_level`, `workflows.reasoning_level`)
 * all need to validate one.
 *
 * The doctrine lives in @fretik/ai `lib/model-registry/types.ts`
 * (`REASONING_LEVELS` / `ReasoningLevel`) — that package owns which levels a
 * given model actually accepts, and how each maps to a wire parameter. This
 * enum must stay identical to it; `tests/unit/lib/model-registry.test.ts`
 * asserts so, because a silent divergence would let the API accept a level the
 * registry cannot map.
 *
 * Its own module rather than living in `schemas/ai.ts` because
 * `schemas/workflows.ts` needs it and must import NOTHING from `../db` (it
 * ships inside the Trigger.dev bundle); `schemas/ai.ts` derives enums from the
 * pg schema and so is db-coupled. Re-exported from there for discoverability.
 */
export const reasoningLevelSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningLevelInput = z.infer<typeof reasoningLevelSchema>;
