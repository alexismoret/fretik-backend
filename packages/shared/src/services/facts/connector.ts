import type { DomainEvent } from "../../db/schema";
import type { FactSheet, FactValue } from "./types";

/**
 * Facts about an external app's event.
 *
 * NO database read, and that is the design rather than a shortcut. A
 * connector event is minted at runtime as `connector.<provider>.<kind>` and
 * everything known about it arrived on the payload — there is no local table
 * holding a Gmail message or a Planner task to join against. The provider's
 * shape is the provider's, so the payload is flattened one level under
 * `payload.` and handed on as-is.
 *
 * One level, not a deep walk: a criterion reads a value, and a flattener that
 * descends arbitrarily turns one nested object into fifty keys nobody declared
 * and an egress surface nobody reviewed. Anything deeper is dropped, and the
 * connector that needs it flattens it into its own event payload where the
 * shape is understood.
 */
const asFactValue = (value: unknown): FactValue | undefined => {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === "string");
    return items.length === value.length ? items : undefined;
  }
  return undefined;
};

export const resolveConnectorFacts = (event: DomainEvent): FactSheet => {
  // `connector.<provider>.<kind>` — the provider is one segment, the kind is
  // whatever remains, since a provider may well mint `a.b.c`.
  const [, providerKey, ...kindParts] = event.type.split(".");
  const facts: Record<string, FactValue> = {
    providerKey: providerKey ?? null,
    eventKind: kindParts.length > 0 ? kindParts.join(".") : null,
  };
  for (const [key, raw] of Object.entries(event.payload)) {
    const value = asFactValue(raw);
    if (value !== undefined) facts[`payload.${key}`] = value;
  }
  return { eventType: event.type, facts };
};
