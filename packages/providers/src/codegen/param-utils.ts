import type { ParamSpec } from "@fretik/shared/external-apps/manifest-schema";

/**
 * Shared codegen helpers — verbatim from the original `generate-sdk.ts`,
 * relocated so both the Python-SDK and SKILL emitters can share them.
 * Pure functions, no IO. Changing any of these changes the generated
 * output byte-for-byte, so the CI diff-check guards them.
 */

/**
 * Convert a manifest key (kebab-case) to a Python-safe module name
 * (snake_case). The FQ action name sent in dispatch requests keeps the
 * original kebab-case key — only the generated Python module + filename
 * use this transform.
 */
export const pyModuleName = (key: string): string => key.replace(/-/g, "_");

export const camelToPascal = (s: string): string =>
  s
    .split(/[_\s]/)
    .map((p) => (p.length === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");

export const pyStr = (value: string): string => JSON.stringify(value);

/** Map a manifest `ParamSpec` to a Python type expression. */
export const pyType = (spec: ParamSpec): string => {
  switch (spec.type) {
    case "string":
    case "email":
    case "datetime":
      return "str";
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "enum": {
      if (spec.values === undefined || spec.values.length === 0) return "str";
      return `Literal[${spec.values.map((v) => pyStr(v)).join(", ")}]`;
    }
    case "array":
      return `list[${spec.items !== undefined ? pyType(spec.items) : "Any"}]`;
    case "object":
      return "dict[str, Any]";
    default: {
      const exhaustive: never = spec.type;
      throw new Error(`Unknown param type: ${String(exhaustive)}`);
    }
  }
};

export const pyDefault = (spec: ParamSpec): string => {
  if (spec.default !== undefined) {
    if (typeof spec.default === "string") return pyStr(spec.default);
    if (typeof spec.default === "boolean")
      return spec.default ? "True" : "False";
    if (typeof spec.default === "number") return spec.default.toString();
    return JSON.stringify(spec.default);
  }
  // `optional: true` without explicit default → None.
  return "None";
};

export const isOptional = (spec: ParamSpec): boolean =>
  spec.optional === true || spec.default !== undefined;

export const pyAnnotation = (spec: ParamSpec): string => {
  const base = pyType(spec);
  return isOptional(spec) ? `${base} | None` : base;
};

/** Order params: required first (no default), then optional (with default). */
export const sortedParamEntries = (
  params: Record<string, ParamSpec>,
): [string, ParamSpec][] => {
  const entries = Object.entries(params);
  return entries.sort(([, a], [, b]) => {
    const aOpt = isOptional(a) ? 1 : 0;
    const bOpt = isOptional(b) ? 1 : 0;
    return aOpt - bOpt;
  });
};

export const indent = (text: string, spaces: number): string => {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
};

/**
 * Escape backslashes for safe inclusion inside a Python triple-quoted
 * docstring. Manifest summaries / descriptions may legitimately contain
 * `\Seen`, `\Sent`, RFC 6154 flags etc. — left raw, Python 3.6+ emits a
 * `SyntaxWarning: invalid escape sequence` because `\S`, `\T`, … are
 * unknown escapes. Doubling every backslash renders identically (the
 * docstring still says `\Seen` when printed) and silences the warning.
 */
export const escapeForPyDocstring = (s: string): string =>
  s.replace(/\\/g, "\\\\");
