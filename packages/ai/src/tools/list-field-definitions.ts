import { getFieldDefinitionsForTeam } from "@fretik/shared/services/field-definitions/get-for-team";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  DOMAIN_TOOL_THRESHOLD_CHARS,
  maybePersistLargeOutput,
} from "../lib/persisted-output";

/**
 * Domain tool — full details of the team's enabled dynamic field
 * definitions.
 *
 * The compact `<team_fields>` block in the system prompt's dynamic
 * suffix already exposes every `key` + `type` so the model can write
 * correct `document_field_values.field_key` filters without calling
 * any tool. This tool is the on-demand escape hatch when the model
 * needs more: the user-facing `label`, the `description` (also used as
 * the LLM extraction hint), or the `config` (closed list of options
 * for `select` / `multi_select`, `min` / `max` for `number`,
 * `multiline` for `text`, …).
 *
 * Same backing service as the pre-extract pipeline and the UI panel —
 * Redis-cached for 30 min, ordered by `displayOrder`, filtered to
 * `enabled = true`.
 */
export const createListFieldDefinitionsTool = () =>
  tool({
    description: [
      "Full details of the team's configured document fields (key, label, type, description, config).",
      "",
      "Use this when you need:",
      "- The exact options of a `select` / `multi_select` field (the closed list of allowed values).",
      "- A field's `description` (the same text used as LLM extraction hint — useful to understand what the field is meant to capture).",
      "- `min` / `max` bounds on a `number` field, or any other `config` detail.",
      "- The user-facing `label` when the slug `key` would be awkward to humanize.",
      "",
      "The compact `<team_fields>` block in the system prompt already lists every `key` + `type` — call this tool only when those are insufficient.",
    ].join("\n"),
    inputSchema: z.object({}),
    execute: async (_input, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;

      const defs = await getFieldDefinitionsForTeam({ teamId: ctx.teamId });

      const payload = {
        fields: defs.map((fd) => ({
          key: fd.key,
          label: fd.label,
          type: fd.type,
          description: fd.description,
          config: fd.config,
          displayOrder: fd.displayOrder,
          aiExtractionEnabled: fd.aiExtractionEnabled,
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
