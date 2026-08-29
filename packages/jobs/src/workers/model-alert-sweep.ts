import { sendEmail } from "@fretik/shared/lib/email";
import {
  listUndeliveredAlerts,
  markAlertsDelivered,
} from "@fretik/shared/services/model-registry/alerts";
import { buildAlertDigest } from "./model-alert-digest";

/**
 * Delivery for what the model engine decided on its own.
 *
 * The engine quarantines a corrupting upstream and disables a model that fails
 * policy twice without asking anyone, and each decision writes a `model_alerts`
 * row. Delivery is deliberately NOT done at the raise site: those decisions are
 * taken inside streaming turns, and an SMTP round trip has no business on a
 * token stream. This sweep is the other half of that trade — without it, "acted
 * without asking" quietly becomes "acted without telling".
 *
 * The email client is imported statically here, and it throws at module load
 * without its five Scaleway variables. That is not a new constraint on this
 * process: `maintenance.ts` already pulls it in through `markStalledRuns` →
 * `send-run-completion-email`, which is why `packages/jobs/.env` carries them.
 * What must not depend on them is the unit suite, so the part worth testing —
 * `buildAlertDigest` — lives in a sibling file that imports nothing at runtime.
 */

/**
 * How many alerts one digest may carry. A burst bigger than this is a burst
 * whose first fifty lines already say what happened; the rest go out five
 * minutes later, still in one message.
 */
const BATCH = 50;

/**
 * Where the digest goes. Unset is a supported configuration (a dev machine, a
 * replica that mails nothing), handled below — not a reason to leave rows
 * undelivered forever.
 */
const recipient = (): string | undefined => {
  const raw = process.env.OPS_ALERT_EMAIL?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
};

export const runModelAlertSweep = async (): Promise<{ delivered: number }> => {
  const alerts = await listUndeliveredAlerts(BATCH);
  // Silent on a clean pass, so a log line IS the signal — same discipline as
  // the vector-reconcile and collection-index sweeps.
  if (alerts.length === 0) return { delivered: 0 };

  const digest = buildAlertDigest(alerts);
  const to = recipient();

  if (to === undefined) {
    // No mailbox configured, so the console IS the delivery channel — and
    // having been printed in full, the rows are delivered. Leaving them unsent
    // would re-print the same digest every five minutes forever, and a row
    // nobody will ever look at again is worse than a log line.
    console.error(`[model-alert-sweep] OPS_ALERT_EMAIL unset — ${digest.text}`);
    await markAlertsDelivered(alerts.map((alert) => alert.id));
    return { delivered: alerts.length };
  }

  try {
    await sendEmail({
      to: { email: to },
      subject: digest.subject,
      html: digest.html,
      text: digest.text,
    });
  } catch (err: unknown) {
    // Marking only after a confirmed send is what makes the retry free: the
    // rows stay undelivered and the next sweep, five minutes out, rebuilds the
    // same digest plus whatever arrived since. Swallowed rather than rethrown —
    // a failed send must not fail the maintenance job it shares a worker with.
    console.error(
      "[model-alert-sweep] send failed, alerts left undelivered:",
      err instanceof Error ? err.message : err,
    );
    return { delivered: 0 };
  }

  await markAlertsDelivered(alerts.map((alert) => alert.id));
  return { delivered: alerts.length };
};
