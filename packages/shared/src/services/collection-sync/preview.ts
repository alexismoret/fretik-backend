import db from "../../db";
import type { ParamSpec } from "../../external-apps/manifest-schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import type {
  PreviewField,
  PreviewSyncSourceResponse,
  SyncArgs,
} from "../../schemas/collection-sync";
import { SYNC_LIMITS } from "../../schemas/collection-sync";
import {
  findRecordIdsByColumnValues,
  isMatchableField,
  matchKeyOf,
} from "../collection-schema/find-by-column";
import { readRecordDataBatch } from "../collection-schema/record-io";
import { resolvePageConnection } from "../external-apps/connections/resolve-for-page";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import {
  inferFieldTypeFromParamSpec,
  inferFieldTypeFromSamples,
  readPath,
} from "./project-row";
import { resolveSyncAction } from "./resolve-action";
import { resolveSyncArgs } from "./resolve-args";
import { extractRows, resolveActionPagination } from "./walk-read";

/**
 * Show a person what they are about to map, before anything is created.
 *
 * ONE upstream call, never the walker: a preview is a sample, and walking 200
 * pages of a third party so somebody can look at twenty rows is exactly the
 * kind of cost this engine exists to avoid. The bound is also what makes the
 * preview safe to re-run on every keystroke in the argument form.
 *
 * The output is a proposal, not a decision. Every field carries WHERE its type
 * came from (`declared` from the manifest's own `ParamSpec`, `inferred` from
 * the sampled values), because the UI has to be able to say so: a declared type
 * is the provider's statement about its own API and an inferred one is a guess
 * from twenty rows, and a person deciding whether to override needs to know
 * which one they are looking at. §0.9 of the plan calls the mapping UX the main
 * product risk of this whole feature, and this is the answer to it.
 */

/** Sub-paths walked into a nested object. One level, as the plan's §3.6 says:
 *  `address.city` is a column, `address.geo.lat` is a modelling problem. */
const MAX_PATH_DEPTH = 2;
/** Candidate columns proposed at most. A wider row is not a mapping problem. */
const MAX_PREVIEW_FIELDS = 200;

export const previewSyncSource = async (input: {
  teamId: string;
  userId: string | null;
  connectionId?: string;
  providerKey?: string;
  operation: string;
  args: SyncArgs;
  resultPath?: string;
  /** Resolve `{"$field"}` bindings against this record (a per-record preview). */
  sampleRecordId?: string;
  /**
   * Try the match too — all three together, or none. See
   * `countMatchedSampleRows`.
   */
  collectionId?: string;
  matchFieldKey?: string;
  externalIdPath?: string;
}): Promise<PreviewSyncSourceResponse> => {
  const resolution = await resolvePageConnection({
    teamId: input.teamId,
    userId: input.userId,
    ...(input.connectionId !== undefined
      ? { connectionId: input.connectionId }
      : {}),
    ...(input.providerKey !== undefined
      ? { providerKey: input.providerKey }
      : {}),
  });
  if (resolution.status !== "ok") {
    return throwHttpError(
      400,
      badRequest(
        resolution.status === "error"
          ? resolution.message
          : `No usable connection for this preview (${resolution.reason}). Connect the app, then try again.`,
      ),
    );
  }
  const resolved = await resolveSyncAction(
    resolution.connection,
    input.operation,
  );
  if (!resolved.ok) {
    return throwHttpError(400, badRequest(resolved.message));
  }
  const action = resolved.action;

  const fieldValues =
    input.sampleRecordId === undefined
      ? undefined
      : await readSampleRecord(input.teamId, input.sampleRecordId);

  const { args, missingFieldKeys } = resolveSyncArgs({
    args: input.args,
    // A preview is deliberately a FULL read: binding `lastSuccessAt` here would
    // show a delta of a source that has never run, which is always empty and
    // always confusing.
    since: null,
    ...(action.incremental !== undefined
      ? { incremental: action.incremental }
      : {}),
    ...(fieldValues !== undefined ? { fieldValues } : {}),
  });

  const pagination = resolveActionPagination(action);
  // Ask for a page the size of the sample when the action lets us. Some APIs
  // answer 1 000 rows to an unqualified read, and a preview that pulls them all
  // to show twenty has spent the team's quota on a form.
  const limitParam = pagination.limitParam ?? "limit";
  const capped: Record<string, unknown> =
    limitParam in action.params && args[limitParam] === undefined
      ? { ...args, [limitParam]: SYNC_LIMITS.previewRows }
      : args;

  const payload = await action.call(capped);
  const extracted = extractRows(payload, input.resultPath);
  const rows = (extracted ?? []).slice(0, SYNC_LIMITS.previewRows);

  const warning = previewWarning({
    extracted,
    resultPath: input.resultPath,
    missingFieldKeys,
    rowCount: rows.length,
  });

  const fields = proposeFields(rows, action.returnFields);
  const matched = await countMatchedSampleRows({
    teamId: input.teamId,
    rows,
    ...(input.collectionId === undefined
      ? {}
      : { collectionId: input.collectionId }),
    ...(input.matchFieldKey === undefined
      ? {}
      : { matchFieldKey: input.matchFieldKey }),
    ...(input.externalIdPath === undefined
      ? {}
      : { externalIdPath: input.externalIdPath }),
  });
  return {
    rows,
    fields,
    suggestedIdPaths: rankIdPaths(fields),
    ...(matched === undefined ? {} : { matched }),
    ...(warning !== undefined ? { warning } : {}),
    ...(action.returns !== undefined
      ? { returnsShape: Object.keys(action.returns)[0] ?? "unknown" }
      : {}),
    pagination: {
      kind: pagination.kind,
      ...(pagination.maxLimit !== undefined
        ? { maxLimit: pagination.maxLimit }
        : {}),
    },
    ...(action.batch !== undefined
      ? { batch: { maxItems: action.batch.maxItems } }
      : {}),
  };
};

