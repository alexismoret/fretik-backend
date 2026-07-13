import type { ToolSet } from "ai";
import type {
  ChatbotToolCategory,
  SearchableToolRegistry,
} from "./chatbot-tool";
import type { AgentRuntimeContext } from "./runtime-context";

/**
 * Shared Progressive-Disclosure tool-menu computation for the chatbot and
 * workflow agents. Both expose the same core+activated model — a small set of
 * always-on `core` tools plus the `domain` tools the `DynamicToolManager` has
 * activated so far — differing only in their gates (the chatbot suppresses the
 * web tools when disabled; the workflow withholds writes by autonomy mode).
 * The shells stay concrete (the workflow also injects a re-anchor message and
 * every step returns `toolsContext` via `buildToolsContext` at the concrete
 * site — see `agent-builder.ts`); this module owns only the name arithmetic.
 */

/** Minimal shape these helpers read off each tool — `buildChatbotTool` fills it. */
type CategorizedToolSet = Record<string, { category: ChatbotToolCategory }>;

/** No-op suppressor — the default when a caller has no gate to apply. */
const suppressNone = (): boolean => false;

/**
 * Names of the `core` tools in a set, minus any the caller suppresses (the
 * chatbot's web-tool gate). Precompute once per agent instance — the registry
 * is immutable at runtime, so there is no point re-filtering it every step.
 */
export const computeCoreToolNames = <TTools extends CategorizedToolSet>(
  tools: TTools,
  suppress: (name: string) => boolean = suppressNone,
): (keyof TTools)[] => {
  const isToolName = (name: string): name is keyof TTools & string =>
    name in tools;
  const result: (keyof TTools)[] = [];
  for (const [name, t] of Object.entries(tools)) {
    if (t.category === "core" && isToolName(name) && !suppress(name)) {
      result.push(name);
    }
  }
  return result;
};

/**
 * The `activeTools` list for a single step: the precomputed core names plus
 * every domain tool the `DynamicToolManager` has activated so far, minus an
 * optional `hidden` gate (the workflow's autonomy write-gate). Recomputed every
 * step — omitting it would fall back to the initial menu and the model would
 * stop seeing newly activated tools.
 */
export const progressiveActiveTools = <TTools extends ToolSet>(
  ctx: AgentRuntimeContext,
  tools: TTools,
  coreNames: (keyof TTools)[],
  hidden?: ReadonlySet<string>,
): (keyof TTools)[] => {
  const isToolName = (name: string): name is keyof TTools & string =>
    name in tools;
  const activated = ctx.dynamicToolManager.getSnapshot().filter(isToolName);
  const active = [...coreNames, ...activated];
  return hidden === undefined
    ? active
    : active.filter((n) => !hidden.has(String(n)));
};

/**
 * Filter a tool set down to the `{ name → SearchableTool }` registry the prompt
 * renderer consumes for the `{{deferredToolList}}` placeholder — the
 * `category === "domain"` tools, minus any the caller suppresses. Memoized per
 * tool-set reference: the set is built once at agent construction and never
 * mutated, so the first call filters and the per-turn prompt renders hit the
 * cache. Shared by chatbot + workflow (distinct set references → distinct keys).
 */
type DescribableToolSet = Record<
  string,
  SearchableToolRegistry[string] & { category: ChatbotToolCategory }
>;
const domainRegistryCache = new WeakMap<object, SearchableToolRegistry>();
export const pickDomainRegistry = (
  tools: DescribableToolSet,
  suppress: (name: string) => boolean = suppressNone,
): SearchableToolRegistry => {
  const cached = domainRegistryCache.get(tools);
  if (cached) return cached;
  const domainTools: SearchableToolRegistry = {};
  for (const [name, t] of Object.entries(tools)) {
    if (t.category === "domain" && !suppress(name)) {
      domainTools[name] = {
        description: t.description,
        searchHint: t.searchHint,
        category: t.category,
      };
    }
  }
  domainRegistryCache.set(tools, domainTools);
  return domainTools;
};
