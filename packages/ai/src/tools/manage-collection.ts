import { isValidCollectionColor } from "@fretik/shared/lib/colors/collection-colors";
import { isValidIcon } from "@fretik/shared/lib/icons/search";
import { audienceSchema } from "@fretik/shared/schemas/collection-sharing";
import {
  fieldConfigSchema,
  fieldDefinitionTypeSchema,
} from "@fretik/shared/schemas/field-definitions";
import { assertCanWriteType } from "@fretik/shared/services/collection-sharing/write-access";
import { COLLECTION_LIMITS } from "@fretik/shared/services/collections/constants";
import { createCollection } from "@fretik/shared/services/collections/create";
import { createCollectionWithFields } from "@fretik/shared/services/collections/create-with-fields";
import { deleteCollection } from "@fretik/shared/services/collections/delete";
import { resolveCollectionId } from "@fretik/shared/services/collections/resolve";
import { updateCollection } from "@fretik/shared/services/collections/update";
import { FIELD_DEFINITION_LIMITS } from "@fretik/shared/services/field-definitions/constants";
import { tool } from "ai";
import { z } from "zod";
import { gateBuiltinWriteTool } from "../agents/shared/policy-tool-gate";
import {
  agentEventActor,
  getRuntimeContext,
} from "../agents/shared/runtime-context";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * Drop any option color the model invented that isn't a valid palette token —
 * the server then auto-assigns one (via `fillOptionColors`). Silent fallback,
 * not an error: a bad color shouldn't cost a whole extra tool round-trip.
 */
const dropInvalidOptionColors = (
  config: z.infer<typeof fieldConfigSchema> | undefined,
): z.infer<typeof fieldConfigSchema> | undefined => {
  if (!config?.options) return config;
  return {
    ...config,
    options: config.options.map((o) =>
      o.color && !isValidCollectionColor(o.color)
        ? { ...o, color: undefined }
        : o,
    ),
  };
};

/**
 * Domain tool (deferred) — manage an object TYPE (the schema, not its rows):
 * create a new type (optionally with all its fields in one call), rename/restyle
 * one, or delete it. Creating provisions the typed table; deleting drops it and
 * its records. Edit individual fields later with `manageField`.
 */
