import type { PageLintFinding } from "./types";
import { templateElements } from "./walk-template";

/**
 * `v-model` on a component whose model is NAMED.
 *
 * `<UPagination v-model="page">` compiles, mounts, renders every page number,
 * and does nothing when one is clicked: the component's model is `page`, so it
 * emits `update:page` and reads the `page` prop, while a bare `v-model` binds
 * `modelValue` — a prop it never reads and an event it never emits. The ref
 * stays at 1, the table never advances, and nothing anywhere reports it. Vue
 * does not warn on an unknown prop, the production build the runtime ships has
 * no warning strings at all, and the click-pass sees a control that responds to
 * being clicked. Measured 2026-09-04 on a generated page: 24 rows, a working
 * pager, page 2 unreachable.
 *
 * The list is DERIVED, not guessed — a component earns a line here when the
 * docs corpus says it emits `update:<something>` and never `update:modelValue`:
 *
 *   cd backend/packages/ai/src/tools/assets/nuxt-ui && for f in *.md; do
 *     emits=$(sed -n '/^### Emits/,/^### /p' "$f" | grep -oE "^  '?update:[A-Za-z]+")
 *     case "$emits" in *modelValue*) ;; *update:*) echo "$f: $emits";; esac
 *   done
 *
 * Re-run it after a Nuxt UI bump. A component absent from this map is not
 * asserted to take a bare `v-model` — it is simply not checked.
 */
const NAMED_MODEL: Record<string, string> = {
  UAlert: "open",
  UChatReasoning: "open",
  UChatTool: "open",
  UChip: "show",
  UCollapsible: "open",
  UContextMenu: "open",
  UDrawer: "open",
  UDropdownMenu: "open",
  UModal: "open",
  UPagination: "page",
  UPopover: "open",
  USlideover: "open",
  UTooltip: "open",
};

/** `<u-pagination>` and `<UPagination>` are the same component. */
const normalizeTag = (tag: string): string => {
  if (!tag.includes("-")) return tag;
  return tag
    .split("-")
    .map((part) => (part === "" ? "" : part[0]?.toUpperCase() + part.slice(1)))
    .join("");
};

/** A bare `v-model` — the directive with no argument after the colon. */
const hasBareModel = (props: unknown[]): boolean =>
  props.some((prop) => {
    if (typeof prop !== "object" || prop === null) return false;
    if (Reflect.get(prop, "name") !== "model") return false;
    const arg: unknown = Reflect.get(prop, "arg");
    return arg === undefined || arg === null;
  });

export const lintNamedModels = (
  path: string,
  source: string,
): PageLintFinding[] => {
  const findings: PageLintFinding[] = [];
  for (const element of templateElements(source)) {
    const model = NAMED_MODEL[normalizeTag(element.tag)];
    if (model === undefined) continue;
    if (!hasBareModel(element.props)) continue;
    findings.push({
      rule: "named-model",
      severity: "error",
      path,
      line: element.line,
      message: `<${element.tag} v-model="…"> is bound to nothing: this component's model is \`${model}\`, so it emits \`update:${model}\` and never \`update:modelValue\`. Write \`v-model:${model}="…"\`.`,
    });
  }
  return findings;
};
