import type { ModelAlertRow } from "@fretik/shared/db/schema";

/**
 * The digest an operator actually reads, built from rows and nothing else.
 *
 * Separate from the sweep on purpose. The sweep imports `@fretik/shared/lib/email`,
 * which THROWS AT MODULE LOAD without its five Scaleway variables (a deliberate
 * fail-fast: a replica with no mail credentials must not boot and discover it
 * at the first send). Everything worth testing about a digest — ordering,
 * counts, escaping — is a pure function of the rows, so it lives here, in a
 * file whose only import is a type and is therefore erased at runtime. The unit
 * suite loads this and never reaches the mail client, the database, or Redis.
 */

export interface AlertDigest {
  subject: string;
  text: string;
  html: string;
}

/**
 * Worst first. An operator reading on a phone at 02:00 sees the quarantine
 * before the twelve `new-candidate` lines that a catalogue refresh produced in
 * the same five minutes.
 */
const SEVERITY_ORDER = ["critical", "warning", "info"] as const;

const SEVERITY_HEADING: Record<(typeof SEVERITY_ORDER)[number], string> = {
  critical: "CRITICAL",
  warning: "Warning",
  info: "Info",
};

/**
 * Alert messages are free text carrying model ids and provider slugs —
 * `anthropic/claude-sonnet-4.5`, `a<b`, `AT&T`. They are not authored as HTML
 * and must never be read as HTML. `&` first: escaping it after the others would
 * re-escape the ampersands they just introduced.
 */
const escapeHtml = (raw: string): string =>
  raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** `kind model/provider — message`, with the parts that exist. */
const alertLine = (alert: ModelAlertRow): string => {
  const subject = [alert.modelKey, alert.provider].filter(Boolean).join("/");
  return `${alert.kind}${subject === "" ? "" : ` ${subject}`} — ${alert.message}`;
};

/**
 * One digest for the whole batch — never one email per alert. A provider
 * meltdown raises an alert per affected model within seconds of itself, and an
 * inbox holding forty of them is an inbox nobody finishes reading.
 *
 * Total by design, empty input included: the sweep returns before calling it,
 * but a builder that throws on the boundary case is a builder that cannot be
 * tested at the boundary.
 */
export const buildAlertDigest = (
  alerts: readonly ModelAlertRow[],
): AlertDigest => {
  const criticals = alerts.filter(
    (alert) => alert.severity === "critical",
  ).length;
  const subject = `[Fretik] ${alerts.length.toString()} model alert${alerts.length === 1 ? "" : "s"} (${criticals.toString()} critical)`;

  const textBlocks: string[] = [];
  const htmlBlocks: string[] = [];

  for (const severity of SEVERITY_ORDER) {
    const group = alerts.filter((alert) => alert.severity === severity);
    if (group.length === 0) continue;
    const heading = `${SEVERITY_HEADING[severity]} (${group.length.toString()})`;
    textBlocks.push(
      `${heading}\n${group.map((alert) => `  - ${alertLine(alert)}`).join("\n")}`,
    );
    htmlBlocks.push(
      `<h3>${escapeHtml(heading)}</h3>\n<ul>\n${group
        .map((alert) => `<li>${escapeHtml(alertLine(alert))}</li>`)
        .join("\n")}\n</ul>`,
    );
  }

  return {
    subject,
    text: `${subject}\n\n${textBlocks.join("\n\n")}`.trimEnd(),
    html: `<h2>${escapeHtml(subject)}</h2>\n${htmlBlocks.join("\n")}`.trimEnd(),
  };
};
