import { getFieldDefinitionsForTeam } from "@fretik/shared/services/field-definitions/get-for-team";
import { describeTeamSchema } from "@fretik/shared/services/object-types/describe-team-schema";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  DOMAIN_TOOL_THRESHOLD_CHARS,
  maybePersistLargeOutput,
} from "../lib/persisted-output";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * Domain tool (deferred) — full schema of ONE object type: its typed view name,
 * every field (key, label, type, description, config), and its outgoing
 * relations. Generalizes the old `listFieldDefinitions` (which only knew the
 * document type).
 *
 * Use when `<team_objects>` (key + type only) is not enough: the user-facing
 * label, the `description` (also the LLM extraction hint), the closed list of
 * `select` options, `number` bounds, or which fields are filterable.
 */
export const createDescribeObjectTypeTool = () =>
  tool({
    description: [
      "Full schema of one object type: its typed SQL view, fields (key, label, type, description, config/options), and outgoing relations.",
      "",
      "Use this when you need a field's exact `select` options, `number` bounds, `description`, or user-facing label before writing a `querySql` against the type's `v_<key>` view or filtering `listObjects`. Get type keys from `listObjectTypes` or `<team_objects>`.",
    ].join("\n"),
    inputSchema: z.object({
      typeKey: z
        .string()
        .min(1)
        .max(60)
        .describe(
          "Object type slug (e.g. 'company', 'pricing') from listObjectTypes or <team_objects>.",
        ),
    }),
    execute: async ({ typeKey }, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;

      let schema: Awaited<ReturnType<typeof describeTeamSchema>>;
      try {
        schema = await describeTeamSchema({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
        });
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
          `describeObjectType failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const type = schema.find((s) => s.key === typeKey);
      if (!type) {
        return toolError(
          TOOL_ERROR_CODES.OBJECT_TYPE_NOT_FOUND,
          `No object type '${typeKey}' for this team.`,
          "Call listObjectTypes to see the available type keys.",
        );
      }

      let fields: Awaited<ReturnType<typeof getFieldDefinitionsForTeam>>;
      try {
        fields = await getFieldDefinitionsForTeam({
          teamId: ctx.teamId,
          objectTypeId: type.id,
        });
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
          `describeObjectType failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const payload = {
        key: type.key,
        label: type.label,
        description: type.description,
        view: type.viewName,
        fields: fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          description: f.description,
          config: f.config,
          isTitle: f.isTitle,
          displayInFilters: f.displayInFilters,
        })),
        relations: type.relations.map((r) => ({
          key: r.key,
          label: r.label,
          target: r.toTypeKey ?? "any",
        })),
      };

      return maybePersistLargeOutput(
        payload,
        ctx.conversationId,
        toolCallId,
        DOMAIN_TOOL_THRESHOLD_CHARS,
      );
    },
  });
