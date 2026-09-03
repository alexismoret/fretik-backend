import {
  PAGE_LIMITS,
  PageBriefSchema,
  PageDatasetSchema,
  PageOperationSchema,
  PageThemeSchema,
  PageVariableSchema,
} from "@fretik/shared/schemas/pages";
import { z } from "zod";

/**
 * `page.json` — everything about a page that is not code.
 *
 * A file rather than tool arguments, for the same reason the components are
 * files: it can be READ back, EDITED in place, and it sits next to the code
 * that uses it. Adding a dataset stops being a call that resends the whole
 * contract and becomes three lines changed in a file the agent can see.
 *
 * The grammar is the definition's own — the same dataset, variable and
 * operation schemas the runtime validates — so what is written here is exactly
 * what the bridge will answer to, with no translation layer to drift.
 */
export const PAGE_JSON_FILE = "page.json";

export const PageJsonSchema = z.object({
  /** What the page is called in the hub. Derived from its `<h1>` when absent. */
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(4000).optional(),
  icon: z.string().max(60).optional(),
  color: z.string().max(40).optional(),
  brief: PageBriefSchema.optional(),
  variables: z
    .array(PageVariableSchema)
    .max(PAGE_LIMITS.maxVariables)
    .optional(),
  datasets: z.array(PageDatasetSchema).max(PAGE_LIMITS.maxDatasets).optional(),
  operations: z
    .array(PageOperationSchema)
    .max(PAGE_LIMITS.maxOperations)
    .optional(),
  theme: PageThemeSchema.optional(),
});
export type PageJson = z.infer<typeof PageJsonSchema>;

/**
 * Read `page.json`, or say what is wrong with it in one line an agent can act
 * on: the path inside the document, then the message. A raw Zod dump names
 * `union` branches the agent never wrote.
 */
export const parsePageJson = (
  raw: string,
): { ok: true; value: PageJson } | { ok: false; errors: string[] } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      errors: [
        `${PAGE_JSON_FILE}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const result = PageJsonSchema.safeParse(parsed);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    errors: result.error.issues.slice(0, 8).map((issue) => {
      const where = issue.path
        .map((part) =>
          typeof part === "number"
            ? `[${part.toString()}]`
            : `.${String(part)}`,
        )
        .join("")
        .replace(/^\./, "");
      return `${PAGE_JSON_FILE}: ${where === "" ? "(root)" : where} — ${issue.message}`;
    }),
  };
};

/** A starting `page.json` for a page that has none — the shape, not content. */
export const EMPTY_PAGE_JSON = JSON.stringify(
  { name: "", brief: undefined, variables: [], datasets: [], operations: [] },
  null,
  2,
);
