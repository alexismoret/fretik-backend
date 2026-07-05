import db from "../../db";
import type { RecordVectorMetadata } from "../../db/schema/ai-vectors";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { readRecordData } from "../object-schema/record-io";

/**
 * Card size guard: one card = ONE vectorize chunk (the chunker window is
 * ~2000 chars), so semantic record search costs exactly one ai_vectors row
 * per record. Field values are clipped rather than dropped.
 */
const MAX_CARD_CHARS = 1_800;
const MAX_FIELD_VALUE_CHARS = 200;

export interface RecordCard {
  content: string;
  metadata: RecordVectorMetadata;
  teamId: string;
  organizationId: string;
}

const isScalarish = (
  v: unknown,
): v is string | number | boolean | (string | number)[] =>
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean" ||
  (Array.isArray(v) &&
    v.every((x) => typeof x === "string" || typeof x === "number"));

const renderValue = (
  v: string | number | boolean | (string | number)[],
): string =>
  (Array.isArray(v) ? v.join(", ") : String(v)).slice(0, MAX_FIELD_VALUE_CHARS);

/**
 * Build the semantic "card" of one CONFIRMED record — label + aliases + type
 * + its `vectorizeInclude` field values — the content indexed into
 * `ai_vectors` as `source_type='records'`. Returns null for missing,
 * non-confirmed, or document-mirror records (documents are already indexed
 * as `source_type='documents'` with their full content; a card would only
 * duplicate them in every hybrid sweep).
 */
export const buildRecordCard = async (
  recordId: string,
): Promise<RecordCard | null> => {
  const record = await db.query.objectRecords.findFirst({
    where: { id: recordId },
    with: { objectType: true },
  });
  if (!record || !record.objectType || record.status !== "confirmed") {
    return null;
  }
  if (record.documentId) return null;
  const objectType = record.objectType;

  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: record.teamId,
    objectTypeId: record.objectTypeId,
  });
  const data = await readRecordData({
    objectTypeId: record.objectTypeId,
    recordId: record.id,
    fields: fieldDefs,
  });

  const lines: string[] = [
    `${objectType.label}: ${record.label}`,
    ...(record.aliases && record.aliases.length > 0
      ? [`Aliases: ${record.aliases.join(", ")}`]
      : []),
  ];
  for (const def of fieldDefs) {
    if (!def.vectorizeInclude || !def.enabled || def.isTitle) continue;
    const value = data[def.key];
    if (value == null || value === "") continue;
    if (!isScalarish(value)) continue;
    const line = `${def.label}: ${renderValue(value)}`;
    if (lines.join("\n").length + line.length > MAX_CARD_CHARS) break;
    lines.push(line);
  }

  return {
    content: lines.join("\n"),
    metadata: {
      object_type_id: record.objectTypeId,
      object_type_key: objectType.key,
      label: record.label,
    },
    teamId: record.teamId,
    organizationId: record.organizationId,
  };
};
