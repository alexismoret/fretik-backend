/**
 * How a catalogue model id becomes a registry key.
 *
 * `alibaba/qwen-3-235b` → `alibaba-qwen-3-235b`, inside the 64-char key column.
 *
 * THE COLLISION IS THE POINT, and it is why this lives in one place. A model
 * added by hand through `model-admin add` and the same model found later by the
 * nightly discovery have to land on ONE row: the second insert then hits
 * `onConflictDoNothing` and is a no-op, instead of creating a duplicate the
 * fleet would route to half the time. Two implementations that agree today can
 * disagree after one edit, and the failure — two rows for one model, each with
 * its own pool and its own quarantines — is silent.
 *
 * This existed as two byte-identical copies until 2026-08-31: `candidateKey` in
 * the sync and `slugForModelId` in the CLI, each documenting the other in a
 * comment rather than importing it.
 */
export const modelKeyForId = (modelId: string): string =>
  modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
