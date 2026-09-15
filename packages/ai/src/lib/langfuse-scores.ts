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
import { langfuseClient, langfuseEnvironment } from "./langfuse";

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

/**
 * Put SEVERAL numeric scores on one trace, in one flush.
 *
 * `recordScore` flushes per call, which is right for a thumb and wrong for a
 * set of counters published together at the end of a turn — six calls would be
 * six round trips on the turn's critical path. Ids are derived from
 * `${traceId}-${name}`, so a retried turn upserts its numbers instead of
 * stacking a second set on the same trace.
 *
 * Soft-fail, like its sibling: a measurement that can break a turn is not
 * worth having.
 */
export const recordScores = async (params: {
  traceId: string;
  scores: readonly { name: string; value: number; comment?: string }[];
}): Promise<boolean> => {
  if (!langfuseClient || params.scores.length === 0) return false;
  try {
    for (const score of params.scores) {
      langfuseClient.score.create({
        id: `${params.traceId}-${score.name}`,
        traceId: params.traceId,
        name: score.name,
        value: score.value,
        dataType: "NUMERIC",
        environment: langfuseEnvironment,
        ...(score.comment !== undefined ? { comment: score.comment } : {}),
      });
    }
    await langfuseClient.score.flush();
    return true;
  } catch (err) {
    console.warn(
      "[langfuse] recordScores failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
};

/**
 * Delete a score by its (stable) id — used to REMOVE user feedback when the
 * user toggles a thumb off. Deletion lives on the legacy v1 scores endpoint;
 * the id is the same one `recordScore` upserts (`${traceId}-${name}`). Returns
 * whether the delete was sent. Soft-fail: never throws.
 */
export const deleteScore = async (id: string): Promise<boolean> => {
  if (!langfuseClient) return false;
  try {
    await langfuseClient.api.legacy.scoreV1.delete(id);
    return true;
  } catch (err) {
    console.warn(
      "[langfuse] deleteScore failed:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
};
