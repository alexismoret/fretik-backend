/**
 * PII / secret masking for Langfuse traces.
 *
 * The `LangfuseSpanProcessor` calls this on the stringified JSON of every
 * observation's input / output / metadata before export. We redact common
 * PII (emails) and secrets (cards, IBANs, JWTs, bearer tokens, API keys)
 * while leaving the rest of the business content intact — observability
 * over a B2B workspace depends on the documents/entities staying readable,
 * so this is a TARGETED redactor, not a blanket scrub.
 *
 * Replacements use no JSON-structural characters, so redacting inside the
 * serialized payload keeps it parseable.
 */
import type { MaskFunction } from "@langfuse/otel";

const REDACTIONS: { re: RegExp; to: string }[] = [
  // Auth material first (most sensitive).
  {
    re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    to: "***JWT***",
  },
  { re: /Bearer\s+[A-Za-z0-9._-]+/g, to: "Bearer ***" },
  { re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, to: "***SECRET***" },
  // Financial identifiers. The card pattern is anchored on a NON-numeric left
  // boundary: `\b` alone fires after the dot of a float, so a 16-digit mantissa
  // is redacted as a card number — measured on the recall eval, whose
  // `passFraction: 0.6666666666666666` came back `0.***CARD***` and made the
  // stored payload unparseable.
  {
    re: /(^|[^\d.])(\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4})\b/g,
    to: "$1***CARD***",
  },
  { re: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, to: "***IBAN***" },
  // Contact PII.
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: "***EMAIL***" },
];

const redact = (text: string): string => {
  let out = text;
  for (const { re, to } of REDACTIONS) {
    out = out.replace(re, to);
  }
  return out;
};

/**
 * Mask hook for the `LangfuseSpanProcessor`. `data` is the stringified
 * JSON of an observation attribute (input / output / metadata). Defensive:
 * on any non-string shape, return it untouched.
 */
export const langfuseMask: MaskFunction = ({ data }: { data: unknown }) =>
  typeof data === "string" ? redact(data) : data;
