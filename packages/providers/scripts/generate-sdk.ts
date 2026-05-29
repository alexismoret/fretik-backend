#!/usr/bin/env bun
/**
 * Deterministic generator — turns every provider manifest into the Python
 * SDK pushed into the chatbot sandbox (`fretik_apps/<provider>.py`) and
 * the SKILL.md the agent reads when it first reaches for an external app.
 *
 * Zero LLM in this pipeline — the manifest is the source of truth and the
 * transformation is pure templating.
 *
 *   bun run gen:sdk   →  backend/packages/ai/sandbox-assets/{fretik_apps,skills}/...
 *
 * The generated files are committed to the repo (reproducibility, code
 * review). A CI test re-runs the generator and `git diff --exit-code`s
 * the output to catch any drift between manifest and SDK.
 */

import type {
  ManifestAction,
  ParamSpec,
  ProviderManifest,
  ReturnSpec,
} from "@fretik/shared/external-apps/manifest-schema";
import { providerManifestSchema } from "@fretik/shared/external-apps/manifest-schema";
import { frontManifest } from "../src/front/manifest";
import { imapSmtpManifest } from "../src/imap-smtp/manifest";
import { outlookManifest } from "../src/outlook/manifest";
import { shiptifyManifest } from "../src/shiptify/manifest";
import { teamsManifest } from "../src/teams/manifest";

// ── Provider registry (extend here when adding a new provider) ────────

interface ProviderInput {
  manifest: ProviderManifest;
  guidancePath: string;
}

const PROVIDERS: ProviderInput[] = [
  {
    manifest: outlookManifest,
    guidancePath: `${import.meta.dir}/../src/outlook/guidance.md`,
  },
  {
    manifest: imapSmtpManifest,
    guidancePath: `${import.meta.dir}/../src/imap-smtp/guidance.md`,
  },
  {
    manifest: teamsManifest,
    guidancePath: `${import.meta.dir}/../src/teams/guidance.md`,
  },
  {
    manifest: frontManifest,
    guidancePath: `${import.meta.dir}/../src/front/guidance.md`,
  },
  {
    manifest: shiptifyManifest,
    guidancePath: `${import.meta.dir}/../src/shiptify/guidance.md`,
  },
];

/**
 * Convert a manifest key (kebab-case) to a Python-safe module name
 * (snake_case). The FQ action name sent in dispatch requests keeps the
 * original kebab-case key — only the generated Python module + filename
 * use this transform.
 */
const pyModuleName = (key: string): string => key.replace(/-/g, "_");

// ── Paths ─────────────────────────────────────────────────────────────

const ROOT = `${import.meta.dir}/..`;
const OUT_DIR = `${ROOT}/../ai/sandbox-assets`;
const SDK_DIR = `${OUT_DIR}/fretik_apps`;
const SKILLS_DIR = `${OUT_DIR}/skills`;
const RUNTIME_TEMPLATE_PATH = `${import.meta.dir}/sdk-templates/_runtime.py`;

// ── Helpers ───────────────────────────────────────────────────────────

