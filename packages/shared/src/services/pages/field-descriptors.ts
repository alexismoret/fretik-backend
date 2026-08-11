import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import type { PageFieldDescriptor } from "../../schemas/pages";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";

/**
 * Turn a team's field definitions into the small, public-safe descriptors a
 * page ships alongside its rows.
 *
 * This is the single biggest lever on how a generated page LOOKS: with it, a
 * table column over a `select` renders that option's own badge — its colour,
 * its icon — a money column renders its currency, a rating renders stars, and
 * the agent had to write nothing. Without it every cell is grey text.
 *
 * Two rules hold the boundary:
 *
 * 1. This travels with the DATA, never with the definition. A published page's
 *    definition is frozen at publish time; an option's colour must stay live,
 *    or renaming a status would leave the public page showing the old one.
 * 2. `config` is copied field by field through an explicit allowlist. The
 *    stored `FieldDefinition` carries rollup formulas, relation link types and
 *    internal ids — none of which belong on an anonymous public page.
 */

/**
 * Field types a table can never order on: they have no stored column — a
 * relation lives in the links graph, a rollup is computed on read. Asking for
 * one is not an error, it is simply ignored, so the browser needs to know
 * before it offers the header.
 */
const UNSORTABLE_TYPES: ReadonlySet<string> = new Set(["relation", "rollup"]);

/** Config is a union across field types; read one key without widening it. */
const configValue = (definition: FieldDefinition, key: string): unknown =>
  Reflect.get(definition.config, key);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** Select options, narrowed to what a badge needs. */
const optionsOf = (
  definition: FieldDefinition,
): PageFieldDescriptor["options"] => {
  const raw = configValue(definition, "options");
  if (!Array.isArray(raw)) return undefined;
  const options: NonNullable<PageFieldDescriptor["options"]> = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = asString(Reflect.get(entry, "value"));
    if (value === undefined) continue;
    options.push({
      value,
      label: asString(Reflect.get(entry, "label")) ?? value,
      color: asString(Reflect.get(entry, "color")),
      icon: asString(Reflect.get(entry, "icon")),
    });
  }
  return options.length > 0 ? options : undefined;
};

const describeField = (
  definition: FieldDefinition,
  relationLook: Map<string, { icon?: string; color?: string }>,
): PageFieldDescriptor => {
  const target =
    definition.type === "relation"
      ? relationLook.get(
          asString(configValue(definition, "targetTypeKey")) ?? "",
        )
      : undefined;

  return {
    key: definition.key,
    label: definition.label,
    type: definition.type,
    options: optionsOf(definition),
    currencyCode: asString(configValue(definition, "defaultCurrencyCode")),
    numberFormat: asString(configValue(definition, "numberFormat")),
    precision: asNumber(configValue(definition, "precision")),
    suffix: asString(configValue(definition, "suffix")),
    display: asString(configValue(definition, "display")),
    min: asNumber(configValue(definition, "min")),
    max: asNumber(configValue(definition, "max")),
    ratingMax: asNumber(configValue(definition, "ratingMax")),
    ratingIcon: asString(configValue(definition, "ratingIcon")),
    hasTime: asBoolean(configValue(definition, "hasTime")),
    prefix: asString(configValue(definition, "prefix")),
    targetIcon: target?.icon,
    targetColor: target?.color,
    isTitle: definition.isTitle ? true : undefined,
    sortable: !UNSORTABLE_TYPES.has(definition.type),
  };
};

export const buildPageFieldDescriptors = async (params: {
  teamId: string;
  objectTypeId: string;
}): Promise<PageFieldDescriptor[]> => {
  const definitions = await getFieldDefinitionsForTeam({
    teamId: params.teamId,
    objectTypeId: params.objectTypeId,
  });
  if (definitions.length === 0) return [];

  // A relation chip carries the TARGET type's icon and colour, which the
  // browser has no way to look up on a public page — resolve it here, once
  // per distinct target rather than once per relation field.
  const targetKeys = new Set<string>();
  for (const definition of definitions) {
    if (definition.type !== "relation") continue;
    const key = asString(configValue(definition, "targetTypeKey"));
    if (key) targetKeys.add(key);
  }

  const relationLook = new Map<string, { icon?: string; color?: string }>();
  if (targetKeys.size > 0) {
    const types = await db.query.objectTypes.findMany({
      columns: { key: true, icon: true, color: true },
      where: { key: { in: [...targetKeys] } },
    });
    for (const type of types) {
      relationLook.set(type.key, {
        icon: type.icon ?? undefined,
        color: type.color ?? undefined,
      });
    }
  }

  return definitions.map((definition) =>
    describeField(definition, relationLook),
  );
};
