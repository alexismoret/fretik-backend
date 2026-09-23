import db from "../db";
import * as schema from "../db/schema";

/**
 * Best-effort write to the auth security audit trail. Never throws into the
 * auth hot path — a failed audit insert is logged and swallowed.
 */
export const recordAuthEvent = async (
  event: string,
  userId: string | null,
  details?: {
    ip?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> => {
  try {
    await db.insert(schema.authAuditLog).values({
      event,
      userId,
      ip: details?.ip ?? null,
      userAgent: details?.userAgent ?? null,
      metadata: details?.metadata ?? null,
    });
  } catch (err) {
    console.warn(`[auth-audit] failed to record ${event}:`, err);
  }
};
