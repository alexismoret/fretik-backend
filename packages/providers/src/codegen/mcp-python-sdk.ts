import type {
  ExternalAppDescriptor,
  ExternalAppDescriptorAction,
} from "@fretik/shared/schemas/external-app-descriptor";
import {
  camelToPascal,
  escapeForPyDocstring,
  indent,
  pyModuleName,
  pyStr,
} from "./param-utils";

/**
 * High-fidelity MCP tool compiler: JSON Schema (draft-07) → Pydantic.
 *
 * MCP `inputSchema`s are far richer than the manifest `ParamSpec` IR (bounds,
 * patterns, `multipleOf`, nested objects, unions, per-param descriptions), and
 * the MCP server enforces every one of them — so routing MCP through the lossy
 * `ParamSpec` made the agent guess (`page_size=50`, `query_type="page"`) and
 * hit avoidable server errors. This compiler renders the schema faithfully to a
 * typed, self-validating Pydantic model + signature, so a bad call fails
 * LOCALLY with a precise Pydantic message before it ever reaches the server,
 * and the agent sees the exact allowed values / bounds in the SKILL.
 *
 * Not a full JSON-Schema engine: it maps the keywords MCP servers actually use
 * (type, enum, const, minimum/maximum/exclusive*, multipleOf, minLength/
 * maxLength, pattern, minItems/maxItems, properties, items, anyOf/oneOf,
 * required, default, description) and degrades any unrecognised construct to a
 * permissive `Any`/`dict[str, Any]` — never a false rejection, never invalid
 * Python.
 */

// ── JSON helpers ──────────────────────────────────────────────────────

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asStr = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

const asNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Primary non-null `type` (handles the `["string","null"]` union spelling). */
const primaryType = (node: Record<string, unknown>): string | undefined => {
  const t = node.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    return t.find((x): x is string => typeof x === "string" && x !== "null");
  }
  return undefined;
};

const typeAllowsNull = (node: Record<string, unknown>): boolean =>
  Array.isArray(node.type) && node.type.includes("null");

/** Render a JSON scalar as a Python literal (for `Literal[...]` / defaults). */
const pyLiteral = (v: unknown): string => {
  if (v === null) return "None";
  if (typeof v === "string") return pyStr(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return v.toString();
  // Objects/arrays as defaults are rare and can't be a safe inline literal.
  return "None";
};

const PY_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

/**
 * Field names that shadow a Pydantic `BaseModel` attribute/method — using them
 * raw triggers a runtime warning and can mask the real value. Renamed with a
 * trailing `_` (standard Python convention) + an `alias` back to the wire name.
 */
const PYDANTIC_RESERVED = new Set([
  "schema",
  "dict",
  "json",
  "copy",
  "validate",
  "construct",
  "fields",
  "config",
  "parse_obj",
  "parse_raw",
  "parse_file",
  "from_orm",
  "update_forward_refs",
]);

/** A schema property name → a valid Python identifier (+ whether it changed). */
const toIdent = (raw: string): { ident: string; changed: boolean } => {
  let ident = raw.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(ident)) ident = `_${ident}`;
  if (ident.length === 0) ident = "_field";
  if (
    PY_KEYWORDS.has(ident) ||
    PYDANTIC_RESERVED.has(ident) ||
    ident.startsWith("model_")
  ) {
    ident = `${ident}_`;
  }
  return { ident, changed: ident !== raw };
};

