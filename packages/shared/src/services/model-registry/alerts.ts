import { desc, inArray, isNull } from "drizzle-orm";
import db from "../../db";
import {
  type ModelAlertKind,
  type ModelAlertRow,
  modelAlerts,
} from "../../db/schema/model-registry";

/**
 * What the engine decided, in a form a person can read.
 *
 * The engine acts on its own — quarantining a corrupting upstream should not
 * wait for anyone to wake up — but "acted without asking" and "acted without
 * telling" are different things, and only the first is acceptable. Every
 * automatic decision writes a row here.
 *
 * Delivery is deliberately NOT done from this function. Alerts are raised from
 * inside streaming turns and from a nightly worker; the transactional email
 * client throws at module load without its credentials, and an SMTP round-trip
 * has no business on a token stream. A sweep in `@fretik/jobs` picks unsent
 * rows up and mails a digest, which also collapses a burst into one message.
 */

export interface RaiseAlertInput {
  kind: ModelAlertKind;
  severity?: "info" | "warning" | "critical";
  modelKey?: string;
  provider?: string;
  message: string;
  context?: Record<string, unknown>;
}

const SEVERITY_LABEL: Record<"info" | "warning" | "critical", string> = {
  info: "info",
  warning: "WARN",
  critical: "CRITICAL",
};

/**
 * Record an alert. Never throws: an alert is a side effect of a decision that
 * has already been taken, so failing to file it must not undo the decision.
 * The console line is the last-resort channel and always happens.
 */
export const raiseModelAlert = async (
  input: RaiseAlertInput,
): Promise<void> => {
  const severity = input.severity ?? "warning";
  const subject = [input.modelKey, input.provider].filter(Boolean).join("/");
  console.error(
    `[model-alert] ${SEVERITY_LABEL[severity]} ${input.kind}${subject ? ` ${subject}` : ""} — ${input.message}`,
  );
  try {
    await db.insert(modelAlerts).values({
      kind: input.kind,
      severity,
      modelKey: input.modelKey ?? null,
      provider: input.provider ?? null,
      message: input.message,
      context: input.context ?? null,
    });
  } catch (err: unknown) {
    console.error(
      "[model-alert] could not be persisted:",
      err instanceof Error ? err.message : err,
    );
  }
};

/** Alerts not yet delivered outside the database, oldest first. */
export const listUndeliveredAlerts = async (
  limit = 50,
): Promise<ModelAlertRow[]> =>
  db
    .select()
    .from(modelAlerts)
    .where(isNull(modelAlerts.notifiedAt))
    .orderBy(modelAlerts.createdAt)
    .limit(limit);

/** Mark alerts as delivered. Called by the digest sweep after a send. */
export const markAlertsDelivered = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  await db
    .update(modelAlerts)
    .set({ notifiedAt: new Date() })
    .where(inArray(modelAlerts.id, ids));
};

/** Recent alerts for the admin CLI, newest first. */
export const listRecentAlerts = async (limit = 30): Promise<ModelAlertRow[]> =>
  db
    .select()
    .from(modelAlerts)
    .orderBy(desc(modelAlerts.createdAt))
    .limit(limit);
