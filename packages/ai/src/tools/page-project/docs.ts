import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../../agents/shared/runtime-context";
import {
  DOMAIN_TOOL_THRESHOLD_CHARS,
  maybePersistLargeOutput,
} from "../../lib/persisted-output";
import { TOOL_ERROR_CODES, toolError } from "../../lib/tool-error-codes";
import { recordComponentsRead } from "../../services/page-review/page-session-store";
import { renderComponentCatalogue } from "../page-component-catalogue";
import {
  MAX_COMPONENT_DOCS,
  listComponentNames,
  readComponentDocs,
} from "../page-component-docs";

/**
 * The real API of the components a page is about to use — every prop, slot and
 * emit, plus one snippet showing which part goes in which slot, generated from
 * the library's own docs.
 *
 * Not optional, and not covered by knowing Nuxt UI: an unknown prop is dropped
 * in silence, a mis-slotted panel renders in the wrong place, and a handler
 * with a guessed signature receives the wrong argument. Two shipped pages
 * failed exactly there — a slideover that opened empty, and a compose form that
 * rendered permanently inline because it sat in a modal's trigger slot. Both
 * compiled. Both logged nothing.
 *
 * With no `components` it answers the other question — what is there at all.
 * The catalogue is already in the builder's prompt, so this branch is a
 * re-read rather than a discovery; it exists because the alternative to
 * re-reading is guessing, and a guessed component name renders as an unknown
 * element that nothing warns about.
 */

export const createPageDocsTool = () =>
  tool({
    description: `The real API — props, slots, emits, and which part goes in which named slot — of up to ${MAX_COMPONENT_DOCS.toString()} Nuxt UI components at a time, from the library's own docs. Read every component your template will use BEFORE writing it: a guessed prop is dropped silently and content in the wrong named slot renders somewhere else. Call it with no \`components\` for the catalogue: every component the runtime registers, what each is for and when it is the wrong answer. Add \`full: true\` for usage notes and worked examples.`,
    inputSchema: z.object({
      components: z
        .array(z.string().max(60))
        .min(1)
        .max(MAX_COMPONENT_DOCS)
        .optional()
        .describe(
          'Component names, e.g. ["UTable", "USelectMenu"]. Omit for the catalogue of all of them.',
        ),
      full: z
        .boolean()
        .optional()
        .describe("Include usage notes and examples, not just the API table."),
    }),
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      if (input.components === undefined) {
        return { catalogue: renderComponentCatalogue() };
      }
      const result = await readComponentDocs(input.components, {
        ...(input.full !== undefined ? { full: input.full } : {}),
      });
      if ("error" in result) {
        return toolError(TOOL_ERROR_CODES.INTERNAL_ERROR, result.error);
      }
      if (result.docs.length === 0) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          `No such component: ${result.unknown.join(", ")}.`,
          `The page runtime registers: ${(await listComponentNames()).join(", ")}. Call pageDocs with no arguments for what each one is for.`,
        );
      }
      await recordComponentsRead(
        ctx.conversationId,
        result.docs.map((doc) => doc.component),
      );
      // Eight heavy components measure well past 100k chars. Without this the
      // stream truncates and the model reads a mangled API — the exact failure
      // this tool exists to prevent.
      return await maybePersistLargeOutput(
        {
          docs: result.docs,
          ...(result.unknown.length > 0
            ? {
                unknown: result.unknown,
                hint: "Those are not registered in the page runtime — do not use them in a template; they render as unknown elements.",
              }
            : {}),
        },
        ctx.conversationId,
        options.toolCallId,
        DOMAIN_TOOL_THRESHOLD_CHARS,
      );
    },
  });
