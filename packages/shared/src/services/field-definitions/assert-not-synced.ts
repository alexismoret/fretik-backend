import type { FieldDefinition } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import { loadSyncProvenance } from "../collections/sync-provenance";

/**
 * Refuse to drop, retype or re-KEY a column a connected app fills.
 *
 * Three ways to break the same binding, none of which reports an error when it
 * happens:
 *
 *  - `delete` leaves the source's field mapping naming a column that is gone;
 *  - `changeType` RESETS every stored value, then the column stops accepting
 *    what the app sends;
 *  - `renameKey` is the quiet one. A mapping entry is `{path, fieldKey}` and
 *    `ownedFields` matches it against `field.key`, so a renamed key simply
 *    stops matching: the source keeps running, keeps reporting `success`, and
 *    silently never fills that column again.
 *
 * Renaming the LABEL, describing and hiding stay allowed — they change how the
 * column reads, never what binds it, and the UI has always offered them.
 *
 * This lived only in the `manageField` tool, and only for the first two. The
 * tool is one of three doors: the HTTP API and any internal caller reached
 * these services with no guard at all, so the rule the agent was told about
 * did not exist for the screen or the endpoint. A rule enforced on one door is
 * enforced on none.
 *
 * The way out is named because it is the one people actually want: detaching
 * the column, or deleting the SOURCE, keeps every stored value and hands the
 * column back as an ordinary editable one.
 */
export const assertFieldNotSynced = async (
  field: Pick<FieldDefinition, "key" | "syncSourceId">,
  action: "delete" | "changeType" | "renameKey",
): Promise<void> => {
  if (field.syncSourceId === null) return;

  // The name is for the message only, so a provenance read that comes back
  // empty (a source deleted in the same breath) must not turn a clear refusal
  // into a crash.
  const source = (await loadSyncProvenance([field.syncSourceId])).get(
    field.syncSourceId,
  );
  const app = source === undefined ? "a connected app" : source.app;
  const via = source === undefined ? "" : ` (${source.operation})`;
  const verb =
    action === "delete"
      ? "deleted"
      : action === "changeType"
        ? "retyped"
        : "given another key";

  return throwHttpError(
    400,
    badRequest(
      `'${field.key}' is filled by ${app}${via}, so it cannot be ${verb} here. Detach the column from its sync source first, or delete the source. The data stays and the column becomes editable.${action === "renameKey" ? " Its label can be changed either way." : ""}`,
    ),
  );
};