/**
 * How the match would go, on the rows just read.
 *
 * ONE indexed query, over at most twenty keys — the cheapest possible answer
 * to the question that otherwise costs a source, a run, and a week of a column
 * that stays empty. A walked `columns` source with a key that does not line up
 * is not an error: it runs, succeeds, counts everything `unmatched` and fills
 * nothing. `matched: 0` here is the one moment that is obvious.
 *
 * `found` is out of the rows SAMPLED, never out of the collection. Three of
 * twenty is not a bad key — it is an app whose list is wider than the team's
 * table, which is the ordinary case. Zero is the one that means something.
 *
 * Exported for its own test: it is the only part of the preview that reads the
 * workspace rather than the app.
 */
export const countMatchedSampleRows = async (input: {
  teamId: string;
  rows: readonly Record<string, unknown>[];
  collectionId?: string;
  matchFieldKey?: string;
  externalIdPath?: string;
}): Promise<{ sampled: number; found: number } | undefined> => {
  const { collectionId, matchFieldKey, externalIdPath } = input;
  if (
    collectionId === undefined ||
    matchFieldKey === undefined ||
    externalIdPath === undefined
  ) {
    return undefined;
  }

  const fields = await getFieldDefinitionsForTeam({
    teamId: input.teamId,
    collectionId,
    includeDisabled: true,
  });
  const field = fields.find((candidate) => candidate.key === matchFieldKey);
  if (field === undefined || !isMatchableField(field)) {
    // Not a refusal: the form asks about a column the user is still choosing,
    // and "we cannot say" is a better answer than an error on a half-filled
    // form. `createSyncSource` is where an unusable column is refused by name.
    return undefined;
  }

  const keys = input.rows
    .map((row) => matchKeyOf(field, readPath(row, externalIdPath)))
    .filter((key): key is string => key !== undefined);
  if (keys.length === 0) {
    return { sampled: input.rows.length, found: 0 };
  }

  const byKey = await findRecordIdsByColumnValues({
    collectionId,
    teamId: input.teamId,
    field,
    keys,
  });
  // Counted over the ROWS, not over the distinct keys: two sampled rows sharing
  // a key are two rows that would land, and the number on screen is about the
  // rows the user is looking at.
  const found = keys.filter((key) => (byKey.get(key)?.length ?? 0) > 0).length;
  return { sampled: input.rows.length, found };
};

const readSampleRecord = async (
  teamId: string,
  recordId: string,
): Promise<Record<string, unknown> | undefined> => {
  const record = await db.query.collectionRecords.findFirst({
    where: { id: recordId, teamId },
    columns: { id: true, collectionId: true },
  });
  if (record === undefined) return undefined;
  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId,
    collectionId: record.collectionId,
  });
  const data = await readRecordDataBatch({
    collectionId: record.collectionId,
    recordIds: [record.id],
    fields: fieldDefs,
  });
  return data.get(record.id);
};

const previewWarning = (input: {
  extracted: Record<string, unknown>[] | undefined;
  resultPath: string | undefined;
  missingFieldKeys: string[];
  rowCount: number;
}): string | undefined => {
  if (input.extracted === undefined) {
    return `The path "${input.resultPath ?? ""}" found nothing in the answer. Clear it to see the answer's real shape.`;
  }
  if (input.missingFieldKeys.length > 0) {
    return `The sample record has no value for ${input.missingFieldKeys.join(", ")}, so those arguments were left out of this call.`;
  }
  if (input.rowCount === 0) {
    return "The app answered, with no rows. Check the arguments, or pick a different operation.";
  }
  return undefined;
};

/**
 * Candidate columns, one per observed path, typed from the declaration when
 * there is one and from the values when there is not.
 *
 * Driven by the SAMPLED rows rather than by the declaration, even where a
 * declaration exists: every manifest here documents a subset of what its API
 * actually returns, and a preview that showed only the declared keys would hide
 * the field a user came to map. The declaration then decides the TYPE of the
 * paths it does cover, which is the half it is reliable for.
 */
