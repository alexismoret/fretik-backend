import { HTTPException } from "hono/http-exception";
import db from "../../db";
import { MAX_BULK_ITEMS } from "../../lib/db-bulk";
import type {
  PageOperation,
  PageRunResponse,
  PageValue,
} from "../../schemas/pages";
import { isPageVarRef } from "../../schemas/pages";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { createLink } from "../links/create";
import { invalidateLink } from "../links/invalidate";
import { bulkDeleteObjectRecords } from "../object-records/bulk-delete";
import { bulkUpdateObjectRecords } from "../object-records/bulk-update";
import { createObjectRecord } from "../object-records/create";
// The `{ var }` template resolver. It lives next to the external dataset
// because that is where it was first needed, not because it is external-only:
// an operation's `args` is the same template with the same rules.
import { resolveExternalArgs } from "./sources/external";

/**
 * The WRITE half of a page, over the team's OWN records.
 *
 * Until 2026-08-17 a page could call out to a connected third party and could
 * not touch a single row of the workspace it was drawn over. Every "the control
 * does nothing" defect traced back to that: the shipped kanban pattern told the
 * agent to run `set_stage` over a `records` dataset, and no operation kind could
 * execute it.
 *
 * THREE THINGS ARE THE SECURITY BOUNDARY, and none of them is the client's:
 *
 *  1. The TARGET comes from the stored definition — `objectTypeId`, `fieldKey`,
 *     and the `args` template. A browser sends an operation id and values for
 *     declared variables, exactly as it does for a dataset filter.
 *  2. The WRITABLE FIELDS are exactly the keys of `args`. A value the template
 *     never names cannot reach the row, whatever the viewer sends.
 *  3. Every id is re-read here and matched against BOTH the declared type and
 *     the owning team before anything is written. The bulk services enforce
 *     team ownership themselves, but not that a row is of the type the page
 *     declared — so a page declaring type A with a `{ var }` id could otherwise
 *     be handed an id of type B and write A's arguments onto it.
 *
 * Writes go through the BULK services even for one row. They enforce tenancy,
 * chunk, and report per-id — one path instead of two, so the single-row case
 * cannot drift from the batch one.
 */

/** A destructive write is bounded by the same ceiling as every other bulk write
 * in the codebase — `lib/db-bulk` owns that number, this file does not. */
const BULK_CEILING = MAX_BULK_ITEMS;

/**
 * What a failed write says to the person who clicked.
 *
 * `throwHttpError` encodes its payload as JSON in the exception message, so the
 * raw string reaching a toast is `{"code":"BAD_REQUEST","message":"…"}`. A form
 * that omits a required field would show that, or worse "the action failed" —
 * which is the exact class of defect this whole write path exists to remove.
 *
 * RULE: an error crossing back to a user names what to change, or it is noise.
 */
const describeWriteError = (cause: unknown): string => {
  const raw =
    cause instanceof HTTPException || cause instanceof Error
      ? cause.message
      : "the write failed";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const message: unknown = Reflect.get(parsed, "message");
      const details: unknown = Reflect.get(parsed, "details");
      const detail: unknown = Array.isArray(details)
        ? details.join("; ")
        : details;
      const head = typeof message === "string" ? message : "the write failed";
      return typeof detail === "string" && detail.length > 0
        ? `${head}: ${detail}`
        : head;
    }
  } catch {
    // Not a JSON payload — it is already a sentence.
  }
  return raw;
};

/** A literal id, or the `{ var }` the viewer filled in. Anything else is
 * dropped rather than coerced: an id is not a place to be lenient. */
const resolveId = (
  value: PageValue | undefined,
  state: Record<string, PageValue>,
): string | null => {
  const raw = isPageVarRef(value) ? state[value.var] : value;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
};

const resolveIds = (
  value: PageValue | undefined,
  state: Record<string, PageValue>,
): string[] => {
  const raw = isPageVarRef(value) ? state[value.var] : value;
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter((entry): entry is string => typeof entry === "string"),
    ),
  ];
};

/**
 * The ids that exist, are of the declared type, AND belong to this team.
 *
 * The whole check, in one query. Anything missing from the answer is refused by
 * name rather than silently skipped — a page that updates four of five selected
 * rows and says "done" is worse than one that says which row it could not
 * touch.
 */
const ownedRecordIds = async (params: {
  teamId: string;
  objectTypeId: string;
  ids: string[];
}): Promise<Set<string>> => {
  if (params.ids.length === 0) return new Set();
  const rows = await db.query.objectRecords.findMany({
    columns: { id: true },
    where: {
      id: { in: params.ids },
      objectTypeId: params.objectTypeId,
      teamId: params.teamId,
    },
  });
  return new Set(rows.map((row) => row.id));
};

/**
 * `args` keys the record shape would silently drop.
 *
 * Kept in lockstep with `buildRecordShape`'s skip list and with
 * `field-descriptors`' `writable` flag: a relation is an edge (a `link`
 * operation moves it), rollups and the system properties are computed on read,
 * and `unique_id` comes from its sequence. An unknown key is left alone — the
 * validator names that one itself.
 */
