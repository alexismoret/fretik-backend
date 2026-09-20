import { dynamicPrefixForEventType, factsForEventType } from "./registry";
import type { FactSheet } from "./types";

/**
 * What a fact sheet looks like once it has to leave the platform.
 *
 * The trigger gate posts a sheet to a third-party decision endpoint, and a
 * sheet's best fact — `documentSummary` — is the document's content rewritten.
 * That is exactly the fact that makes "only invoices" answerable, and exactly
 * the one a team on a strict data policy cannot let out. Both are legitimate,
 * so the choice is a deployment's to make rather than the code's.
 *
 * `FACTS_ALLOW_CONTENT_EGRESS` decides it, defaulting to ALLOWED: the feature
 * is worth little without the semantic facts, and a deployment that must not
 * send them knows it and can say so. Flipping it leaves the gate working on
 * metadata alone — filename, extension, folder path, size, language, counts —
 * which still answers a great many criteria and, more importantly, degrades
 * rather than breaks.
 *
 * Read at MODULE LOAD, like the other no-deploy switches in this codebase
 * (`RECALL_MODE`, `STANDING_MODE`): it takes effect on the next restart, never
 * mid-process, so a sheet cannot be redacted halfway through a sweep.
 */
const allowContentEgress = (): boolean =>
  process.env["FACTS_ALLOW_CONTENT_EGRESS"] !== "false";

const ALLOW_CONTENT_EGRESS = allowContentEgress();

/**
 * Drop every content-bearing fact from a sheet bound for a third party.
 *
 * Both halves of the registry are honoured, and the dynamic half is the one
 * that matters: `customFields.*` holds whatever extraction pulled OUT of the
 * document — amounts, counterparties, dates — so a redaction that only swept
 * the statically declared keys would leave the most sensitive values in place
 * while reporting itself as having redacted.
 *
 * Facts are REMOVED, never blanked. A key present with `null` reads as "this
 * document has no summary", which is a different claim from "you may not see
 * it", and a decision model has no way to tell them apart.
 */
export const redactSensitiveFacts = (sheet: FactSheet): FactSheet => {
  if (ALLOW_CONTENT_EGRESS) return sheet;

  const sensitiveKeys = new Set(
    factsForEventType(sheet.eventType)
      .filter((descriptor) => descriptor.sensitive === true)
      .map((descriptor) => descriptor.key),
  );
  const dynamic = dynamicPrefixForEventType(sheet.eventType);
  const sensitivePrefix =
    dynamic?.sensitive === true ? dynamic.prefix : undefined;

  const facts: FactSheet["facts"] = {};
  for (const [key, value] of Object.entries(sheet.facts)) {
    if (sensitiveKeys.has(key)) continue;
    if (sensitivePrefix !== undefined && key.startsWith(sensitivePrefix)) {
      continue;
    }
    facts[key] = value;
  }
  return { eventType: sheet.eventType, facts };
};

/** Whether this deployment lets content-bearing facts cross a trust boundary. */
export const contentEgressAllowed = (): boolean => ALLOW_CONTENT_EGRESS;