export const proposeFields = (
  rows: readonly Record<string, unknown>[],
  declared: Record<string, ParamSpec> | undefined,
): PreviewField[] => {
  const paths = collectPaths(rows);
  const fields: PreviewField[] = [];
  for (const path of paths) {
    const values = rows.map((row) => readPath(row, path));
    const spec = declaredSpec(declared, path);
    // A container is not a column — its own sub-paths are, and `collectPaths`
    // has already listed them. Declared or merely observed, the answer is the
    // same: proposing `address` as a text column of JSON beside `address.city`
    // is how a mapping screen becomes unusable.
    if (spec !== undefined ? isContainer(spec) : holdsOnlyObjects(values)) {
      continue;
    }
    const declaredType =
      spec === undefined
        ? undefined
        : inferFieldTypeFromParamSpec(spec, lastSegment(path));
    const chosen = declaredType ?? inferFieldTypeFromSamples(values);
    const sample = values.find(
      (value) => value !== null && value !== undefined && value !== "",
    );
    fields.push({
      path,
      label: humanise(path),
      type: chosen.type,
      ...(chosen.config !== undefined ? { config: chosen.config } : {}),
      origin: declaredType !== undefined ? "declared" : "inferred",
      candidateId: looksLikeKey(values, rows.length),
      ...(sample !== undefined ? { sample } : {}),
    });
  }
  return fields;
};

/** Every value present is a plain object — so the path is a branch, not a leaf. */
const holdsOnlyObjects = (values: readonly unknown[]): boolean => {
  const present = values.filter(
    (value) => value !== null && value !== undefined,
  );
  return (
    present.length > 0 &&
    present.every((value) => typeof value === "object" && !Array.isArray(value))
  );
};

const isContainer = (spec: ParamSpec): boolean =>
  spec.type === "object" ||
  (spec.type === "array" && spec.items?.type === "object");

/** Walk `a.b` through nested `fields` maps. */
const declaredSpec = (
  declared: Record<string, ParamSpec> | undefined,
  path: string,
): ParamSpec | undefined => {
  let current = declared;
  let spec: ParamSpec | undefined;
  for (const segment of path.split(".")) {
    spec = current?.[segment];
    if (spec === undefined) return undefined;
    current = spec.fields;
  }
  return spec;
};

const collectPaths = (rows: readonly Record<string, unknown>[]): string[] => {
  const paths: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, prefix: string, depth: number): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return;
    }
    for (const [key, inner] of Object.entries(value)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (!seen.has(path) && seen.size < MAX_PREVIEW_FIELDS) {
        seen.add(path);
        paths.push(path);
      }
      if (
        depth + 1 < MAX_PATH_DEPTH &&
        typeof inner === "object" &&
        inner !== null &&
        !Array.isArray(inner)
      ) {
        visit(inner, path, depth + 1);
      }
    }
  };
  for (const row of rows) visit(row, "", 0);
  return paths;
};

/**
 * Whether a path could be the upstream id: present and distinct in EVERY
 * sampled row. Both halves matter — a column that is distinct in the rows that
 * have it but empty in three of them is not a key, and picking it would make
 * every empty row collide with every other on the upsert index.
 */
const looksLikeKey = (
  values: readonly unknown[],
  rowCount: number,
): boolean => {
  if (rowCount === 0) return false;
  const present = values.filter(
    (value) =>
      (typeof value === "string" && value !== "") ||
      (typeof value === "number" && Number.isFinite(value)),
  );
  if (present.length !== rowCount) return false;
  return new Set(present.map((value) => String(value))).size === rowCount;
};

/** `id`, `*_id`, `uuid`, `ref`, `number` first — the names an id actually has. */
const ID_NAME_RANK: [RegExp, number][] = [
  [/^id$/i, 0],
  [/(^|[._])uuid$/i, 1],
  [/(^|[._])id$/i, 2],
  [/(^|[._])(ref|reference)$/i, 3],
  [/(^|[._])(number|no|code|key)$/i, 4],
];

export const rankIdPaths = (fields: readonly PreviewField[]): string[] =>
  fields
    .filter((field) => field.candidateId)
    .map((field) => ({ path: field.path, rank: idNameRank(field.path) }))
    .sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path))
    .map((entry) => entry.path);

const idNameRank = (path: string): number =>
  ID_NAME_RANK.find(([pattern]) => pattern.test(path))?.[1] ?? 9;

const lastSegment = (path: string): string =>
  path.slice(path.lastIndexOf(".") + 1);

/** `givenName` / `given_name` / `a.b` → `Given name` / `A b`. */
const humanise = (path: string): string => {
  const words = path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.length === 0
    ? path
    : words.charAt(0).toUpperCase() + words.slice(1);
};