const camelToPascal = (s: string): string =>
  s
    .split(/[_\s]/)
    .map((p) => (p.length === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");

const pyStr = (value: string): string => JSON.stringify(value);

/** Map a manifest `ParamSpec` to a Python type expression. */
const pyType = (spec: ParamSpec): string => {
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

const pyDefault = (spec: ParamSpec): string => {
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

const isOptional = (spec: ParamSpec): boolean =>
  spec.optional === true || spec.default !== undefined;

const pyAnnotation = (spec: ParamSpec): string => {
  const base = pyType(spec);
  return isOptional(spec) ? `${base} | None` : base;
};

/** Order params: required first (no default), then optional (with default). */
const sortedParamEntries = (
  params: Record<string, ParamSpec>,
): [string, ParamSpec][] => {
  const entries = Object.entries(params);
  return entries.sort(([, a], [, b]) => {
    const aOpt = isOptional(a) ? 1 : 0;
    const bOpt = isOptional(b) ? 1 : 0;
    return aOpt - bOpt;
  });
};

const indent = (text: string, spaces: number): string => {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
};

// ── Generators ────────────────────────────────────────────────────────

const emitReturnType = (
  returns: ReturnSpec,
  types: Record<string, Record<string, ParamSpec>>,
): string => {
  if ("void" in returns) return "None";
  if ("ref" in returns) {
    return types[returns.ref] !== undefined ? returns.ref : "dict[str, Any]";
  }
  if ("list" in returns) {
    return `list[${types[returns.list] !== undefined ? returns.list : "dict[str, Any]"}]`;
  }
  if ("page" in returns) {
    return types[returns.page] !== undefined
      ? `${returns.page}Page`
      : "dict[str, Any]";
  }
  return "dict[str, Any]";
};

const emitTypeModel = (
  name: string,
  fields: Record<string, ParamSpec>,
): string => {
  const lines: string[] = [`class ${name}(BaseModel):`];
  const entries = sortedParamEntries(fields);
  if (entries.length === 0) {
    lines.push("    pass");
    return lines.join("\n");
  }
  for (const [field, spec] of entries) {
    if (isOptional(spec)) {
      lines.push(`    ${field}: ${pyAnnotation(spec)} = None`);
    } else {
      lines.push(`    ${field}: ${pyAnnotation(spec)}`);
    }
  }
  return lines.join("\n");
};

const emitActionArgsModel = (action: ManifestAction): string => {
  const name = `${camelToPascal(action.name)}Args`;
  const lines: string[] = [`class ${name}(BaseModel):`];
  const entries = sortedParamEntries(action.params);
  if (entries.length === 0) {
    lines.push("    pass");
    return lines.join("\n");
  }
  for (const [field, spec] of entries) {
    if (isOptional(spec)) {
      lines.push(`    ${field}: ${pyAnnotation(spec)} = ${pyDefault(spec)}`);
    } else {
      lines.push(`    ${field}: ${pyAnnotation(spec)}`);
    }
  }
  return lines.join("\n");
};

const emitFunctionSignature = (
  name: string,
  params: Record<string, ParamSpec>,
  returnType: string,
): string => {
  const entries = sortedParamEntries(params);
  const sigParts: string[] = [];
  for (const [field, spec] of entries) {
    if (isOptional(spec)) {
      sigParts.push(`${field}: ${pyAnnotation(spec)} = ${pyDefault(spec)}`);
    } else {
      sigParts.push(`${field}: ${pyAnnotation(spec)}`);
    }
  }
  // Implicit framework arg — every action accepts an optional connection_id
  // to disambiguate when several connections exist for the same provider.
  sigParts.push("connection_id: str | None = None");

  if (sigParts.length === 0) {
    return `def ${name}() -> ${returnType}:`;
  }
  const joined = sigParts.join(",\n    ");
  return `def ${name}(\n    ${joined},\n) -> ${returnType}:`;
};

/**
 * Escape backslashes for safe inclusion inside a Python triple-quoted
 * docstring. Manifest summaries / descriptions may legitimately contain
 * `\Seen`, `\Sent`, RFC 6154 flags etc. — left raw, Python 3.6+ emits a
 * `SyntaxWarning: invalid escape sequence` because `\S`, `\T`, … are
 * unknown escapes. Doubling every backslash renders identically (the
 * docstring still says `\Seen` when printed) and silences the warning.
 */
const escapeForPyDocstring = (s: string): string => s.replace(/\\/g, "\\\\");

const emitDocstring = (action: ManifestAction, indentSpaces = 4): string => {
  const lines: string[] = [`"""${escapeForPyDocstring(action.summary)}`];
  if (action.kind === "write") {
    lines.push("");
    lines.push("(WRITE — requires user approval. Raises ApprovalPending");
    lines.push("until the user grants the plan.)");
  }
  for (const [field, spec] of sortedParamEntries(action.params)) {
    if (spec.description === undefined) continue;
    lines.push("");
    lines.push(`${field}: ${escapeForPyDocstring(spec.description)}`);
    break;
  }
  // Always document connection_id.
  lines.push("");
  lines.push(
    "connection_id: pick a specific connection when several exist for this",
  );
  lines.push("provider. Pass the ID surfaced in the agent context.");
  lines.push('"""');
  return indent(lines.join("\n"), indentSpaces);
};

const emitArgsExpr = (
  argsModelName: string,
  params: Record<string, ParamSpec>,
): string => {
  const entries = sortedParamEntries(params);
  if (entries.length === 0) {
    return `${argsModelName}().model_dump(exclude_none=True)`;
  }
  const kwargs = entries.map(([k]) => `${k}=${k}`).join(", ");
  return `${argsModelName}(${kwargs}).model_dump(exclude_none=True)`;
};

const emitReadFunction = (
  action: ManifestAction,
  providerKey: string,
  types: Record<string, Record<string, ParamSpec>>,
): string => {
  const argsModelName = `${camelToPascal(action.name)}Args`;
  const returnType = emitReturnType(action.returns, types);
  const signature = emitFunctionSignature(
    action.name,
    action.params,
    returnType,
  );
  const docstring = emitDocstring(action);
  const argsExpr = emitArgsExpr(argsModelName, action.params);
  const fqName = `${providerKey}.${action.name}`;

  let returnExpr: string;
  if ("void" in action.returns) {
    returnExpr = `_call_read("${fqName}", _args)\n    return None`;
  } else if (
    "ref" in action.returns &&
    types[action.returns.ref] !== undefined
  ) {
    returnExpr = `data = _call_read("${fqName}", _args)\n    return ${action.returns.ref}(**data)`;
  } else if (
    "list" in action.returns &&
    types[action.returns.list] !== undefined
  ) {
    const itemType = action.returns.list;
    returnExpr = `data = _call_read("${fqName}", _args)\n    return [${itemType}(**item) for item in data]`;
  } else if (
    "page" in action.returns &&
    types[action.returns.page] !== undefined
  ) {
    const itemType = action.returns.page;
    returnExpr = `data = _call_read("${fqName}", _args)\n    return ${itemType}Page(items=[${itemType}(**item) for item in data.get("items", [])], page_token=data.get("page_token"))`;
  } else {
    returnExpr = `return _call_read("${fqName}", _args)`;
  }

  return [
    signature,
    docstring,
    `    _args = ${argsExpr}`,
    `    if connection_id is not None:`,
    `        _args["connection_id"] = connection_id`,
    `    ${returnExpr.replace(/\n    /g, "\n    ")}`,
  ].join("\n");
};

const emitWriteFunctions = (
  action: ManifestAction,
  providerKey: string,
): string => {
  const argsModelName = `${camelToPascal(action.name)}Args`;
  const argsExpr = emitArgsExpr(argsModelName, action.params);
  const fqName = `${providerKey}.${action.name}`;
  const opFnName = `_${action.name}_op`;

  // .op builder
  const opSig = emitFunctionSignature(opFnName, action.params, "Operation");
  const opDoc = indent(
    `"""Build a ${action.name} Operation (does NOT execute).\nUse inside run_plan([...])."""`,
    4,
  );
  const opBody = [
    `    _args = ${argsExpr}`,
    `    if connection_id is not None:`,
    `        _args["connection_id"] = connection_id`,
    `    return Operation(action="${fqName}", args=_args)`,
  ].join("\n");
  const opFn = [opSig, opDoc, opBody].join("\n");

  // Direct call — sugar for run_plan([op(...)])
  const sig = emitFunctionSignature(
    action.name,
    action.params,
    "dict[str, Any]",
  );
  const doc = emitDocstring(action);
  const body = [
    `    op = ${opFnName}(`,
    ...sortedParamEntries(action.params).map(([k]) => `        ${k}=${k},`),
    `        connection_id=connection_id,`,
    `    )`,
    `    result = run_plan([op])`,
    `    if not result or not result[0].get("ok"):`,
    `        raise FretikActionError(result[0].get("error", "${action.name} failed"))`,
    `    return result[0].get("data", {})`,
  ].join("\n");

  return [opFn, "", sig, doc, body, "", `${action.name}.op = ${opFnName}`].join(
    "\n",
  );
};

// ── Provider Python module ────────────────────────────────────────────

const emitProviderModule = (manifest: ProviderManifest): string => {
  const parts: string[] = [];
  parts.push(
    `# AUTO-GENERATED from manifest.ts — do not edit by hand. Regenerate: bun run gen:sdk`,
  );
  parts.push("");
  parts.push(
    `"""${manifest.displayName} provider — ${manifest.actions.length} actions.`,
  );
  parts.push("");
  parts.push(
    `All calls go through fretik-backend, which dispatches them to the`,
  );
  parts.push(
    `provider (Nango Proxy or a custom handler). Write actions return an`,
  );
  parts.push(`Operation when called as \`.op(...)\` (use with run_plan(...));`);
  parts.push(`when called directly they are sugar for run_plan([op]).`);
  parts.push(`"""`);
  parts.push("");
  parts.push("from typing import Any, Literal, Optional");
  parts.push("from pydantic import BaseModel");
  parts.push(
    "from ._runtime import FretikActionError, Operation, _call_read, run_plan",
  );
  parts.push("");
  parts.push("");

  // Reusable types
  parts.push(
    "# ── Types ─────────────────────────────────────────────────────────",
  );
  parts.push("");
  for (const [name, fields] of Object.entries(manifest.types)) {
    parts.push(emitTypeModel(name, fields));
    parts.push("");
    parts.push("");
  }

  // Paginated wrapper types — one `<X>Page` per named type referenced
  // by any action's `returns: { page: "X" }`. Wraps the items in a
  // typed list and exposes `page_token` for cursor pagination.
  const pageTypes = new Set<string>();
  for (const action of manifest.actions) {
    if ("page" in action.returns && manifest.types[action.returns.page]) {
      pageTypes.add(action.returns.page);
    }
  }
  if (pageTypes.size > 0) {
    for (const typeName of pageTypes) {
      parts.push(`class ${typeName}Page(BaseModel):`);
      parts.push(`    items: list[${typeName}]`);
      parts.push(`    page_token: Optional[str] = None`);
      parts.push("");
      parts.push("");
    }
  }

  // Per-action argument models
  parts.push(
    "# ── Per-action argument models (Pydantic validation in-sandbox) ──",
  );
  parts.push("");
  for (const action of manifest.actions) {
    parts.push(emitActionArgsModel(action));
    parts.push("");
    parts.push("");
  }

  // Read actions
  const reads = manifest.actions.filter((a) => a.kind === "read");
  if (reads.length > 0) {
    parts.push("# ── Read actions (eager — execute immediately) ─────────");
    parts.push("");
    for (const action of reads) {
      parts.push(emitReadFunction(action, manifest.key, manifest.types));
      parts.push("");
      parts.push("");
    }
  }

  // Write actions
  const writes = manifest.actions.filter((a) => a.kind === "write");
  if (writes.length > 0) {
    parts.push(
      "# ── Write actions (use `.op(...)` inside run_plan([...])) ───",
    );
    parts.push("");
    for (const action of writes) {
      parts.push(emitWriteFunctions(action, manifest.key));
      parts.push("");
      parts.push("");
    }
  }

  return parts.join("\n").trimEnd() + "\n";
};

// ── Skill markdown ────────────────────────────────────────────────────

/**
 * Render a short placeholder value for an action parameter in an example
 * call signature. Strings → `"…"`, integers → `1`, etc. Used to build a
 * concrete one-write example anchored to the CURRENT provider's first
 * write action — never a sibling provider's example, which would
 * mislead the agent when the SKILL belongs to a different domain.
 */
const examplePlaceholder = (spec: ParamSpec): string => {
  switch (spec.type) {
    case "string":
      return `"…"`;
    case "email":
      return `"name@example.com"`;
    case "datetime":
      return `"2026-01-01T09:00:00"`;
    case "integer":
      return "1";
    case "number":
      return "1.0";
    case "boolean":
      return "True";
    case "enum":
      return spec.values && spec.values.length > 0
        ? `"${spec.values[0] ?? ""}"`
        : `"…"`;
    case "array":
      return spec.items ? `[${examplePlaceholder(spec.items)}]` : "[…]";
    case "object":
      return "{…}";
    default: {
      const exhaustive: never = spec.type;
      throw new Error(
        `examplePlaceholder: unhandled type ${String(exhaustive)}`,
      );
    }
  }
};

/**
 * Build the "one write" example in the skill boilerplate using a REAL
 * action from this provider's manifest — preferring the first write,
 * falling back to the first action of any kind, falling back to a
 * generic placeholder. The generic placeholder is the original wording
 * that ran for every provider before — keeping it as the last resort
 * keeps the boilerplate sensible even when a manifest has no actions
 * (shouldn't happen — the schema enforces ≥ 1).
 */
const buildOneWriteExample = (manifest: ProviderManifest): string => {
  const moduleName = pyModuleName(manifest.key);
  const writes = manifest.actions.filter((a) => a.kind === "write");
  const action = writes[0] ?? manifest.actions[0];
  if (action === undefined) {
    return `\`${moduleName}.<action>(...)\``;
  }
  const requiredEntries = sortedParamEntries(action.params).filter(
    ([, spec]) => !isOptional(spec),
  );
  // Cap the example at 3 required params — keeps the line readable for
  // big signatures (e.g. create_shipment_request has 5).
  const shown = requiredEntries.slice(0, 3);
  const args = shown
    .map(([name, spec]) => `${name}=${examplePlaceholder(spec)}`)
    .join(", ");
  const ellipsis = requiredEntries.length > shown.length ? ", …" : "";
  return `\`${moduleName}.${action.name}(${args}${ellipsis})\``;
};

const buildSkillBoilerplate = (manifest: ProviderManifest): string => {
  const oneWriteExample = buildOneWriteExample(manifest);
  const moduleName = pyModuleName(manifest.key);
  return `## Write actions & approval

Write actions NEVER execute on their own. Build them with \`.op()\` and
submit them together via \`run_plan([...])\` — the user approves the whole
plan ONCE.

- One write:   ${oneWriteExample}
- Many writes: \`run_plan([ ${moduleName}.<action>.op(...), ... ])\`

When you call \`run_plan\` (or a direct write), it raises
\`fretik_apps.ApprovalPending\`. This is EXPECTED — not an error. STOP.
The user reviews the plan in the UI; you will be prompted to continue.
When prompted, RE-RUN THE EXACT SAME CODE — the approved plan then
executes; reads re-run harmlessly. If the user rejects, you receive
their feedback as a message — adapt and write new code.

### STRONG RULE — read→write flows
When a plan depends on data you just read, you MUST inline the read
results as EXPLICIT LITERALS in the \`.op()\` calls. Do NOT compute
\`.op()\` arguments from a read performed in the same script as
\`run_plan\`.

Correct: read in one turn, inspect the results, THEN in the next turn
write \`run_plan([...])\` with concrete IDs / addresses as literals.

Why: on re-run after approval, a volatile read (inbox changed) would
change the plan's lookupHash and force a needless re-approval.

### Plan rules
- Operations in one plan must be INDEPENDENT (no op uses another op's
  result). Dependent steps (create_folder, then move into it) → use
  TWO turns.
- For several writes, ALWAYS use a single \`run_plan\` — never chain
  bare writes.
- Partial failures come back per-op; re-submit a \`run_plan\` with only
  the failed ops.
`;
};

const emitSkillReference = (manifest: ProviderManifest): string => {
  const reads = manifest.actions.filter((a) => a.kind === "read");
  const writes = manifest.actions.filter((a) => a.kind === "write");

  const renderDefault = (value: unknown): string => {
    if (value === undefined) return "None";
    if (typeof value === "string") return `"${value}"`;
    if (typeof value === "number") return value.toString();
    if (typeof value === "boolean") return value ? "True" : "False";
    return JSON.stringify(value);
  };
  const moduleName = pyModuleName(manifest.key);
  const sigOf = (a: ManifestAction): string => {
    const entries = sortedParamEntries(a.params);
    const args = entries
      .map(([k, s]) => (isOptional(s) ? `${k}=${renderDefault(s.default)}` : k))
      .join(", ");
    return `${moduleName}.${a.name}(${args})`;
  };

  const lines: string[] = [];
  lines.push(`# ${manifest.displayName} — ${manifest.actions.length} actions`);
  lines.push("");
  lines.push(
    `You can interact with the user's ${manifest.displayName} account via the \`fretik_apps.${moduleName}\` Python module.`,
  );
  lines.push("");

  if (reads.length > 0) {
    lines.push("## Read actions (auto-approved, eager)");
    lines.push("");
    for (const a of reads) lines.push(`- \`${sigOf(a)}\` — ${a.summary}`);
    lines.push("");
  }

  if (writes.length > 0) {
    lines.push("## Write actions (require user approval — build with `.op()`)");
    lines.push("");
    for (const a of writes) lines.push(`- \`${sigOf(a)}\` — ${a.summary}`);
    lines.push("");
  }

  // Data models section — emitted from `manifest.types`. Documents the
  // exact Pydantic field names of every read action's return type, so
  // the agent stops guessing (`m.sent_datetime` instead of
  // `m.received_at`, `f.parent_id` instead of `f.parent_folder_id`,
  // etc.) and burning a tool call on `print(m.model_dump())` just to
  // discover the schema.
  const typeEntries = Object.entries(manifest.types);
  if (typeEntries.length > 0) {
    lines.push("## Data models");
    lines.push("");
    lines.push(
      "Read actions return Pydantic models — field names below are EXACT. Use the names as-is (`m.from_address`, NOT `m.sender` or `m.from_`). A trailing `?` marks an optional field.",
    );
    lines.push("");
    for (const [typeName, fields] of typeEntries) {
      lines.push(`- \`${typeName}\` — ${renderTypeFields(fields)}`);
    }
    // Paginated wrappers — auto-generated for any type referenced via
    // `{ page: "X" }` on a read action.
    const pageTypes = new Set<string>();
    for (const action of manifest.actions) {
      if ("page" in action.returns && manifest.types[action.returns.page]) {
        pageTypes.add(action.returns.page);
      }
    }
    for (const typeName of pageTypes) {
      lines.push(
        `- \`${typeName}Page\` — \`items: list[${typeName}]\`, \`page_token?: str\` (pass back to the same action to fetch the next page)`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
};

/**
 * Render a `Record<fieldName, ParamSpec>` as a single-line, compact,
 * type-annotated field list — e.g.
 *   `id:str, subject:str, from_address:str, to:list[str], …`
 *
 * Used in the SKILL.md "Data models" section. Kept on one line per
 * model on purpose: tight on tokens (the whole section adds ~1.5 KB
 * to a SKILL.md that's already ~8.5 KB) yet gives the agent every
 * exact field name it needs.
 */
const renderTypeFields = (fields: Record<string, ParamSpec>): string => {
  const entries = Object.entries(fields);
  return entries
    .map(([name, spec]) => {
      const opt = isOptional(spec) ? "?" : "";
      return `\`${name}${opt}: ${renderTypeShort(spec)}\``;
    })
    .join(", ");
};

/**
 * Map a `ParamSpec` to a short Python-style type name, suitable for
 * embedding in SKILL.md. Doesn't aim to be a parseable type expression
 * — just human-readable enough that the agent picks the right access
 * pattern without guessing.
 */
const renderTypeShort = (spec: ParamSpec): string => {
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
      const values = spec.values ?? [];
      if (values.length === 0) return "str";
      return `Literal[${values.map((v) => `"${v}"`).join(", ")}]`;
    }
    case "array":
      return spec.items ? `list[${renderTypeShort(spec.items)}]` : "list";
    case "object":
      return "dict";
    default: {
      const exhaustive: never = spec.type;
      throw new Error(`Unhandled ParamSpec type: ${String(exhaustive)}`);
    }
  }
};

/**
 * Voice & persona section — emitted only when the manifest belongs to the
 * `communication` family (mail, chat, future Slack/Teams/WhatsApp). The
 * `persona` option (declared in the provider's `connectionOptions`) drives
 * how the chatbot writes on a connection's behalf:
 *
 *  - `personal` → the agent is drafting AS the user; must not betray that
 *    an AI wrote the message; calibrates style from any available example.
 *  - `bot`      → the agent writes openly as Fretik / a team assistant.
 *
 * Kept inside the SKILL.md (rather than the system prompt) so it only costs
 * tokens when the agent is actually about to use a communication provider.
 *
 * Provider-agnostic on purpose: the actions available to look up past
 * messages from this user are listed in the SKILL's reference section
 * above — the agent picks the right one from there.
 */
const personaSection = `## Voice & persona — write according to the connection's persona

Each connection of category \`communication\` carries a \`persona\` option
exposed in the system prompt's \`<external_apps>\` block. Read it BEFORE
drafting a message and adapt your voice accordingly.

### \`persona: personal\` — write AS the user, not AS an AI

This connection is the user's personal account. You are drafting on their
behalf — to the recipient it must look like the user wrote it.

- **NEVER** mention that you are an AI, an assistant, or a bot. No "I'd be
  happy to…", no "As your assistant…", no automated signatures like "Sent
  from Fretik".
- **Calibrate to whatever you actually know about how the user writes.**
  - If you already have examples in this turn's context — the thread you
    just read, a message the user paraphrased, prior conversation history,
    a sample in \`searchKnowledge\` — internalize that. Do NOT fetch more.
  - Otherwise, look up a couple of the user's past outbound messages on
    this channel via the read actions listed at the top of this SKILL
    (the one that lists messages the user has sent, then fetch one to
    see its full body).
  - From any example, internalize: how they sign off (full name, first
    name, an informal phrase, or nothing — some users never sign, do NOT
    invent a signature in that case), formality, sentence length, greeting
    habits, plain text vs HTML, emoji use.
  - **Do NOT quote or paraphrase the examples** — internalize the style.
- **Match the language to the situation, not to the user.** Replies and
  forwards continue in the language of the message you are answering. New
  outbound messages match what is natural for that recipient given any
  available signal (their past messages, their name, the explicit
  instruction the user gave you in this turn). When in doubt, use the
  language of the user's last message in this conversation.
- Write in plain, human prose. Short sentences. Match register exactly.
- If you have no calibration signal at all, default to plain human prose
  and DO NOT add a signature unless the user explicitly asked.

### \`persona: bot\` — write openly as Fretik / a team assistant

This connection is an assumed team / bot account. Standard assistant tone
applies: structured if helpful, clear, professional.

### Approval still applies in both modes

\`persona\` changes the voice, not the gate. Every write still goes through
\`run_plan([...])\` and the user reviews the draft before it leaves.
`;

const emitSkill = async (input: ProviderInput): Promise<string> => {
  const { manifest } = input;
  const guidance = await Bun.file(input.guidancePath).text();
  const versionHasher = new Bun.CryptoHasher("sha256");
  versionHasher.update(JSON.stringify(manifest));
  const version = versionHasher.digest("hex").slice(0, 12);

  const front = [
    "---",
    `name: ${manifest.key}`,
    `description: ${manifest.displayName} — read inbox, send email, manage calendar and contacts`,
    `version: ${version}`,
    "---",
    "",
  ].join("\n");

  // Persona/voice rules are scoped to communication providers — gating
  // off `manifest.categories.includes("communication")` keeps the section
  // out of CRM / storage / analytics SKILLs where it has no meaning.
  const persona = manifest.categories.includes("communication")
    ? personaSection
    : "";

  return [
    front,
    emitSkillReference(manifest),
    "",
    guidance.trimEnd(),
    "",
    ...(persona !== "" ? [persona, ""] : []),
    "---",
    "",
    buildSkillBoilerplate(manifest),
  ].join("\n");
};

// ── fretik_apps/__init__.py ──────────────────────────────────────────

const emitInit = (manifests: ProviderManifest[]): string => {
  const lines: string[] = [];
  lines.push(
    `"""fretik_apps — Fretik's external-apps SDK for the chatbot sandbox."""`,
  );
  lines.push("");
  lines.push(
    "from ._runtime import ApprovalPending, FretikActionError, Operation, run_plan",
  );
  for (const m of manifests) {
    lines.push(`from . import ${pyModuleName(m.key)}`);
  }
  lines.push("");
  const exports = [
    '"ApprovalPending"',
    '"FretikActionError"',
    '"Operation"',
    '"run_plan"',
    ...manifests.map((m) => `"${pyModuleName(m.key)}"`),
  ];
  lines.push(`__all__ = [${exports.join(", ")}]`);
  return lines.join("\n");
};

// ── Main ──────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  // Validate every manifest.
  for (const p of PROVIDERS) providerManifestSchema.parse(p.manifest);

  // Runtime template — copied verbatim.
  const runtime = await Bun.file(RUNTIME_TEMPLATE_PATH).text();

  // Write all provider files in parallel (one writer per file).
  await Promise.all([
    Bun.write(`${SDK_DIR}/_runtime.py`, runtime),
    Bun.write(
      `${SDK_DIR}/__init__.py`,
      emitInit(PROVIDERS.map((p) => p.manifest)),
    ),
    ...PROVIDERS.flatMap((p) => [
      Bun.write(
        `${SDK_DIR}/${pyModuleName(p.manifest.key)}.py`,
        emitProviderModule(p.manifest),
      ),
      emitSkill(p).then((skill) =>
        Bun.write(`${SKILLS_DIR}/${p.manifest.key}/SKILL.md`, skill),
      ),
    ]),
  ]);

  console.log(
    `✓ Generated SDK + SKILL.md for ${PROVIDERS.length.toString()} provider(s) into ${OUT_DIR}`,
  );
};

await main();
