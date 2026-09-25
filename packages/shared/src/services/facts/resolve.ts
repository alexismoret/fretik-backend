import type { DomainEvent } from "../../db/schema";
import { resolveConnectorFacts } from "./connector";
import { resolveDocumentFacts } from "./document";
import { resolveFolderFacts } from "./folder";
import { resolveLinkFacts } from "./link";
import { resolveRecordFacts } from "./record";
import { factFamilyOf } from "./registry";
import { emptyFactSheet, type FactSheet } from "./types";

/**
 * The one entry point: an event in, everything knowable about its subject out.
 *
 * NEVER THROWS. This sits in front of the trigger gate, and the gate's whole
 * safety argument is that it falls open — a resolver that threw would take the
 * gate down with it and stop workflows from firing, which is the one failure
 * mode the design refuses. A resolver that cannot answer returns an empty
 * sheet, a gate reading an empty sheet decides nothing, and the launch
 * proceeds exactly as it does today.
 *
 * The dispatch is by FAMILY (`document.*` → the document resolver), so a new
 * event type on an existing subject — `document.archived`, say — resolves the
 * full sheet the day it is emitted, with nothing added here.
 */
export const resolveFactSheet = async (
  event: DomainEvent,
): Promise<FactSheet> => {
  try {
    switch (factFamilyOf(event.type)) {
      case "document":
        return await resolveDocumentFacts(event);
      case "record":
        return await resolveRecordFacts(event);
      case "link":
        return await resolveLinkFacts(event);
      case "folder":
        return await resolveFolderFacts(event);
      case "connector":
        return resolveConnectorFacts(event);
      case null:
        return emptyFactSheet(event.type);
    }
  } catch (error) {
    console.warn(
      `[facts] resolver failed for ${event.type} (${event.id}):`,
      error instanceof Error ? error.message : error,
    );
    return emptyFactSheet(event.type);
  }
};

/**
 * Resolve several events' sheets at once, in bounded parallel.
 *
 * The gate resolves one sheet per swept event, and a sweep batch is up to 500.
 * Firing 500 concurrent resolvers would open 1 500 connections against a pool
 * that serves the whole worker; doing them one after another would make the
 * gate the slowest thing in the sweep. Neither is necessary — the reads are
 * small and indexed, so a modest window saturates the pool's useful
 * concurrency and nothing more.
 */
const RESOLVE_CONCURRENCY = 8;

export const resolveFactSheets = async (
  events: readonly DomainEvent[],
): Promise<Map<string, FactSheet>> => {
  const sheets = new Map<string, FactSheet>();
  for (let i = 0; i < events.length; i += RESOLVE_CONCURRENCY) {
    const window = events.slice(i, i + RESOLVE_CONCURRENCY);
    const resolved = await Promise.all(
      window.map(
        async (event) => [event.id, await resolveFactSheet(event)] as const,
      ),
    );
    for (const [id, sheet] of resolved) sheets.set(id, sheet);
  }
  return sheets;
};