const UNWRITABLE_FIELD_TYPES: ReadonlySet<string> = new Set([
  "relation",
  "rollup",
  "unique_id",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
]);

const unwritableArgKeys = async (params: {
  teamId: string;
  objectTypeId: string;
  keys: string[];
}): Promise<string[]> => {
  if (params.keys.length === 0) return [];
  const fields = await getFieldDefinitionsForTeam({
    teamId: params.teamId,
    objectTypeId: params.objectTypeId,
  });
  const typeByKey = new Map(fields.map((field) => [field.key, field.type]));
  return params.keys.filter((key) => {
    const type = typeByKey.get(key);
    return type !== undefined && UNWRITABLE_FIELD_TYPES.has(type);
  });
};

/** The declared type, only if this team owns it. Writes are owner-team only —
 * stricter than the read scope, which also honours cross-team grants. */
const ownsObjectType = async (params: {
  teamId: string;
  objectTypeId: string;
}): Promise<boolean> => {
  const row = await db.query.objectTypes.findFirst({
    columns: { id: true },
    where: { id: params.objectTypeId, teamId: params.teamId },
  });
  return row !== undefined;
};

/**
 * The link type a `relation` field is backed by — LOOKED UP, never created.
 *
 * `resolveLinkType` would create one on a miss, which is right at field-design
 * time and wrong here: a page click must not extend the team's graph schema.
 */
const relationLinkTypeId = async (params: {
  organizationId: string;
  teamId: string;
  objectTypeId: string;
  fieldKey: string;
}): Promise<{ ok: true; id: string } | { ok: false; message: string }> => {
  const fields = await getFieldDefinitionsForTeam({
    teamId: params.teamId,
    objectTypeId: params.objectTypeId,
  });
  const field = fields.find((candidate) => candidate.key === params.fieldKey);
  if (!field || field.type !== "relation") {
    return {
      ok: false,
      message: `"${params.fieldKey}" is not a relation field on this object type — only a relation has edges to move.`,
    };
  }
  const linkTypeKey =
    "linkTypeKey" in field.config &&
    typeof field.config.linkTypeKey === "string"
      ? field.config.linkTypeKey
      : null;
  if (!linkTypeKey) {
    return {
      ok: false,
      message: `relation field "${params.fieldKey}" has no link type bound yet — open it once in the objects UI, or re-save the field definition.`,
    };
  }
  // Team's own link type first, then the org-level one — the same double-arm
  // scope `resolveLinkType` matches within, minus its create-on-miss fallback.
  const row = await db.query.linkTypes.findFirst({
    columns: { id: true },
    where: {
      normalizedKey: linkTypeKey,
      fromObjectTypeId: params.objectTypeId,
      OR: [
        { teamId: params.teamId },
        { teamId: { isNull: true }, organizationId: params.organizationId },
      ],
    },
  });
  const id = row?.id;
  return id
    ? { ok: true, id }
    : {
        ok: false,
        message: `relation field "${params.fieldKey}" points at link type "${linkTypeKey}", which this team does not have.`,
      };
};

/** Per-id failures, folded into one sentence a toast can carry. */
const summariseErrors = (
  errors: { id: string; error: string }[],
): string | null => {
  if (errors.length === 0) return null;
  const [first] = errors;
  if (!first) return null;
  return errors.length === 1
    ? `${first.id}: ${first.error}`
    : `${errors.length.toString()} records failed — ${first.id}: ${first.error}`;
};

