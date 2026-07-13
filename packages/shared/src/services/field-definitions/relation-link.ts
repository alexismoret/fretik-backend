import { and, eq } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinitionConfig } from "../../db/schema";
import { linkTypes } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import { createLinkType } from "../link-types/create";
import { DOCUMENT_TYPE_KEY } from "../object-types/constants";
import { resolveObjectTypeId } from "../object-types/resolve";

/**
 * Resolve the backing link type for a `relation` field, creating it on first
 * use. A relation field is a typed projection over the `links` graph: its
 * instances are edges of one link type, never values in `object_records.data`.
 * This binds the two so the typed-view generator and the links API agree on
 * which edges belong to the field.
 *
 * Decisions:
 *   - Relation fields are TEAM-scoped (they reference concrete records). An
 *     org-scope (template) relation field is rejected — templates ship scalar
 *     fields; relations are added per team.
 *   - The backing link type is always `many_to_many`. The field's
 *     `config.cardinality` ("one" | "many") drives the picker (single vs multi)
 *     and the projection shape; the active-edge unique index already prevents
 *     duplicate edges, so a stricter link cardinality would buy nothing.
 *   - `widget: "attachment"` targets the `document` type. An explicit
 *     `targetTypeKey` resolves to that type (self-relation when it equals the
 *     field's own type). Neither set = polymorphic (link `toObjectType` NULL).
 *
 * Idempotent: when `config.linkTypeKey` already points to an existing link type
 * for the team, it is reused (re-saving a relation field never sprawls edges).
 * Returns the config with `linkTypeKey` set, to store on the field.
 */
export const bindRelationFieldLinkType = async (input: {
  organizationId: string;
  teamId: string | null;
  objectTypeId: string;
  label: string;
  config: FieldDefinitionConfig;
}): Promise<FieldDefinitionConfig> => {
  const { organizationId, teamId, objectTypeId, label, config } = input;

  if (teamId === null) {
    return throwHttpError(
      400,
      badRequest(
        "Relation fields are team-scoped and cannot be defined on an organization template.",
      ),
    );
  }

  const targetKey =
    "widget" in config && config.widget === "attachment"
      ? DOCUMENT_TYPE_KEY
      : "targetTypeKey" in config
        ? config.targetTypeKey
        : undefined;

  // Polymorphic when no target is named; otherwise the target type must exist.
  let toObjectTypeId: string | null = null;
  if (targetKey) {
    toObjectTypeId = await resolveObjectTypeId({
      organizationId,
      teamId,
      key: targetKey,
    });
    if (!toObjectTypeId) {
      return throwHttpError(
        400,
        badRequest(`Relation target type '${targetKey}' does not exist.`),
      );
    }
  }

  // Reuse an already-bound link type (idempotent re-save).
  const existingKey = "linkTypeKey" in config ? config.linkTypeKey : undefined;
  if (existingKey) {
    const [bound] = await db
      .select({ normalizedKey: linkTypes.normalizedKey })
      .from(linkTypes)
      .where(
        and(
          eq(linkTypes.teamId, teamId),
          eq(linkTypes.normalizedKey, existingKey),
        ),
      )
      .limit(1);
    if (bound) return config;
  }

  const linkType = await createLinkType({
    organizationId,
    teamId,
    label,
    fromObjectTypeId: objectTypeId,
    toObjectTypeId,
    cardinality: "many_to_many",
    source: "user_manual",
  });

  return { ...config, linkTypeKey: linkType.normalizedKey };
};
