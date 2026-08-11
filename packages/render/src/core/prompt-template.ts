import type { PromptContext } from "@json-render/core";
import { z } from "zod";
import { BINDING_DESCRIPTION } from "./binding";
import { BUILT_IN_ACTIONS } from "./built-in-actions";
import { SCALES } from "./scales";

/**
 * Our catalog → prompt generator.
 *
 * Overriding json-render's built-in generator is NOT a preference — it is
 * required. The stock generator hardcodes an authoring model that contradicts
 * ours, and none of it is reachable through `defaultRules` (which only append):
 *
 *   - "Include realistic sample data in state… Never leave arrays empty."
 *     A Fretik surface stores a QUESTION, not an answer. Its data arrives from
 *     server-side datasets on every view; inlined sample rows would be a frozen
 *     lie that survives into production.
 *   - A JSONL / RFC-6902 streaming envelope. Our agent hands a whole definition
 *     to a tool; patches are an EDIT mode, not the default output.
 *   - Todo-app guidance (pushState/removeState array editing) that no read-only
 *     dashboard needs, spending budget on a shape we do not generate.
 *
 * What is kept from the library is `formatZodType`, so the props printed here
 * are literally the schemas the registry is typed from — the drift this whole
 * package exists to prevent.
 *
 * SCALES ARE PRINTED ONCE. Inlining `color`'s 28 values on every component
 * that accepts one costs several KB across a full catalog; each component
 * refers to a scale by `@name` and the table is printed once at the top.
 */

/**
 * Value-signature → scale name, FIRST declaration wins.
 *
 * Several scales share a value list (`gap` and `pad` are both the spacing
 * steps). A last-wins map would print `gap?: @pad`, which reads as a mistake
 * even though the values match — so declaration order in `SCALES` decides, and
 * a prop named `gap` keeps showing `@gap`.
 */
const SCALE_BY_SIGNATURE = new Map<string, string>();
for (const [name, values] of Object.entries(SCALES)) {
  const signature = values.join("|");
  if (!SCALE_BY_SIGNATURE.has(signature)) {
    SCALE_BY_SIGNATURE.set(signature, name);
  }
}

/**
 * Collapse a rendered union back to its scale name when it matches one
 * exactly, recording the hit. `formatZodType` prints an enum as `"a" | "b"`,
 * so we compare on the bare values.
 *
 * Two-value enums are left inline: `"row" | "col"` is shorter than `@direction`
 * plus its line in the table.
 */
const collapseScales = (
  rendered: string,
  seen: Map<string, string>,
): string => {
  const enumPattern = /(?:"[^"]*"(?:\s\|\s)?)+/g;
  return rendered.replace(enumPattern, (match) => {
    const values = [...match.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
    if (values.length < 3) return match;
    const scaleName = SCALE_BY_SIGNATURE.get(values.join("|"));
    if (!scaleName) return match;
    seen.set(scaleName, values.join(" | "));
    return `@${scaleName}`;
  });
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const readString = (v: unknown, key: string): string | undefined => {
  if (!isRecord(v)) return undefined;
  const found = v[key];
  return typeof found === "string" ? found : undefined;
};

const readStringArray = (v: unknown, key: string): string[] => {
  if (!isRecord(v)) return [];
  const found = v[key];
  return Array.isArray(found)
    ? found.filter((x): x is string => typeof x === "string")
    : [];
};

export const renderPromptTemplate = (context: PromptContext): string => {
  const { catalog, componentNames, options, formatZodType } = context;
  const lines: string[] = [];

  if (options.system) {
    lines.push(options.system, "");
  }

  // Components are rendered FIRST, into a buffer: which scales they reference
  // decides which ones the scale table has to spell out. A catalog that never
  // uses `@ratio` should not pay for it.
  const referenced = new Map<string, string>();
  const componentLines: string[] = [];
  const components = isRecord(catalog) ? catalog["components"] : undefined;
  if (isRecord(components)) {
    let currentGroup: string | undefined;
    for (const [name, entry] of Object.entries(components)) {
      if (!isRecord(entry)) continue;

      // Entries may declare `meta.group`; when they do, they are printed under
      // that heading in declaration order. A catalog that declares none prints
      // as one flat list.
      const group = readString(entry["meta"], "group");
      if (group && group !== currentGroup) {
        componentLines.push(`### ${group}`);
        currentGroup = group;
      }

      // `props` is declared `s.zod()`, but the catalog type widens it back to
      // unknown — narrowed here rather than asserted.
      const propsSchema = entry["props"];
      const rendered =
        propsSchema instanceof z.ZodType
          ? collapseScales(formatZodType(propsSchema), referenced)
          : "{}";
      const slots = readStringArray(entry, "slots");
      const childSuffix = slots.includes("default") ? " {children}" : "";
      const description = readString(entry, "description") ?? "";
      componentLines.push(`· ${name}${childSuffix} — ${description}`);
      componentLines.push(`  props: ${rendered}`);

      // What the TYPE cannot say. `formatZodType` ignores `.describe()`, so
      // this is the ONLY channel for per-prop prose. One per line: several
      // notes joined on one line turn into a wall of semicolons, and the notes
      // themselves contain semicolons.
      const notes = entry["notes"];
      if (isRecord(notes)) {
        for (const [prop, note] of Object.entries(notes)) {
          if (typeof note === "string")
            componentLines.push(`  ${prop} = ${note}`);
        }
      }

      // Which events this component fires — without them `on` is unusable.
      const events = readStringArray(entry, "events");
      if (events.length > 0)
        componentLines.push(`  events: ${events.join(", ")}`);
    }
  }

  lines.push("## Scales", "");
  lines.push(
    "Closed value sets, referenced below as `@name`. Anything outside a scale is dropped and reported.",
    "",
  );
  for (const [name, values] of referenced) {
    lines.push(`@${name}: ${values}`);
  }
  lines.push("");

  lines.push(`## Components (${componentNames.length})`, "");
  lines.push(...componentLines, "");

  lines.push("## Actions", "");
  for (const builtIn of BUILT_IN_ACTIONS) {
    lines.push(`· ${builtIn.name} — ${builtIn.description}`);
  }
  const actions = isRecord(catalog) ? catalog["actions"] : undefined;
  if (isRecord(actions)) {
    for (const [name, entry] of Object.entries(actions)) {
      lines.push(`· ${name} — ${readString(entry, "description") ?? ""}`);
    }
  }
  lines.push(
    'Bind one with the element-level `on` field: `"on": { "click": { "action": "setState", "params": { … } } }`.',
    "",
  );

  // Printed unconditionally: this vocabulary is the RUNTIME's, not a
  // catalog's. `options.directives` cannot carry it — a `DirectiveDefinition`
  // requires a `resolve` function, which lives with the JSONata sandbox on the
  // other side of this package's dependency line.
  lines.push("## Dynamic values", "");
  lines.push(
    "Any prop takes one of these instead of a literal, so the value follows the data instead of being fixed at authoring time.",
    "",
    `· { "$": "<jsonata>" } — ${BINDING_DESCRIPTION}`,
    '· { "$state": "/path" } — read the viewer\'s current state.',
    '· { "$bindState": "/path" } — two-way binding, on the value prop of a control the viewer operates.',
  );
  for (const directive of options.directives ?? []) {
    lines.push(`· ${directive.name} — ${directive.description ?? ""}`);
  }
  lines.push("");

  if (options.customRules && options.customRules.length > 0) {
    lines.push("## Rules", "");
    for (const rule of options.customRules) lines.push(`- ${rule}`);
    lines.push("");
  }

  return lines.join("\n");
};
