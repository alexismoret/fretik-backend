import { z } from "zod";
import { BREAKPOINTS, isDynamicValue, isResponsiveValue } from "./binding";

/**
 * Per-component prop validation.
 *
 * The library cannot do this: `propsOf` collapses to `z.record(string, unknown)`
 * as soon as a catalog holds more than one component, so `catalog.validate()`
 * accepts any prop bag on any element. It checks the TREE; this checks the
 * PROPS. Both are needed.
 *
 * Three things it must get right, none of which a plain `schema.parse()` does:
 *
 * - **A bound value is unknowable, AT ANY DEPTH.** `{ "$": "…" }` resolves at
 *   render time, so it passes through untouched — and it is legal wherever a
 *   value is legal, including inside an array of items. Checking only the top
 *   level looks right until an author writes
 *   `items: [{ label: "Stage", value: { "$": "item.stage" } }]`, whose whole
 *   `items` prop then fails a literal parse and is silently dropped.
 * - **A responsive prop is a wrapper.** `{ base: "1", md: "3" }` is checked
 *   branch by branch, and only where the component declares the prop
 *   responsive.
 * - **Numeric-string scales.** A model writes `span: 4` where the scale is
 *   `"4"`. Coerced rather than dropped — the intent is unambiguous.
 *
 * Everything invalid is DROPPED and reported. A page renders with one prop
 * missing; it does not fail to save. Completeness is enforced at publish.
 */

export interface PropIssue {
  /** Absent when the issue is about the element rather than one prop. */
  prop?: string;
  /** Agent-facing, self-contained. The caller prefixes the element id. */
  message: string;
}

export interface PropValidation {
  props: Record<string, unknown>;
  issues: PropIssue[];
}

export type PropValidator = (
  type: string,
  props: Record<string, unknown> | undefined,
) => PropValidation;

interface PropSpec {
  /** Binding-tolerant, for validation. */
  schema: z.ZodType;
  /** Binding-tolerant, unwrapped — validates one responsive branch. */
  base: z.ZodType;
  /** The literal schema, unwrapped — enum introspection and coercion. */
  scale: z.ZodType;
  responsive: boolean;
}

/**
 * Anything resolved at render time: our `{ "$": … }` and json-render's native
 * forms. Typed as `unknown` because that is exactly what is known about it.
 */
const dynamicValueSchema = z.custom<unknown>(isDynamicValue);

/**
 * A copy of a schema that accepts a dynamic value in place of ANY value inside
 * it — one leaf, one array entry, one field of one item.
 *
 * Built here rather than written into the catalog because the catalog's schemas
 * are also what the agent READS: spelling the binding form into every prop
 * would print `text: string | { $: string } | { $state: string }` 48 times, and
 * the binding grammar is already documented once under "Dynamic values". The
 * prompt keeps the literal schema; validation uses this one.
 *
 * Object branches strip unknown keys, which costs nothing: the validator keeps
 * the ORIGINAL value and only reads whether the parse succeeded.
 */
const bindingTolerant = (schema: z.ZodType): z.ZodType => {
  if (schema instanceof z.ZodOptional) {
    const inner: unknown = schema.unwrap();
    if (inner instanceof z.ZodType) return bindingTolerant(inner).optional();
  }
  if (schema instanceof z.ZodNullable) {
    const inner: unknown = schema.unwrap();
    if (inner instanceof z.ZodType) return bindingTolerant(inner).nullable();
  }
  if (schema instanceof z.ZodArray) {
    const element: unknown = schema.element;
    if (element instanceof z.ZodType) {
      return z.union([z.array(bindingTolerant(element)), dynamicValueSchema]);
    }
  }
  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = {};
    for (const [name, value] of Object.entries(shapeOf(schema))) {
      shape[name] = bindingTolerant(value);
    }
    return z.union([z.object(shape), dynamicValueSchema]);
  }
  return z.union([schema, dynamicValueSchema]);
};

/** Strip `optional` / `nullable` down to the schema that carries the values. */
const unwrap = (schema: z.ZodType): z.ZodType => {
  let current: z.ZodType = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    const inner: unknown = current.unwrap();
    if (!(inner instanceof z.ZodType)) return current;
    current = inner;
  }
  return current;
};

const enumOptions = (schema: z.ZodType): string[] | undefined =>
  schema instanceof z.ZodEnum
    ? Object.values(schema.enum).filter(
        (v): v is string => typeof v === "string",
      )
    : undefined;

const readResponsive = (meta: unknown): Set<string> => {
  if (typeof meta !== "object" || meta === null) return new Set();
  const declared: unknown = Reflect.get(meta, "responsive");
  if (!Array.isArray(declared)) return new Set();
  return new Set(declared.filter((v): v is string => typeof v === "string"));
};

/**
 * A component's props, prop name → schema.
 *
 * `ZodObject["shape"]` is typed `any` per key on a bare `z.ZodObject`, so each
 * value is narrowed rather than trusted. Exported: the catalog's own invariant
 * tests need the same view.
 */
export const shapeOf = (schema: z.ZodType): Record<string, z.ZodType> => {
  if (!(schema instanceof z.ZodObject)) return {};
  const shape: Record<string, z.ZodType> = {};
  for (const [name, value] of Object.entries(schema.shape)) {
    if (value instanceof z.ZodType) shape[name] = value;
  }
  return shape;
};

