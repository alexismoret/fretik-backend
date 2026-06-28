import { isValidObjectColor } from "@fretik/shared/lib/colors/object-colors";
import { isValidIcon } from "@fretik/shared/lib/icons/search";
import {
  fieldConfigSchema,
  fieldDefinitionTypeSchema,
} from "@fretik/shared/schemas/field-definitions";
import { FIELD_DEFINITION_LIMITS } from "@fretik/shared/services/field-definitions/constants";
import { assertCanWriteType } from "@fretik/shared/services/object-sharing/write-access";
import { OBJECT_TYPE_LIMITS } from "@fretik/shared/services/object-types/constants";
import { createObjectType } from "@fretik/shared/services/object-types/create";
import { createObjectTypeWithFields } from "@fretik/shared/services/object-types/create-with-fields";
import { deleteObjectType } from "@fretik/shared/services/object-types/delete";
import { resolveObjectTypeId } from "@fretik/shared/services/object-types/resolve";
import { updateObjectType } from "@fretik/shared/services/object-types/update";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * Domain tool (deferred) — manage an object TYPE (the schema, not its rows):
 * create a new type (optionally with all its fields in one call), rename/restyle
 * one, or delete it. Creating provisions the typed table; deleting drops it and
 * its records. Edit individual fields later with `manageField`.
 */
export const createManageObjectTypeTool = () =>
  tool({
    description: [
      "Create, update, or delete an object type (the schema).",
      "",
      "- create: key (snake_case) + label + description + icon. Pass `fields` to build the whole schema in ONE call. Add relation/rollup fields after with manageField.",
      "- update: typeKey + any of label, labelPlural, description, icon, enabled.",
      "- delete: typeKey. Drops the type and all its records.",
      "",
      "`description` (the type and each field) is one line — what it is for. Required on create.",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["create", "update", "delete"]),
      key: z
        .string()
        .max(60)
        .optional()
        .describe("snake_case slug. Required for create."),
      typeKey: z
        .string()
        .max(60)
        .optional()
        .describe("Existing type slug. Required for update / delete."),
      label: z.string().optional(),
      labelPlural: z.string().nullish(),
      description: z
        .string()
        .max(OBJECT_TYPE_LIMITS.MAX_DESCRIPTION_CHARS)
        .nullish()
        .describe("What this type is for, one line. Required on create."),
      icon: z.string().nullish(),
      color: z.string().nullish(),
      enabled: z.boolean().optional().describe("update only — disable/enable."),
      fields: z
        .array(
          z.object({
            label: z.string(),
            type: fieldDefinitionTypeSchema,
            description: z
              .string()
              .min(1)
              .max(FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS)
              .describe("What this field holds, one line."),
            config: fieldConfigSchema.optional(),
            isTitle: z.boolean().optional(),
            displayInFilters: z.boolean().optional(),
          }),
        )
        .optional()
        .describe(
          "create only — the type's fields, created atomically. Exclude relation/rollup (add with manageField).",
        ),
    }),
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      if (input.icon && !isValidIcon(input.icon)) {
        return toolError(
          TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
          `Unknown icon '${input.icon}'.`,
          "Call searchIcons to get valid Lucide icon names.",
        );
      }
      if (input.color && !isValidObjectColor(input.color)) {
        return toolError(
          TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
          `Unknown color '${input.color}'. Colors are auto-assigned — omit unless the user names one.`,
        );
      }
      const badOptionIcon = (input.fields ?? [])
        .flatMap((f) => f.config?.options ?? [])
        .map((o) => o.icon)
        .find((icon) => icon && !isValidIcon(icon));
      if (badOptionIcon) {
        return toolError(
          TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
          `Unknown option icon '${badOptionIcon}'.`,
          "Call searchIcons to get valid Lucide icon names.",
        );
      }
      try {
        if (input.action === "create") {
          if (!input.key || !input.label || !input.description) {
            return toolError(
              TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
              "create requires key, label, and a one-line description.",
            );
          }
          if (input.fields && input.fields.length > 0) {
            const created = await createObjectTypeWithFields({
              organizationId: ctx.organizationId,
              teamId: ctx.teamId,
              key: input.key,
              label: input.label,
              labelPlural: input.labelPlural ?? null,
              description: input.description ?? null,
              icon: input.icon ?? null,
              color: input.color ?? null,
              fields: input.fields.map((f) => ({
                label: f.label,
                type: f.type,
                description: f.description ?? null,
                config: f.config,
                isTitle: f.isTitle,
                displayInFilters: f.displayInFilters,
              })),
            });
            return {
              ok: true,
              type: { id: created.id, key: created.key },
              fields: created.fieldDefinitions.map((f) => ({
                key: f.key,
                type: f.type,
              })),
            };
          }
          const type = await createObjectType({
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            key: input.key,
            label: input.label,
            labelPlural: input.labelPlural ?? null,
            description: input.description ?? null,
            icon: input.icon ?? null,
            color: input.color ?? null,
          });
          return { ok: true, type: { id: type.id, key: type.key } };
        }

        if (!input.typeKey) {
          return toolError(
            TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
            `${input.action} requires typeKey.`,
          );
        }
        const objectTypeId = await resolveObjectTypeId({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          key: input.typeKey,
        });
        if (!objectTypeId) {
          return toolError(
            TOOL_ERROR_CODES.OBJECT_TYPE_NOT_FOUND,
            `No object type '${input.typeKey}' for this team.`,
            "Check the available type keys in <team_objects>.",
          );
        }

        // Owner team or a write grant — never mutate another team's type.
        await assertCanWriteType({
          objectTypeId,
          teamId: ctx.teamId,
          organizationId: ctx.organizationId,
        });

        if (input.action === "delete") {
          const result = await deleteObjectType({ id: objectTypeId });
          return { ok: true, ...result };
        }

        const type = await updateObjectType({
          id: objectTypeId,
          patch: {
            label: input.label,
            labelPlural: input.labelPlural,
            description: input.description,
            icon: input.icon,
            color: input.color,
            enabled: input.enabled,
          },
        });
        return { ok: true, type: { id: type.id, key: type.key } };
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
          `manageObjectType ${input.action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
