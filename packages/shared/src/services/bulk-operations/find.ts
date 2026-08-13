import db from "../../db";
import type { BulkOperation } from "../../db/schema";

/**
 * Reads that must stay import-light.
 *
 * `commit.ts` pulls in the approval gate, and the gate resolves its kind
 * handlers — one of which needs to find the operation behind an approval. Left
 * in `commit.ts` that would close an import cycle whose only symptom is a
 * module-initialisation error at boot, so these live alone here.
 */

/** The operation an approval gates, if any. */
export const findOperationForApproval = async (
  approvalId: string,
): Promise<BulkOperation | undefined> =>
  db.query.bulkOperations.findFirst({ where: { approvalId } });

export const findBulkOperation = async (
  id: string,
): Promise<BulkOperation | undefined> =>
  db.query.bulkOperations.findFirst({ where: { id } });
