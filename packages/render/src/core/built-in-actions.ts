/**
 * Actions the runtime always provides, whatever the catalog.
 *
 * They are handled by the Vue `ActionProvider`, so they need no handler in a
 * registry — but the agent has to know they exist. Declared here rather than
 * in `schema.ts` because both the schema and the prompt generator read them,
 * and `PromptContext` does not carry them.
 */
export const BUILT_IN_ACTIONS = [
  {
    name: "setState",
    description:
      "Write a value into the state model. Params: { statePath, value }. This is how a control changes what the surface shows.",
  },
  {
    name: "pushState",
    description:
      "Append an item to an array in state. Params: { statePath, value }.",
  },
  {
    name: "removeState",
    description:
      "Remove an item from an array in state by index. Params: { statePath, index }.",
  },
] as const;
