import db from "../../db";
import type { DomainEvent } from "../../db/schema";
import { readRecordData } from "../collection-schema/record-io";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { emptyFactSheet, type FactSheet, type FactValue } from "./types";

/**
 * Facts about the record an event happened to.
 *
 * The subject is read off `subjectRecordId` rather than the payload: every
 * `record.*` emitter stamps it (it is what the event↔record provenance graph
 * hangs on), while the payload carries only the `diff`. One shape to read, and
 * it is the one the journal itself indexes.
 *
 * `changedFields` comes from that diff and is the fact a criterion about an
 * UPDATE needs — "when the status field changes" is unanswerable from the
 * record's current row alone, since the row looks identical whichever field
 * moved.
 */

const asFactValue = (value: unknown): FactValue | undefined => {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === "string");
    return items.length === value.length ? items : undefined;
  }
  return undefined;
};

/**
 * The field keys a `record.updated` diff touched.
 *
 * The diff is a jsonb the emitters build themselves, so this reads it
 * defensively: an object's keys are the changed fields, anything else means a
 * shape this resolver does not know and the honest answer is "no idea which",
 * not a guess.
 */
const changedFieldsOf = (payload: Record<string, unknown>): string[] => {
  const diff = payload["diff"];
  if (typeof diff !== "object" || diff === null || Array.isArray(diff)) {
    return [];
  }
  return Object.keys(diff);
};

export const resolveRecordFacts = async (
  event: DomainEvent,
): Promise<FactSheet> => {
  if (event.subjectRecordId === null) return emptyFactSheet(event.type);

  const record = await db.query.collectionRecords.findFirst({
    where: { id: event.subjectRecordId, teamId: event.teamId },
    columns: {
      id: true,
      collectionId: true,
      label: true,
      status: true,
      source: true,
    },
    with: { collection: { columns: { key: true, label: true } } },
  });
  // A `record.deleted` event has no row left to describe — by design, not by
  // accident. The identity still travels, so a criterion can match on it.
  if (!record) {
    return {
      eventType: event.type,
      facts: {
        recordId: event.subjectRecordId,
        collectionKey: null,
        collectionName: null,
        label: null,
        status: null,
        source: null,
        changedFields: changedFieldsOf(event.payload),
      },
    };
  }

  const facts: Record<string, FactValue> = {
    recordId: record.id,
    collectionKey: record.collection?.key ?? null,
    collectionName: record.collection?.label ?? null,
    label: record.label,
    status: record.status,
    source: record.source,
    changedFields: changedFieldsOf(event.payload),
  };

  try {
    const fields = await getFieldDefinitionsForTeam({
      teamId: event.teamId,
      collectionId: record.collectionId,
    });
    const data = await readRecordData({
      collectionId: record.collectionId,
      recordId: record.id,
      fields,
    });
    for (const [key, raw] of Object.entries(data)) {
      const value = asFactValue(raw);
      if (value !== undefined) facts[`fields.${key}`] = value;
    }
  } catch (error) {
    console.warn(
      `[facts.record] field values unavailable for ${record.id}:`,
      error instanceof Error ? error.message : error,
    );
  }

  return { eventType: event.type, facts };
};
