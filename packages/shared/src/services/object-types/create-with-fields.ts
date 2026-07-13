import db from "../../db";
import type {
  FieldDefinition,
  FieldDefinitionConfig,
  FieldDefinitionType,
  ObjectType,
} from "../../db/schema";
import { fieldDefinitions, objectTypes } from "../../db/schema";
import { autoColorForKey } from "../../lib/colors/object-colors";
import { badRequest, internalError, throwHttpError } from "../../lib/errors";
import type { Audience } from "../../schemas/object-sharing";
import { invalidateFieldDefinitionsCache } from "../field-definitions/cache";
import { FIELD_DEFINITION_LIMITS } from "../field-definitions/constants";
import { fillOptionColors } from "../field-definitions/normalize-config";
import { slugifyFieldKey } from "../field-definitions/slugify-key";
import { validateFieldDefinitionShape } from "../field-definitions/validate";
import { reconcileObjectTable } from "../object-schema/table";
import { reconcileTypeGrants } from "../object-sharing/reconcile";
import { prepareObjectTypeKey } from "./create";
import { invalidateObjectTypeIdCache } from "./resolve";

export type ObjectTypeFieldInput = {
  label: string;
  type: FieldDefinitionType;
  description?: string | null;
  config?: FieldDefinitionConfig;
  isTitle?: boolean;
  aiExtractionEnabled?: boolean;
  vectorizeInclude?: boolean;
  displayInPanel?: boolean;
  enabled?: boolean;
  displayOrder?: number;
};

export type CreateObjectTypeWithFieldsInput = {
  organizationId: string;
  teamId: string;
  key: string;
  label: string;
  labelPlural?: string | null;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  fields: ObjectTypeFieldInput[];
  // Initial cross-team audience. Default (omitted) = internal (owning team only).
  sharing?: Audience;
  createdByUserId?: string | null;
};

export type ObjectTypeWithFields = ObjectType & {
  fieldDefinitions: FieldDefinition[];
};

/**
 * Create an object type together with its initial fields in ONE transaction —
 * the composer's "create" funnels here so a half-built type (row inserted but
 * some fields rejected) can never persist. Mirrors the per-field create rules
 * (key derivation + uniqueness, title resolution, shape validation) but applies
 * them in-memory against the fresh type, then regenerates the typed view once
 * instead of once per field.
 *
 * Title: exactly one text field becomes the title (Notion-style) — the first
 * field flagged `isTitle`, else the first text field. A type with no text field
 * gets no title (records fall back to `labelOverride`).
 */
export const createObjectTypeWithFields = async (
  input: CreateObjectTypeWithFieldsInput,
): Promise<ObjectTypeWithFields> => {
  const key = prepareObjectTypeKey(input.key);

  // Validate every field's intrinsic shape before touching the DB so the whole
  // batch fails fast and atomically.
  for (const f of input.fields) {
    // Relation fields need a backing link type resolved against existing types;
    // they are added after the type exists (via `createFieldDefinition`), not
    // at type-creation time.
    if (f.type === "relation") {
      return throwHttpError(
        400,
        badRequest(
          "Relation fields must be added after the type is created, not in the initial field set.",
        ),
      );
    }
    validateFieldDefinitionShape({
      label: f.label,
      description: f.description ?? null,
      type: f.type,
      config: f.config,
    });
  }

  const enabledCount = input.fields.filter((f) => f.enabled ?? true).length;
  if (enabledCount > FIELD_DEFINITION_LIMITS.MAX_FIELDS_PER_TYPE) {
    return throwHttpError(
      400,
      badRequest(
        `Cannot exceed ${FIELD_DEFINITION_LIMITS.MAX_FIELDS_PER_TYPE} enabled fields per type.`,
      ),
    );
  }

  // Title index: first explicitly-flagged text field, else first text field.
  const explicitTitle = input.fields.findIndex(
    (f) => f.isTitle === true && f.type === "text",
  );
  const titleIndex =
    explicitTitle !== -1
      ? explicitTitle
      : input.fields.findIndex((f) => f.type === "text");

  // Unique keys within the (fresh) type — slugify the label, then `_2`, `_3`, …
  const taken = new Set<string>();
  const resolveKey = (label: string): string => {
    const root = slugifyFieldKey(label);
    if (!taken.has(root)) {
      taken.add(root);
      return root;
    }
    for (let i = 2; ; i++) {
      const suffix = `_${i}`;
      const candidate = `${root.slice(0, 60 - suffix.length)}${suffix}`;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
  };

  const created = await db.transaction(async (tx) => {
    const [typeRow] = await tx
      .insert(objectTypes)
      .values({
        organizationId: input.organizationId,
        teamId: input.teamId,
        key,
        label: input.label,
        labelPlural: input.labelPlural ?? null,
        description: input.description ?? null,
        icon: input.icon ?? null,
        color: input.color ?? autoColorForKey(key),
        isSystem: false,
      })
      .returning();
    if (!typeRow) {
      return throwHttpError(500, internalError());
    }

    const rows = input.fields.map((f, i) => ({
      organizationId: input.organizationId,
      teamId: input.teamId,
      objectTypeId: typeRow.id,
      key: resolveKey(f.label),
      label: f.label,
      description: f.description ?? null,
      type: f.type,
      // Server owns option colors — fill any the writer (AI / SDK / composer)
      // left unset, mirroring the single-field `createFieldDefinition` path.
      config: fillOptionColors(f.type, f.config ?? {}),
      isTitle: i === titleIndex,
      aiExtractionEnabled: f.aiExtractionEnabled ?? true,
      vectorizeInclude: f.vectorizeInclude ?? true,
      displayInPanel: f.displayInPanel ?? true,
      enabled: f.enabled ?? true,
      displayOrder: f.displayOrder ?? i,
    }));

    const inserted = rows.length
      ? await tx.insert(fieldDefinitions).values(rows).returning()
      : [];

    // Build the extension table ONCE with the full column set. A fresh type has
    // no records, so no search-vector recompute is needed.
    await reconcileObjectTable({ tx, objectTypeId: typeRow.id });

    if (input.sharing) {
      await reconcileTypeGrants({
        objectTypeId: typeRow.id,
        ownerTeamId: input.teamId,
        organizationId: input.organizationId,
        audience: input.sharing,
        createdByUserId: input.createdByUserId ?? null,
        tx,
      });
    }

    return { type: typeRow, fields: inserted };
  });

  await invalidateFieldDefinitionsCache({
    organizationId: input.organizationId,
    teamId: input.teamId,
  });
  // Same reason as createObjectType: bust the key→id cache so a recreate after
  // a delete (same key) resolves to this new id.
  await invalidateObjectTypeIdCache({
    organizationId: input.organizationId,
    teamId: input.teamId,
    key,
  });

  return { ...created.type, fieldDefinitions: created.fields };
};
