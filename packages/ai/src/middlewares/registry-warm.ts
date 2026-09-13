import { ensureModelRegistryWarm } from "../lib/model-registry/resolve";

/**
 * Every route that resolves a model resolves it against a snapshot this
 * process may have lost — see `ensureModelRegistryWarm`. A no-op on the common
 * path (one synchronous check), and the difference between a replica that
 * recovers and one that answers `UNKNOWN_MODEL_PROFILE` about healthy rows
 * until somebody restarts it.
 *
 * Lifted out of `handlers/chatbot.ts` when a second user-facing surface
 * (`/chatbot/suggestions`) needed it: two copies of a recovery path drift, and
 * the one that drifts is the one nobody is watching.
 */
export const registryWarmMiddleware = async (
  _c: unknown,
  next: () => Promise<void>,
): Promise<void> => {
  await ensureModelRegistryWarm();
  await next();
};