/** Collapse whitespace, strip triple-quotes, cap length — safe in a docstring. */
const oneLine = (s: string, max = 300): string => {
  const flat = s.replace(/\s+/g, " ").replace(/"""/g, "'''").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * Best-effort ECMAScript→Python spelling fixes for the two regex constructs
 * that differ AND are safely translatable: named groups `(?<n>…)` → `(?P<n>…)`
 * and named backreferences `\k<n>` → `(?P=n)`. Lookbehind (`(?<=`, `(?<!`) is
 * identical in both engines and left untouched. This only has to cover the
 * common cases so their constraint survives — anything still Python-incompatible
 * is caught at runtime by `_safe_pattern` (degrades to no constraint), so it
 * never has to be exhaustive and can never emit a crashing pattern.
 */
const toPythonRegex = (pattern: string): string =>
  pattern
    .replace(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g, "(?P<$1>")
    .replace(/\\k<([A-Za-z_][A-Za-z0-9_]*)>/g, "(?P=$1)");

// ── Compile context + types ───────────────────────────────────────────

interface CompileCtx {
  nested: string[];
  usedModelNames: Set<string>;
}

interface CompiledType {
  annotation: string;
  nullable: boolean;
  /** Compact human type for the SKILL, e.g. `"a"|"b"`, `list[str]`, `object`. */
  human: string;
}

interface CompiledField {
  pyName: string;
  present: boolean;
  hasAlias: boolean;
  modelLine: string;
  sigParam: string;
  kwarg: string;
  docLine: string;
  skillLine: string;
}

const uniqueModelName = (hint: string, ctx: CompileCtx): string => {
  const base = camelToPascal(hint) || "Model";
  let name = base;
  let i = 2;
  while (ctx.usedModelNames.has(name)) {
    name = `${base}${i.toString()}`;
    i += 1;
  }
  ctx.usedModelNames.add(name);
  return name;
};

// ── Type compilation ──────────────────────────────────────────────────

const compileType = (
  raw: unknown,
  nameHint: string,
  ctx: CompileCtx,
  depth: number,
): CompiledType => {
  if (depth > 6 || !isRec(raw)) {
    return { annotation: "Any", nullable: false, human: "any" };
  }

  if ("const" in raw) {
    return {
      annotation: `Literal[${pyLiteral(raw.const)}]`,
      nullable: raw.const === null,
      human: String(raw.const),
    };
  }

  if (Array.isArray(raw.enum) && raw.enum.length > 0) {
    const hasNull = raw.enum.includes(null);
    const scalars = raw.enum.filter(
      (v): v is string | number | boolean =>
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean",
    );
    if (
      scalars.length > 0 &&
      scalars.length === raw.enum.length - (hasNull ? 1 : 0)
    ) {
      return {
        annotation: `Literal[${scalars.map(pyLiteral).join(", ")}]`,
        nullable: hasNull,
        human: scalars
          .map((v) => (typeof v === "string" ? `"${v}"` : String(v)))
          .join("|"),
      };
    }
    return { annotation: "Any", nullable: hasNull, human: "any" };
  }

  const combo = Array.isArray(raw.anyOf)
    ? raw.anyOf
    : Array.isArray(raw.oneOf)
      ? raw.oneOf
      : undefined;
  if (combo !== undefined) {
    const nullable = combo.some((s) => isRec(s) && s.type === "null");
    const nonNull = combo.filter((s) => !(isRec(s) && s.type === "null"));
    if (nonNull.length === 0) {
      return { annotation: "Any", nullable: true, human: "any" };
    }
    if (nonNull.length === 1) {
      const inner = compileType(nonNull[0], nameHint, ctx, depth + 1);
      return {
        annotation: inner.annotation,
        nullable: nullable || inner.nullable,
        human: inner.human,
      };
    }
    const parts = nonNull.map((s, i) =>
      compileType(s, `${nameHint}${(i + 1).toString()}`, ctx, depth + 1),
    );
    return {
      annotation: parts.map((p) => p.annotation).join(" | "),
      nullable,
      human: parts.map((p) => p.human).join("|"),
    };
  }

  const nullable = typeAllowsNull(raw);
  switch (primaryType(raw)) {
    case "string":
      return { annotation: "str", nullable, human: "str" };
    case "integer":
      return { annotation: "int", nullable, human: "int" };
    case "number":
      return { annotation: "float", nullable, human: "float" };
    case "boolean":
      return { annotation: "bool", nullable, human: "bool" };
    case "null":
      return { annotation: "None", nullable: true, human: "null" };
    case "array": {
      const item = compileType(raw.items, `${nameHint}Item`, ctx, depth + 1);
      return {
        annotation: `list[${item.annotation}]`,
        nullable,
        human: `list[${item.human}]`,
      };
    }
    case "object":
    default: {
      if (isRec(raw.properties)) {
        const model = compileObjectModel(
          raw,
          uniqueModelName(nameHint, ctx),
          ctx,
          depth,
        );
        return { annotation: model, nullable, human: "object" };
      }
      // Free-form object / unknown construct → permissive.
      return {
        annotation: primaryType(raw) === "object" ? "dict[str, Any]" : "Any",
        nullable,
        human: "object",
      };
    }
  }
};

// ── Field constraints → Pydantic Field(...) + human hints ─────────────

const extractConstraints = (
  node: Record<string, unknown>,
  baseAnnotation: string,
): { args: string[]; human: string[] } => {
  const args: string[] = [];
  const human: string[] = [];
  const isNum = baseAnnotation === "int" || baseAnnotation === "float";
  const isStr = baseAnnotation === "str";
  const isList = baseAnnotation.startsWith("list[");

  if (isNum) {
    const min = asNum(node.minimum);
    const max = asNum(node.maximum);
    const exMin = asNum(node.exclusiveMinimum);
    const exMax = asNum(node.exclusiveMaximum);
    const mult = asNum(node.multipleOf);
    if (min !== undefined) {
      args.push(`ge=${min.toString()}`);
      human.push(`>=${min.toString()}`);
    }
    if (max !== undefined) {
      args.push(`le=${max.toString()}`);
      human.push(`<=${max.toString()}`);
    }
    if (exMin !== undefined) {
      args.push(`gt=${exMin.toString()}`);
      human.push(`>${exMin.toString()}`);
    }
    if (exMax !== undefined) {
      args.push(`lt=${exMax.toString()}`);
      human.push(`<${exMax.toString()}`);
    }
    // Pydantic rejects multiple_of <= 0 at class definition — drop it rather
    // than crash the module import on a malformed schema.
    if (mult !== undefined && mult > 0) {
      args.push(`multiple_of=${mult.toString()}`);
      human.push(`multiple of ${mult.toString()}`);
    }
  }
  if (isStr) {
    const minLen = asNum(node.minLength);
    const maxLen = asNum(node.maxLength);
    const pattern = asStr(node.pattern);
    if (minLen !== undefined && minLen >= 0) {
      args.push(`min_length=${minLen.toString()}`);
      human.push(`>=${minLen.toString()} chars`);
    }
    if (maxLen !== undefined && maxLen >= 0) {
      args.push(`max_length=${maxLen.toString()}`);
      human.push(`<=${maxLen.toString()} chars`);
    }
    if (pattern !== undefined) {
      // The pattern is an ECMAScript regex. `_safe_pattern` compiles it in
      // Python at import and degrades to no constraint if `re` rejects it, so
      // a JS-only construct can never crash the module. The human hint keeps
      // the original so the agent still sees the intended format.
      args.push(`pattern=_safe_pattern(${pyStr(toPythonRegex(pattern))})`);
      human.push(`pattern ${pattern}`);
    }
  }
  if (isList) {
    const minItems = asNum(node.minItems);
    const maxItems = asNum(node.maxItems);
    if (minItems !== undefined && minItems >= 0) {
      args.push(`min_length=${minItems.toString()}`);
      human.push(`>=${minItems.toString()} items`);
    }
    if (maxItems !== undefined && maxItems >= 0) {
      args.push(`max_length=${maxItems.toString()}`);
      human.push(`<=${maxItems.toString()} items`);
    }
  }
  return { args, human };
};

// ── Field + object-model compilation ──────────────────────────────────

const compileFields = (
  schema: Record<string, unknown>,
  baseName: string,
  ctx: CompileCtx,
  depth: number,
): CompiledField[] => {
  const props = isRec(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((v): v is string => typeof v === "string")
      : [],
  );

  const fields: CompiledField[] = [];
  for (const [rawName, propRaw] of Object.entries(props)) {
    const prop = isRec(propRaw) ? propRaw : {};
    const compiled = compileType(
      propRaw,
      `${baseName}${camelToPascal(rawName)}`,
      ctx,
      depth,
    );
    const present = required.has(rawName);
    const { ident, changed } = toIdent(rawName);
    const optional = !present;
    const wrapNone =
      (compiled.nullable || optional) && compiled.annotation !== "Any";
    const annotation = wrapNone
      ? `${compiled.annotation} | None`
      : compiled.annotation;

    const { args: constraintArgs, human } = extractConstraints(
      prop,
      compiled.annotation,
    );
    if (changed) constraintArgs.push(`alias=${pyStr(rawName)}`);

    const description = asStr(prop.description);
    const defaultExpr = "default" in prop ? pyLiteral(prop.default) : "None";
    const hasField = constraintArgs.length > 0;

    let modelLine: string;
    if (present) {
      modelLine = hasField
        ? `${ident}: ${annotation} = Field(..., ${constraintArgs.join(", ")})`
        : `${ident}: ${annotation}`;
    } else {
      modelLine = hasField
        ? `${ident}: ${annotation} = Field(${defaultExpr}, ${constraintArgs.join(", ")})`
        : `${ident}: ${annotation} = ${defaultExpr}`;
    }

    const sigParam = present
      ? `${ident}: ${annotation}`
      : `${ident}: ${annotation} = ${defaultExpr}`;

    const docFlags = [present ? "required" : "optional", ...human];
    const docLine =
      ident +
      (changed ? ` (wire: ${rawName})` : "") +
      (description ? `: ${oneLine(description, 220)}` : ":") +
      ` [${docFlags.join(", ")}]`;

    const skillFlags = [
      compiled.human,
      present ? "required" : "optional",
      ...human,
    ];
    const skillLine =
      `  - \`${ident}\` (${skillFlags.join(", ")})` +
      (description ? ` — ${oneLine(description, 200)}` : "");

    fields.push({
      pyName: ident,
      present,
      hasAlias: changed,
      modelLine,
      sigParam,
      kwarg: `${ident}=${ident}`,
      docLine,
      skillLine,
    });
  }

  // Required (no default) first — Python forbids a non-default param after a
  // defaulted one, and Pydantic wants the same ordering to read cleanly.
  return fields.sort((a, b) =>
    a.present === b.present ? 0 : a.present ? -1 : 1,
  );
};

const compileObjectModel = (
  schema: Record<string, unknown>,
  modelName: string,
  ctx: CompileCtx,
  depth: number,
): string => {
  const fields = compileFields(schema, modelName, ctx, depth + 1);
  const lines: string[] = [`class ${modelName}(BaseModel):`];
  if (fields.some((f) => f.hasAlias)) {
    lines.push("    model_config = ConfigDict(populate_by_name=True)");
  }
  if (fields.length === 0) {
    lines.push("    pass");
  } else {
    for (const f of fields) lines.push(`    ${f.modelLine}`);
  }
  ctx.nested.push(lines.join("\n"));
  return modelName;
};

// ── Per-action + module assembly ──────────────────────────────────────

interface CompiledAction {
  action: ExternalAppDescriptorAction;
  argsModelName: string;
  fields: CompiledField[];
  hasAlias: boolean;
}

const emitArgsModel = (a: CompiledAction): string => {
  const lines: string[] = [`class ${a.argsModelName}(BaseModel):`];
  if (a.hasAlias) {
    lines.push("    model_config = ConfigDict(populate_by_name=True)");
  }
  if (a.fields.length === 0) {
    lines.push("    pass");
  } else {
    for (const f of a.fields) lines.push(`    ${f.modelLine}`);
  }
  return lines.join("\n");
};

const emitDocstring = (a: CompiledAction, isWrite: boolean): string => {
  const lines = [`"""${escapeForPyDocstring(oneLine(a.action.summary, 300))}`];
  if (isWrite) {
    lines.push("");
    lines.push("(WRITE — requires user approval. Raises ApprovalPending");
    lines.push("until the user grants the plan.)");
  }
  if (a.fields.length > 0) {
    lines.push("");
    for (const f of a.fields) lines.push(escapeForPyDocstring(f.docLine));
  }
  lines.push("");
  lines.push(
    "connection_id: pick a specific connection when several exist for this",
  );
  lines.push("provider. Pass the ID surfaced in the agent context.");
  lines.push('"""');
  return indent(lines.join("\n"), 4);
};

const emitSignature = (name: string, a: CompiledAction): string => {
  const parts = a.fields.map((f) => f.sigParam);
  parts.push("connection_id: str | None = None");
  return `def ${name}(\n    ${parts.join(",\n    ")},\n) -> dict[str, Any]:`;
};

const emitArgsExpr = (a: CompiledAction): string => {
  const kwargs = a.fields.map((f) => f.kwarg).join(", ");
  return `${a.argsModelName}(${kwargs}).model_dump(by_alias=True, exclude_none=True)`;
};

const emitReadFn = (a: CompiledAction, key: string): string =>
  [
    emitSignature(a.action.name, a),
    emitDocstring(a, false),
    `    _args = ${emitArgsExpr(a)}`,
    `    if connection_id is not None:`,
    `        _args["connection_id"] = connection_id`,
    `    return _call_read(${pyStr(`${key}.${a.action.name}`)}, _args)`,
  ].join("\n");

const emitWriteFns = (a: CompiledAction, key: string): string => {
  const opName = `_${a.action.name}_op`;
  const opParts = a.fields.map((f) => f.sigParam);
  opParts.push("connection_id: str | None = None");
  const opSig = `def ${opName}(\n    ${opParts.join(",\n    ")},\n) -> Operation:`;
  const opFn = [
    opSig,
    indent(
      `"""Build a ${a.action.name} Operation (does NOT execute).\nUse inside run_plan([...])."""`,
      4,
    ),
    `    _args = ${emitArgsExpr(a)}`,
    `    if connection_id is not None:`,
    `        _args["connection_id"] = connection_id`,
    `    return Operation(action=${pyStr(`${key}.${a.action.name}`)}, args=_args)`,
  ].join("\n");

  const callFn = [
    emitSignature(a.action.name, a),
    emitDocstring(a, true),
    `    op = ${opName}(`,
    ...a.fields.map((f) => `        ${f.kwarg},`),
    `        connection_id=connection_id,`,
    `    )`,
    `    result = run_plan([op])`,
    `    if not result or not result[0].get("ok"):`,
    `        raise FretikActionError(result[0].get("error", "${a.action.name} failed"))`,
    `    return result[0].get("data", {})`,
  ].join("\n");

  return [opFn, "", callFn, "", `${a.action.name}.op = ${opName}`].join("\n");
};

export interface CompiledMcpModule {
  sdkPy: string;
  /** The SKILL reference section (grouped read/write with full per-param detail). */
  skillReference: string;
}

/**
 * Compile an introspected MCP server into its Python stub + SKILL reference.
 * Actions carry classification (read/write) from the descriptor; parameter
 * fidelity comes from the raw `tools[].inputSchema` (draft-07).
 */
export const compileMcpModule = (
  descriptor: ExternalAppDescriptor,
  toolSchemas: Record<string, unknown>,
): CompiledMcpModule => {
  const ctx: CompileCtx = { nested: [], usedModelNames: new Set() };
  const moduleName = pyModuleName(descriptor.key);

  const compiled: CompiledAction[] = descriptor.actions.map((action) => {
    const rawSchema = action.mcpToolName
      ? toolSchemas[action.mcpToolName]
      : undefined;
    const schema = isRec(rawSchema) ? rawSchema : {};
    const argsModelName = `${camelToPascal(action.name)}Args`;
    const fields = compileFields(schema, argsModelName, ctx, 0);
    return {
      action,
      argsModelName,
      fields,
      hasAlias: fields.some((f) => f.hasAlias),
    };
  });

  // ── Python module ──
  const parts: string[] = [];
  parts.push("# AUTO-GENERATED from an MCP tools/list — do not edit by hand.");
  parts.push("");
  parts.push(
    `"""${descriptor.displayName} (MCP) — ${descriptor.actions.length.toString()} tools.`,
  );
  parts.push("");
  parts.push(
    "Introspected live from the connected MCP server. Args are validated",
  );
  parts.push(
    "locally by Pydantic before dispatch; a bad value raises here (fast,",
  );
  parts.push("precise) instead of round-tripping to the server.");
  parts.push('"""');
  parts.push("");
  parts.push("from typing import Any, Literal");
  parts.push("from pydantic import BaseModel, ConfigDict, Field");
  parts.push(
    "from ._runtime import FretikActionError, Operation, _call_read, _safe_pattern, run_plan",
  );
  parts.push("");
  parts.push("");

  if (ctx.nested.length > 0) {
    parts.push("# ── Nested argument models ────────────────────────────────");
    parts.push("");
    for (const model of ctx.nested) {
      parts.push(model);
      parts.push("");
      parts.push("");
    }
  }

  parts.push(
    "# ── Per-tool argument models (Pydantic validation in-sandbox) ──",
  );
  parts.push("");
  for (const a of compiled) {
    parts.push(emitArgsModel(a));
    parts.push("");
    parts.push("");
  }

  const reads = compiled.filter((a) => a.action.kind === "read");
  const writes = compiled.filter((a) => a.action.kind === "write");

  if (reads.length > 0) {
    parts.push("# ── Read tools (eager — execute immediately) ──────────────");
    parts.push("");
    for (const a of reads) {
      parts.push(emitReadFn(a, descriptor.key));
      parts.push("");
      parts.push("");
    }
  }
  if (writes.length > 0) {
    parts.push("# ── Write tools (use `.op(...)` inside run_plan([...])) ────");
    parts.push("");
    for (const a of writes) {
      parts.push(emitWriteFns(a, descriptor.key));
      parts.push("");
      parts.push("");
    }
  }

  const sdkPy = parts.join("\n").trimEnd() + "\n";

  // ── SKILL reference ──
  const sigNames = (a: CompiledAction): string =>
    a.fields.map((f) => f.pyName).join(", ");
  const actionBlock = (a: CompiledAction): string => {
    const head = `- \`${moduleName}.${a.action.name}(${sigNames(a)})\` — ${oneLine(a.action.summary, 160)}`;
    const params = a.fields.map((f) => f.skillLine);
    return [head, ...params].join("\n");
  };

  const ref: string[] = [];
  ref.push(
    `# ${descriptor.displayName} — ${descriptor.actions.length.toString()} tools`,
  );
  ref.push("");
  ref.push(
    `Drive the user's ${descriptor.displayName} account via the \`fretik_apps.${moduleName}\` Python module. Every parameter below is the exact name/type the tool expects; optional params default to \`None\`. Args are validated locally (Pydantic) before dispatch.`,
  );
  ref.push("");
  if (reads.length > 0) {
    ref.push("## Read actions (auto-approved, eager)");
    ref.push("");
    for (const a of reads) ref.push(actionBlock(a));
    ref.push("");
  }
  if (writes.length > 0) {
    ref.push("## Write actions (require user approval — build with `.op()`)");
    ref.push("");
    for (const a of writes) ref.push(actionBlock(a));
    ref.push("");
  }

  return { sdkPy, skillReference: ref.join("\n") };
};
