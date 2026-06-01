/**
 * Langfuse score ingestion (via `@langfuse/client`).
 *
 * Used for ASYNC, user-driven scores that arrive outside a turn's active
 * span — e.g. thumbs feedback or an implicit retry signal. The client keeps
 * its own batched HTTP queue (independent of the OTel span exporter), so we
 * create the score and flush it within the request.
 *
 * No-op when Langfuse is unconfigured (`langfuseClient` is undefined).
 */
import { LangfuseClient } from "@langfuse/client";
import { langfuseEnabled, langfuseEnvironment } from "./langfuse";

const langfuseClient = langfuseEnabled ? new LangfuseClient() : undefined;

/**
 * Create a score on an existing trace (by id) and flush it. Returns whether
 * the score was sent (false when Langfuse is off or the call failed) so the
 * caller can report status. Soft-fail: never throws.
 */
export const recordScore = async (params: {
  traceId: string;
  name: string;
  value: number | string;
  dataType: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  comment?: string;
  /**
   * Stable score id → Langfuse upserts on re-submit. Pass a deterministic
   * id (e.g. `${traceId}-${name}`) so repeated user feedback updates the
   * one score instead of stacking duplicates on the trace.
   */
  id?: string;
}): Promise<boolean> => {
  if (!langfuseClient) return false;
  try {
    langfuseClient.score.create({
      ...(params.id !== undefined ? { id: params.id } : {}),
      traceId: params.traceId,
      name: params.name,
      value: params.value,
      dataType: params.dataType,
      environment: langfuseEnvironment,
      ...(params.comment !== undefined ? { comment: params.comment } : {}),
    });
    await langfuseClient.score.flush();
    return true;
  } catch (err) {
    console.warn(
      "[langfuse] recordScore failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
};