const specsFor = (
  props: z.ZodType,
  meta: unknown,
  common: Map<string, PropSpec>,
): Map<string, PropSpec> => {
  const specs = new Map(common);
  const responsive = readResponsive(meta);
  for (const [name, schema] of Object.entries(shapeOf(props))) {
    specs.set(name, {
      schema: bindingTolerant(schema),
      base: bindingTolerant(unwrap(schema)),
      scale: unwrap(schema),
      responsive: responsive.has(name),
    });
  }
  return specs;
};

/**
 * `span: 4` where the scale is `"4"`. Only ever tightens a number into a
 * string the enum already accepts.
 */
const coerce = (spec: PropSpec, value: unknown): unknown => {
  if (typeof value !== "number") return value;
  const options = enumOptions(spec.scale);
  if (!options) return value;
  const asText = String(value);
  return options.includes(asText) ? asText : value;
};

/**
 * Follow a Zod issue tree down to the leaf that actually says something.
 *
 * Every prop is validated against a binding-tolerant schema, which is a union
 * — and a failed union reports a bare `Invalid input` with an empty path,
 * hiding the one fact worth having. The branch errors carry the real location,
 * so descend the FIRST branch (the literal shape; the other is `{ "$": … }`)
 * and accumulate the path on the way down.
 */
const deepestIssue = (
  issues: readonly z.core.$ZodIssue[],
  prefix: PropertyKey[] = [],
): { path: PropertyKey[]; message: string } | undefined => {
  const [first] = issues;
  if (!first) return undefined;
  const path = [...prefix, ...first.path];
  if (first.code === "invalid_union") {
    const [branch] = first.errors;
    if (branch) return deepestIssue(branch, path);
  }
  return { path, message: first.message };
};

const checkLiteral = (
  spec: PropSpec,
  schema: z.ZodType,
  name: string,
  value: unknown,
): PropIssue | undefined => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return undefined;
  const options = enumOptions(spec.scale);
  if (options) {
    return {
      prop: name,
      message: `dropped prop "${name}" — expected one of ${options.join("|")}, got ${JSON.stringify(value)}`,
    };
  }
  // "wrong type" left the agent to guess WHICH side was wrong, and — for a prop
  // holding a list of objects — WHICH entry. Both are one issue-tree walk away,
  // and for a list the entry index is the whole answer.
  const issue = deepestIssue(parsed.error.issues);
  const where =
    issue && issue.path.length > 0
      ? ` at ${issue.path.map((step) => String(step)).join("/")}`
      : "";
  // Zod prefixes every type message with "Invalid input: ", which restates what
  // "dropped prop" already said.
  const detail = (issue?.message ?? "").replace(/^Invalid input:?\s*/, "");
  return {
    prop: name,
    message: `dropped prop "${name}"${where} — ${detail === "" ? "wrong type" : detail}`,
  };
};

/**
 * Build the validator once from a catalog's components, then call it per
 * element. The shapes are read at construction time; nothing is re-derived per
 * node.
 *
 * `common` are the props every component accepts (grid placement, self
 * spacing). They live outside the component schemas on purpose: repeating them
 * across 48 entries would print them 48 times in the prompt.
 */
export const createPropValidator = (
  components: Record<string, { props: z.ZodType; meta?: unknown }>,
  common: z.ZodObject,
  commonResponsive: readonly string[] = [],
): PropValidator => {
  const commonSpecs = specsFor(
    common,
    { responsive: commonResponsive },
    new Map(),
  );
  const byType = new Map<string, Map<string, PropSpec>>();
  for (const [type, entry] of Object.entries(components)) {
    byType.set(type, specsFor(entry.props, entry.meta, commonSpecs));
  }

  return (type, props) => {
    const specs = byType.get(type);
    if (!specs) {
      return {
        props: {},
        issues: [{ message: `unknown component type "${type}"` }],
      };
    }

    const kept: Record<string, unknown> = {};
    const issues: PropIssue[] = [];

    for (const [name, raw] of Object.entries(props ?? {})) {
      const spec = specs.get(name);
      if (!spec) {
        issues.push({ prop: name, message: `dropped unknown prop "${name}"` });
        continue;
      }

      // Resolved at render time — its type cannot be known here.
      if (isDynamicValue(raw)) {
        kept[name] = raw;
        continue;
      }

      if (isResponsiveValue(raw)) {
        if (!spec.responsive) {
          issues.push({
            prop: name,
            message: `dropped prop "${name}" — it takes one value, not a responsive object`,
          });
          continue;
        }
        const branches: Record<string, unknown> = {};
        let broken: PropIssue | undefined;
        for (const breakpoint of BREAKPOINTS) {
          const inner = raw[breakpoint];
          if (inner === undefined) continue;
          if (isDynamicValue(inner)) {
            branches[breakpoint] = inner;
            continue;
          }
          const coerced = coerce(spec, inner);
          broken ??= checkLiteral(spec, spec.base, name, coerced);
          if (broken) break;
          branches[breakpoint] = coerced;
        }
        if (broken) issues.push(broken);
        else kept[name] = branches;
        continue;
      }

      const value = coerce(spec, raw);
      const issue = checkLiteral(spec, spec.schema, name, value);
      if (issue) issues.push(issue);
      else kept[name] = value;
    }

    return { props: kept, issues };
  };
};
