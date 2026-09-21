import type { BulkOperationKind } from "../../db/schema";
import { recordDeleteExecutor } from "./executors/record-delete";
import { recordImportExecutor } from "./executors/record-import";
import { recordUpdateExecutor } from "./executors/record-update";
import type { BulkOperationExecutor } from "./types";

/**
 * The executor registry — the single place bulk-operation kinds are
 * enumerated. Add a kind = add a module and one line, exactly like
 * `APPROVAL_KIND_HANDLERS`.
 */
export const BULK_OPERATION_EXECUTORS: Record<
  BulkOperationKind,
  BulkOperationExecutor
> = {
  record_import: recordImportExecutor,
  record_update: recordUpdateExecutor,
  record_delete: recordDeleteExecutor,
};
