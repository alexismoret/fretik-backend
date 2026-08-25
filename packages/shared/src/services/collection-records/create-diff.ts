/**
 * Per-field create diff for the journal: every present attribute as a
 * `null → value` transition. `domain-events/history` folds these into the
 * record's attribute timeline. Shared by `createCollectionRecord` and
 * `bulkCreateCollectionRecords` (one definition, both paths).
 */
export const buildCreateDiff = (
  data: Record<string, unknown>,
): Record<string, { from: null; to: unknown }> => {
  const diff: Record<string, { from: null; to: unknown }> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    diff[key] = { from: null, to: value };
  }
  return diff;
};
