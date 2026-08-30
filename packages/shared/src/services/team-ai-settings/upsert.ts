import db from "../../db";
import { type TeamAiSettings, teamAiSettings } from "../../db/schema";
import type {
  FunctionProfileKeys,
  ModelFunctionKey,
} from "../../model-registry/functions";
import { isModelFunctionKey } from "../../model-registry/functions";
import type { ReasoningLevelInput } from "../../schemas/reasoning";
import { invalidateTeamAiSettingsCache } from "./cache";

/**
 * Create or update a team's AI model selection. Validation of the profile keys
 * against the registry is the caller's job (`@fretik/ai`
 * `selectableForFunction`) — this service only persists + invalidates the
 * cache. Only the functions the caller mentions are written; a partial write
 * never clobbers a function it did not name.
 *
 * ONE derived rule lives here rather than in the handler, so every caller gets
 * it: **changing the assistant model CLEARS `assistantReasoningLevel`.** A
 * thinking depth is chosen against a specific model — its cost, its latency,
 * its effort ladder — so carrying "xhigh" from one model over to another whose
 * ladder stops at "high" would pin a level the new model rejects. After a model
 * change the team is back on that model's own default until they choose again.
 */
export const upsertTeamAiSettings = async (data: {
  teamId: string;
  /** Per-function picks. A `null` value resets that function to the default. */
  functionProfileKeys?: Partial<Record<ModelFunctionKey, string | null>>;
  /** `ReasoningLevel` for the assistant model; `null` resets to its default. */
  assistantReasoningLevel?: ReasoningLevelInput | null | undefined;
}): Promise<TeamAiSettings> => {
  const { teamId, assistantReasoningLevel } = data;
  const requested = data.functionProfileKeys ?? {};

  // Uncached read on purpose — the reset rule below compares against the row
  // as it actually stands, not a possibly-stale cached copy.
  const existing = await db.query.teamAiSettings.findFirst({
    where: { teamId },
  });

  const stored: FunctionProfileKeys = { ...existing?.functionProfileKeys };
  for (const [fn, key] of Object.entries(requested)) {
    if (!isModelFunctionKey(fn)) continue;
    if (key === null) delete stored[fn];
    else stored[fn] = key;
  }

  // An explicit level always wins; otherwise an ASSISTANT change to a DIFFERENT
  // model clears it. Re-picking the model already in effect is a no-op, so a
  // double-click in the hub can't silently wipe a deliberate choice.
  const assistantChanged =
    requested.assistant !== undefined &&
    (requested.assistant ?? null) !==
      (existing?.functionProfileKeys.assistant ?? null);
  const reasoningLevel =
    assistantReasoningLevel !== undefined
      ? assistantReasoningLevel
      : assistantChanged
        ? null
        : undefined;

  const set: Partial<typeof teamAiSettings.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (Object.keys(requested).length > 0) set.functionProfileKeys = stored;
  if (reasoningLevel !== undefined)
    set.assistantReasoningLevel = reasoningLevel;

  const [row] = await db
    .insert(teamAiSettings)
    .values({
      teamId,
      functionProfileKeys: stored,
      assistantReasoningLevel: assistantReasoningLevel ?? null,
    })
    .onConflictDoUpdate({ target: teamAiSettings.teamId, set })
    .returning();

  if (!row) throw new Error("Failed to upsert team AI settings");

  await invalidateTeamAiSettingsCache(teamId);
  return row;
};
