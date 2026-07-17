import { isValidIcon } from "@fretik/shared/lib/icons/search";
import {
  fieldConfigSchema,
  fieldDefinitionTypeSchema,
} from "@fretik/shared/schemas/field-definitions";
import { FIELD_DEFINITION_LIMITS } from "@fretik/shared/services/field-definitions/constants";
import { createFieldDefinition } from "@fretik/shared/services/field-definitions/create";
import { deleteFieldDefinition } from "@fretik/shared/services/field-definitions/delete";
import { getFieldDefinitionsForTeam } from "@fretik/shared/services/field-definitions/get-for-team";
import { updateFieldDefinition } from "@fretik/shared/services/field-definitions/update";
import { assertCanWriteType } from "@fretik/shared/services/object-sharing/write-access";
import { resolveObjectTypeId } from "@fretik/shared/services/object-types/resolve";
import { tool } from "ai";
import { z } from "zod";
import {
  agentEventActor,
  getRuntimeContext,
} from "../agents/shared/runtime-context";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * Domain tool (deferred) — manage a field on an object type: add, edit, delete,
 * or change its data type. Field changes are `ALTER TABLE` on the typed table.
 * `changeType` and a cascading `delete` RESET/DROP that field's stored values —
 * use them deliberately.
 */
export const createManageFieldTool = () =>
  tool({
    description: [
      "Manage a field on an object type (the typed column). Get current fields from describeObjectType. The field TYPE decides what the team can filter, sum, and view on — when unsure which type fits (select vs text, relation vs field, number config), read `skills/designing-object-types/SKILL.md` first.",
      "",
      "- add: typeKey + label + type + description (one line — what it holds). Optional config (select options, number bounds, …) and key.",
      "- update: typeKey + fieldKey + any of label, description, config, enabled. Keeps stored values.",
      "- changeType: typeKey + fieldKey + type (+ config). RESETS the field's values.",
      "- delete: typeKey + fieldKey. Pass cascade=true to drop a field that holds values.",
      "",
      "type is one of the field types in describeObjectType. relation/rollup are virtual (no column).",
      "`id` / `created_at` / `updated_at` are reserved system columns every table already has — never add a date field for creation/update time.",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["add", "update", "delete", "changeType"]),
      typeKey: z.string().max(60).describe("Object type slug."),
      fieldKey: z
        .string()
        .max(60)
        .optional()
        .describe("Field key. Required for update / delete / changeType."),
      label: z.string().optional().describe("Required for add."),
      type: fieldDefinitionTypeSchema
        .optional()
        .describe("Field data type. Required for add / changeType."),
      config: fieldConfigSchema.optional(),
      description: z
        .string()
        .max(FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS)
        .nullish()
        .describe("What this field holds, one line. Required on add."),
      enabled: z.boolean().optional(),
      cascade: z
        .boolean()
        .optional()
        .describe("delete only — allow dropping a field that holds values."),
    }),
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      const badOptionIcon = (input.config?.options ?? [])
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

        // Owner team or a write grant — never edit another team's type's fields.
        await assertCanWriteType({
          objectTypeId,
          teamId: ctx.teamId,
          organizationId: ctx.organizationId,
        });

        if (input.action === "add") {
          if (!input.label || !input.type || !input.description) {
            return toolError(
              TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
              "add requires label, type, and a one-line description.",
            );
          }
          const field = await createFieldDefinition({
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            objectTypeId,
            label: input.label,
            type: input.type,
            config: input.config,
            description: input.description ?? null,
            actor: agentEventActor(ctx),
          });
          return { ok: true, field: { id: field.id, key: field.key } };
        }

        // update / delete / changeType need an existing field.
        if (!input.fieldKey) {
          return toolError(
            TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
            `${input.action} requires fieldKey.`,
          );
        }
        const fields = await getFieldDefinitionsForTeam({
          teamId: ctx.teamId,
          objectTypeId,
          includeDisabled: true,
        });
        const field = fields.find((f) => f.key === input.fieldKey);
        if (!field) {
          return toolError(
            TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
            `No field '${input.fieldKey}' on type '${input.typeKey}'.`,
            "Call describeObjectType to see the field keys.",
          );
        }

        if (input.action === "delete") {
          const result = await deleteFieldDefinition({
            id: field.id,
            cascade: input.cascade ?? false,
            actor: agentEventActor(ctx),
          });
          return { ok: true, ...result };
        }

        if (input.action === "changeType") {
          if (!input.type) {
            return toolError(
              TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
              "changeType requires type.",
            );
          }
          const updated = await updateFieldDefinition({
            id: field.id,
            cascade: true,
            patch: { type: input.type, config: input.config },
            actor: agentEventActor(ctx),
          });
          return { ok: true, field: { id: updated.id, key: updated.key } };
        }

        const updated = await updateFieldDefinition({
          id: field.id,
          patch: {
            label: input.label,
            description: input.description,
            config: input.config,
            enabled: input.enabled,
          },
          actor: agentEventActor(ctx),
        });
        return { ok: true, field: { id: updated.id, key: updated.key } };
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
          `manageField ${input.action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
