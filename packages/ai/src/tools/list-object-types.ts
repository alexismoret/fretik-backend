import { listObjectTypes } from "@fretik/shared/services/object-types/retrieve";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  DOMAIN_TOOL_THRESHOLD_CHARS,
  maybePersistLargeOutput,
} from "../lib/persisted-output";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * Domain tool (deferred) — the team's object types (the ontology catalogue).
 *
 * The `<team_objects>` block already lists every type with its view + columns,
 * so this is the on-demand catalogue overview when the model needs the full
 * label / plural / description set. Drill into one type's fields + relations
 * with `describeObjectType`, browse its records with `listObjects`.
 */
export const createListObjectTypesTool = () =>
  tool({
    description: [
      "List the team's object types (the kinds of things it tracks: companies, people, documents, and any custom types).",
      "",
      "Use this to discover what structured data exists before querying. Returns each type's key, label, plural, description, and whether it is a system type. Then call `describeObjectType` for a type's fields + relations, `listObjects` to browse its records, or query its `v_<key>` view via `querySql`.",
    ].join("\n"),
    inputSchema: z.object({}),
    execute: async (_input, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;

      let types: Awaited<ReturnType<typeof listObjectTypes>>;
      try {
        types = await listObjectTypes({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
        });
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
          `listObjectTypes failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const payload = {
        objectTypes: types.map((t) => ({
          key: t.key,
          label: t.label,
          labelPlural: t.labelPlural,
          description: t.description,
          isSystem: t.isSystem,
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
