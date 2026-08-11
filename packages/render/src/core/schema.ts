import { defineSchema } from "@json-render/core";
import { BUILT_IN_ACTIONS } from "./built-in-actions";
import { renderPromptTemplate } from "./prompt-template";

/**
 * The element-tree schema every Fretik surface renders through.
 *
 * Deliberately OURS rather than `@json-render/vue`'s stock export. The stock
 * schema's `defaultRules` instruct the model to invent sample data — "ALWAYS
 * include a state field with realistic sample data", "Never leave data empty",
 * "For blogs include 3-4 posts" — which is the precise opposite of what a
 * Fretik page is. A page stores a QUESTION, not an answer: it re-queries on
 * every view, and inlined sample rows would be a frozen lie. Those rules are
 * baked into the schema and `prompt()` offers no way to suppress them (only
 * `customRules`, which appends), so reusing the stock schema would mean
 * shipping a contradiction to the agent.
 *
 * The SPEC SHAPE stays byte-compatible with what `@json-render/vue`'s renderer
 * walks (`{ root, elements }`) — the renderer takes a spec and a registry and
 * never consults the schema, so a custom schema costs nothing at render time.
 * What we gain is an accurate contract: the stock schema omits `on`, `repeat`
 * and `watch` from its element declaration even though the runtime supports
 * them, so its generated JSON Schema understates the format.
 *
 * Per-surface doctrine does NOT live here — `defaultRules` are the things true
 * of every surface (tree integrity, where a field belongs). Anything specific
 * to pages or forms is passed as `customRules` at `prompt()` time by that
 * catalog's module.
 */
export const elementTreeSchema = defineSchema(
  (s) => ({
    spec: s.object({
      /** Key of the root element. */
      root: s.string(),
      /** Flat map of elements by key. */
      elements: s.record(
        s.object({
          /** Component name from the catalog. */
          type: s.ref("catalog.components"),
          props: s.propsOf("catalog.components"),
          /** Keys of child elements — a reference, not a nested node. */
          children: s.array(s.string()),
          /** Render condition, evaluated against state. */
          visible: s.any(),
          /** Event name → action binding(s). */
          on: s.any(),
          /** Repeat this element's children once per item in a state array. */
          repeat: s.any(),
          /** State path → action binding(s), fired when the value changes. */
          watch: s.any(),
        }),
      ),
      /** Initial state model — what the viewer's controls read and write. */
      state: s.any(),
    }),
    catalog: s.object({
      // Only `props` is REQUIRED on a catalog entry — the library types every
      // other field as partial (`InferMapEntryRequired` keys on the literal
      // "props"). So an entry declares `slots`/`notes`/`meta` only when it has
      // something to say, and silence means "none".
      components: s.map({
        /** Zod props — LITERAL types. Feeds the prompt, the JSON Schema and
         *  registry typing. Bindings are documented once via the `$`
         *  directive, never per prop (see `catalogs/pages.ts`). */
        props: s.zod(),
        /** `["default"]` when the component accepts children. */
        slots: s.array(s.string()),
        /** Events this component fires, bindable through the element's `on`.
         *  Entry-level rather than inside `meta` — the library's own
         *  first-party catalog (`@json-render/shadcn`) declares it there. */
        events: s.array(s.string()),
        /** One line, agent-facing: what this component is for. */
        description: s.string(),
        /** Prop name → one line of prose the TYPE cannot carry ("bind it — a
         *  falling cost is good, a falling revenue is not").
         *
         *  This field exists because `formatZodType` IGNORES `.describe()`:
         *  a hint attached to a zod field is printed nowhere and silently
         *  becomes dead weight. Anything expressible as a shape belongs in the
         *  zod (`Array<{ label: string, value: unknown }>` reads better than
         *  prose AND validates); `notes` is for the rest. */
        notes: s.record(s.string()),
        example: s.any(),
        /** Renderer/validator facts with no home in the stock catalog shape:
         *  which props name a dataset, which name a state key, which accept
         *  the `{ base, sm, md, lg }` form. Prop DEFAULTS deliberately live in
         *  the Vue components instead — a default is a rendering guarantee,
         *  and `withDefaults` is where a Vue reader looks for it. */
        meta: s.any(),
      }),
      actions: s.map({
        params: s.zod(),
        description: s.string(),
      }),
    }),
  }),
  {
    /**
     * REQUIRED, not a preference — see `prompt-template.ts`. json-render's
     * built-in generator hardcodes "include realistic sample data", a JSONL
     * streaming envelope and todo-app array guidance, none of it reachable
     * through `defaultRules` (which only append).
     */
    promptTemplate: renderPromptTemplate,
    /** Same list the prompt prints — one source, no chance of the two drifting. */
    builtInActions: [...BUILT_IN_ACTIONS],
    /**
     * Universally true — tree integrity and field placement. Both classes of
     * mistake are silent at author time and invisible at render time (a
     * dangling child key renders nothing; `visible` inside `props` is simply
     * ignored), which is why they are worth prompt budget.
     */
    defaultRules: [
      "Every key listed in an element's `children` MUST exist as its own entry in `elements`. A dangling key renders nothing at all — that whole branch silently disappears.",
      "Walk the tree from `root` before finishing: every child key must resolve. This is the single most common way a generated surface comes back half-empty.",
      "`visible`, `on`, `repeat` and `watch` are fields on the ELEMENT, siblings of `type`/`props`/`children` — never inside `props`. Placed inside `props` they are ignored, and the element renders unconditionally.",
      "Use only component types listed in the catalog. An unknown type renders as plain text.",
    ],
  },
);

export type ElementTreeSchema = typeof elementTreeSchema;