export const runPageRecordOperation = async (params: {
  operation: Extract<PageOperation, { kind: "record" | "bulk" | "link" }>;
  organizationId: string;
  teamId: string;
  userId: string;
  state: Record<string, PageValue>;
}): Promise<PageRunResponse> => {
  const { operation, organizationId, teamId, userId, state } = params;
  // A page click is a USER write, not an agent one — the journal has to say so,
  // because "who changed this status" is the first question asked of a board.
  const actor = { actorType: "user" as const, actorUserId: userId };

  if (operation.kind === "link") {
    const linkType = await relationLinkTypeId({
      organizationId,
      teamId,
      objectTypeId: operation.objectTypeId,
      fieldKey: operation.fieldKey,
    });
    if (!linkType.ok) return { status: "error", message: linkType.message };

    const fromId = resolveId(operation.fromRecordId, state);
    const toId = resolveId(operation.toRecordId, state);
    if (!fromId || !toId) {
      return {
        status: "error",
        message: `operation "${operation.id}": both ends of a link must resolve to a record id.`,
      };
    }
    const owned = await ownedRecordIds({
      teamId,
      objectTypeId: operation.objectTypeId,
      ids: [fromId],
    });
    if (!owned.has(fromId)) {
      return {
        status: "error",
        message: `record "${fromId}" is not a record of this page's object type in your team.`,
      };
    }

    try {
      if (operation.mode === "unlink") {
        const edge = await db.query.links.findFirst({
          columns: { id: true },
          where: {
            linkTypeId: linkType.id,
            fromRecordId: fromId,
            toRecordId: toId,
            validTo: { isNull: true },
            invalidatedAt: { isNull: true },
          },
        });
        if (!edge) return { status: "ok", result: { unlinked: 0 } };
        await invalidateLink({ id: edge.id, actor });
        return { status: "ok", result: { unlinked: 1 } };
      }

      // Cardinality `one` REPLACES. Without this, "assign an owner" quietly
      // accumulates owners: the edge is idempotent per pair, so a second
      // assignment adds a second active edge instead of moving the first, and
      // the relation renders two chips where the UI offers one picker.
      const fields = await getFieldDefinitionsForTeam({
        teamId,
        objectTypeId: operation.objectTypeId,
      });
      const field = fields.find(
        (candidate) => candidate.key === operation.fieldKey,
      );
      const single =
        field !== undefined &&
        "cardinality" in field.config &&
        field.config.cardinality === "one";
      if (single) {
        const existing = await db.query.links.findMany({
          columns: { id: true },
          where: {
            linkTypeId: linkType.id,
            fromRecordId: fromId,
            validTo: { isNull: true },
            invalidatedAt: { isNull: true },
          },
        });
        await Promise.all(
          existing.map(async (edge) => invalidateLink({ id: edge.id, actor })),
        );
      }
      await createLink({
        organizationId,
        teamId,
        linkTypeId: linkType.id,
        fromRecordId: fromId,
        toRecordId: toId,
        source: "user_manual",
        actor,
      });
      return { status: "ok", result: { linked: 1 } };
    } catch (cause) {
      return { status: "error", message: describeWriteError(cause) };
    }
  }

  if (
    !(await ownsObjectType({ teamId, objectTypeId: operation.objectTypeId }))
  ) {
    return {
      status: "error",
      message: `this page writes to an object type your team does not own.`,
    };
  }

  // The writable allowlist: whatever the stored template names, and nothing
  // else. `resolveExternalArgs` drops a binding that resolves to nothing rather
  // than writing null over a value the viewer never touched.
  const resolvedArgs = resolveExternalArgs(operation.args ?? {}, state);
  if (!resolvedArgs.ok) {
    return { status: "error", message: resolvedArgs.error };
  }
  const data = resolvedArgs.args;

  // A key the record shape cannot write is STRIPPED, not refused — so a button
  // bound to a relation or a rollup saves cleanly, toasts success, and changes
  // nothing. Naming it here is the difference between a bug that hides and one
  // that gets fixed.
  const unwritable = await unwritableArgKeys({
    teamId,
    objectTypeId: operation.objectTypeId,
    keys: Object.keys(data),
  });
  if (unwritable.length > 0) {
    return {
      status: "error",
      message: `operation "${operation.id}" writes ${unwritable.map((key) => `"${key}"`).join(", ")}, which this object type does not store as a field value — a relation moves with a link operation, and rollups and system properties are computed on read.`,
    };
  }

  if (operation.kind === "record" && operation.mode === "create") {
    try {
      const created = await createObjectRecord({
        organizationId,
        teamId,
        userId,
        objectTypeId: operation.objectTypeId,
        data,
        actor,
      });
      return { status: "ok", result: { id: created.id } };
    } catch (cause) {
      return { status: "error", message: describeWriteError(cause) };
    }
  }

  const requested =
    operation.kind === "bulk"
      ? resolveIds(operation.recordIds, state)
      : [resolveId(operation.recordId, state)].filter(
          (id): id is string => id !== null,
        );

  if (requested.length === 0) {
    return {
      status: "error",
      message: `operation "${operation.id}": no record id to act on — the variable it reads is empty.`,
    };
  }
  if (requested.length > BULK_CEILING) {
    return {
      status: "error",
      message: `operation "${operation.id}": ${requested.length.toString()} records is over the ${BULK_CEILING.toString()} ceiling for one write. Narrow the selection, or import through the objects UI.`,
    };
  }

  const owned = await ownedRecordIds({
    teamId,
    objectTypeId: operation.objectTypeId,
    ids: requested,
  });
  const refused = requested.filter((id) => !owned.has(id));
  if (owned.size === 0) {
    return {
      status: "error",
      message: `none of the ${requested.length.toString()} ids is a record of this page's object type in your team.`,
    };
  }
  const ids = requested.filter((id) => owned.has(id));

  try {
    if (operation.mode === "delete") {
      const result = await bulkDeleteObjectRecords({ teamId, ids, actor });
      const failed = summariseErrors(result.errors);
      return failed
        ? { status: "error", message: failed }
        : {
            status: "ok",
            result: { deleted: result.deletedIds.length, refused },
          };
    }

    const result = await bulkUpdateObjectRecords({
      teamId,
      updates: ids.map((id) => ({ id, data })),
      // PATCH, never replace: an operation names the fields it changes, and
      // omitted keys must keep the value the viewer never touched.
      merge: true,
      actor,
    });
    const failed = summariseErrors(result.errors);
    return failed
      ? { status: "error", message: failed }
      : {
          status: "ok",
          result: { updated: result.updatedIds.length, refused },
        };
  } catch (cause) {
    return { status: "error", message: describeWriteError(cause) };
  }
};
