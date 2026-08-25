import { isValidIcon } from "@fretik/shared/lib/icons/search";
import {
  fieldConfigSchema,
  fieldDefinitionTypeSchema,
} from "@fretik/shared/schemas/field-definitions";
import { assertCanWriteType } from "@fretik/shared/services/collection-sharing/write-access";
import { resolveCollectionId } from "@fretik/shared/services/collections/resolve";
import { FIELD_DEFINITION_LIMITS } from "@fretik/shared/services/field-definitions/constants";
import { createFieldDefinition } from "@fretik/shared/services/field-definitions/create";
import { deleteFieldDefinition } from "@fretik/shared/services/field-definitions/delete";
import { getFieldDefinitionsForTeam } from "@fretik/shared/services/field-definitions/get-for-team";
import { updateFieldDefinition } from "@fretik/shared/services/field-definitions/update";
import { tool } from "ai";
import { z } from "zod";
import {
  agentEventActor,
  getRuntimeContext,
} from "../agents/shared/runtime-context";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * Domain tool (deferred) — manage a field on a collection: add, edit, delete,
 * or change its data type. Field changes are `ALTER TABLE` on the typed table.
 * `changeType` and a cascading `delete` RESET/DROP that field's stored values —
 * use them deliberately.
 */
export const createManageFieldTool = () =>
  tool({
    description: [
      "Manage a field on a collection (the typed column). Get current fields from describeCollection. The field TYPE decides what the team can filter, sum, and view on — when unsure which type fits (stored vs computed, select vs text, relation vs field), read `skills/designing-collections/SKILL.md` first.",
      "",
      "- add: collectionKey + label + type + description (one line — what it holds). Optional config (select options, number bounds, …) and key.",
      "- update: collectionKey + fieldKey + any of label, description, config, enabled. Keeps stored values.",
      "- changeType: collectionKey + fieldKey + type (+ config). RESETS the field's values.",
      "- delete: collectionKey + fieldKey. Pass cascade=true to drop a field that holds values.",
      "",
      "type is one of the field types in describeCollection. relation/rollup are virtual (no column); formula is computed by the database — pass `config.expression` alone, its result type is inferred.",
      "`id` / `created_at` / `updated_at` are reserved system columns every table already has — never add a date field for creation/update time.",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["add", "update", "delete", "changeType"]),
      collectionKey: z.string().max(60).describe("Collection slug."),
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
          TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
          `Unknown option icon '${badOptionIcon}'.`,
          "Call searchIcons to get valid Lucide icon names.",
        );
      }
      try {
        const collectionId = await resolveCollectionId({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          key: input.collectionKey,
        });
        if (!collectionId) {
          return toolError(
            TOOL_ERROR_CODES.COLLECTION_NOT_FOUND,
            `No collection '${input.collectionKey}' for this team.`,
            "Check the available type keys in <team_collections>.",
          );
        }

        // Owner team or a write grant — never edit another team's type's fields.
        await assertCanWriteType({
          collectionId,
          teamId: ctx.teamId,
          organizationId: ctx.organizationId,
        });

        if (input.action === "add") {
          if (!input.label || !input.type || !input.description) {
            return toolError(
              TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
              "add requires label, type, and a one-line description.",
            );
          }
          const field = await createFieldDefinition({
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            collectionId,
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
            TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
            `${input.action} requires fieldKey.`,
          );
        }
        const fields = await getFieldDefinitionsForTeam({
          teamId: ctx.teamId,
          collectionId,
          includeDisabled: true,
        });
        const field = fields.find((f) => f.key === input.fieldKey);
        if (!field) {
          return toolError(
            TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
            `No field '${input.fieldKey}' on type '${input.collectionKey}'.`,
            "Call describeCollection to see the field keys.",
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
              TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
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
          TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
          `manageField ${input.action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