export const createManageCollectionTool = () =>
  tool({
    description: [
      "Create, update, or delete a collection (the schema — a new kind of thing the team tracks). To change ONE column on an existing type, use `manageField` instead.",
      "",
      "Read `skills/designing-collections/SKILL.md` BEFORE creating or reshaping a type — it carries the modeling rules (field-type choices, relations, select options, bulk import). Check `<team_collections>` first: extending an existing type usually beats creating a near-duplicate. Schema changes are proposed to the user via `askUserQuestion` before building — never silently.",
      "",
      "- create: key (snake_case) + label + description + icon. Pass `fields` to build the whole schema in ONE call. Add relation/rollup fields after with manageField.",
      "- update: collectionKey + any of label, labelPlural, description, icon, enabled.",
      "- delete: collectionKey. Drops the type and all its records.",
      "",
      "Types are private to the team by default. `sharing` widens the audience (records inherit it live). Owner team only; propose with askUserQuestion before sharing beyond the team — especially write or whole-org.",
      "",
      "Every table auto-includes DB-maintained `created_at` / `updated_at` (reserved keys) — don't add a date field for creation/update time; query those columns.",
      "`description` (the type and each field) is one line — what it is for. Required on create.",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["create", "update", "delete"]),
      key: z
        .string()
        .max(60)
        .optional()
        .describe("snake_case slug. Required for create."),
      collectionKey: z
        .string()
        .max(60)
        .optional()
        .describe("Existing type slug. Required for update / delete."),
      label: z.string().optional(),
      labelPlural: z.string().nullish(),
      description: z
        .string()
        .max(COLLECTION_LIMITS.MAX_DESCRIPTION_CHARS)
        .nullish()
        .describe("What this type is for, one line. Required on create."),
      icon: z.string().nullish(),
      color: z.string().nullish(),
      enabled: z.boolean().optional().describe("update only — disable/enable."),
      sharing: audienceSchema
        .optional()
        .describe(
          "Cross-team audience (owner team only). { mode: 'internal' } (default, owning team only), { mode: 'org', permission } (whole organization), or { mode: 'teams', teams: [{ teamId, permission }] }. Records of the type inherit this live.",
        ),
      fields: z
        .array(
          z.object({
            label: z.string(),
            key: z
              .string()
              .max(60)
              .optional()
              .describe(
                "snake_case column key. Defaults to a slug of the label — set it explicitly on any field a formula in this same call reads, and in that formula's expression.",
              ),
            type: fieldDefinitionTypeSchema,
            description: z
              .string()
              .min(1)
              .max(FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS)
              .describe("What this field holds, one line."),
            config: fieldConfigSchema.optional(),
            isTitle: z.boolean().optional(),
          }),
        )
        .max(FIELD_DEFINITION_LIMITS.MAX_FIELDS_PER_TYPE)
        .optional()
        .describe(
          "create only — the type's fields, created atomically. Exclude relation/rollup (add with manageField).",
        ),
    }),
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      if (input.icon && !isValidIcon(input.icon)) {
        return toolError(
          TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
          `Unknown icon '${input.icon}'.`,
          "Call searchIcons to get valid Lucide icon names.",
        );
      }
      // A color is a palette token; an invalid one silently falls back to an
      // auto color (on create) or is ignored (on update) — never an error,
      // which would cost a needless extra tool round-trip.
      const safeColor =
        input.color && isValidCollectionColor(input.color) ? input.color : null;
      const badOptionIcon = (input.fields ?? [])
        .flatMap((f) => f.config?.options ?? [])
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
        if (input.action === "create") {
          if (!input.key || !input.label || !input.description) {
            return toolError(
              TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
              "create requires key, label, and a one-line description.",
            );
          }
          if (input.fields && input.fields.length > 0) {
            const created = await createCollectionWithFields({
              organizationId: ctx.organizationId,
              teamId: ctx.teamId,
              key: input.key,
              label: input.label,
              labelPlural: input.labelPlural ?? null,
              description: input.description ?? null,
              icon: input.icon ?? null,
              color: safeColor,
              sharing: input.sharing,
              createdByUserId: ctx.userId ?? null,
              fields: input.fields.map((f) => ({
                label: f.label,
                key: f.key,
                type: f.type,
                description: f.description ?? null,
                config: dropInvalidOptionColors(f.config),
                isTitle: f.isTitle,
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
          const type = await createCollection({
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            key: input.key,
            label: input.label,
            labelPlural: input.labelPlural ?? null,
            description: input.description ?? null,
            icon: input.icon ?? null,
            color: safeColor,
            sharing: input.sharing,
            createdByUserId: ctx.userId ?? null,
            actor: agentEventActor(ctx),
          });
          return { ok: true, type: { id: type.id, key: type.key } };
        }

        if (!input.collectionKey) {
          return toolError(
            TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
            `${input.action} requires collectionKey.`,
          );
        }
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

        // Owner team or a write grant — never mutate another team's type.
        await assertCanWriteType({
          collectionId,
          teamId: ctx.teamId,
          organizationId: ctx.organizationId,
        });

        if (input.action === "delete") {
          const gate = await gateBuiltinWriteTool(ctx, {
            toolName: "manageCollection",
            args: {
              action: "delete",
              collectionId,
              collectionKey: input.collectionKey,
            },
            summaryFields: [
              { labelKey: "collection", value: input.collectionKey },
            ],
          });
          if (gate !== null) return gate;
          const result = await deleteCollection({
            id: collectionId,
            actor: agentEventActor(ctx),
          });
          return { ok: true, ...result };
        }

        const type = await updateCollection({
          id: collectionId,
          patch: {
            label: input.label,
            labelPlural: input.labelPlural,
            description: input.description,
            icon: input.icon,
            // Only overwrite the color when a valid token was given; an invalid
            // or absent one leaves the existing color untouched.
            color:
              input.color && isValidCollectionColor(input.color)
                ? input.color
                : undefined,
            enabled: input.enabled,
          },
          sharing: input.sharing,
          callerTeamId: ctx.teamId,
          createdByUserId: ctx.userId ?? null,
          actor: agentEventActor(ctx),
        });
        return { ok: true, type: { id: type.id, key: type.key } };
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
          `manageCollection ${input.action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
