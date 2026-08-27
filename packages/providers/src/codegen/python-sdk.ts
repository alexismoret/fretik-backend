import type {
  ParamSpec,
  ReturnSpec,
} from "@fretik/shared/external-apps/manifest-schema";
import {
  camelToPascal,
  escapeForPyDocstring,
  indent,
  isOptional,
  pyAnnotation,
  pyDefault,
  pyModuleName,
  sortedParamEntries,
} from "./param-utils";
import type { CodegenAction, CodegenProvider } from "./types";

/**
 * Python-SDK emitters — verbatim from the original `generate-sdk.ts`.
 * Pure templating over a `CodegenProvider`; zero LLM, zero IO. The output
 * is committed and CI diff-checked, so every string here is load-bearing.
 */

// Hand-maintained, non-manifest modules copied verbatim into the SDK (like
// `_runtime.py`). `collections` is the code-mode ontology SDK (collections +
// records); it talks to `/sandbox/exec` `kind: "collections"`, not a provider.
export const STATIC_MODULE_TEMPLATES = ["collections"];

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

const emitActionArgsModel = (action: CodegenAction): string => {
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

const emitDocstring = (action: CodegenAction, indentSpaces = 4): string => {
  const lines: string[] = [`"""${escapeForPyDocstring(action.summary)}`];
  if (action.kind === "write") {
    lines.push("");
    lines.push(`(WRITE — build it with \`${action.name}.op(...)\` and submit`);
    lines.push("it with `run_plan([...])`. Calling this directly raises.)");
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
  action: CodegenAction,
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
  action: CodegenAction,
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

  // Direct call — refuses. A write action that both BUILDS and SUBMITS is a
  // trap: `ops = [act(a), act(b)]` submits a one-op plan on the first element,
  // raises ApprovalPending there, and the rest of the cell never runs — the
  // second write is lost silently and the approval card shows one operation.
  // One spelling only: `.op(...)` builds, `run_plan([...])` submits.
  const moduleName = pyModuleName(providerKey);
  const sig = emitFunctionSignature(
    action.name,
    action.params,
    "dict[str, Any]",
  );
  const doc = emitDocstring(action);
  const body = [
    `    raise FretikActionError(`,
    `        "${action.name} is a WRITE action and does not execute on its own. "`,
    `        "Build it with .op(...) and submit it with run_plan([...]): "`,
    `        "run_plan([${moduleName}.${action.name}.op(...)])"`,
    `    )`,
  ].join("\n");

  return [opFn, "", sig, doc, body, "", `${action.name}.op = ${opFnName}`].join(
    "\n",
  );
};

// ── Provider Python module ────────────────────────────────────────────

export const emitProviderModule = (manifest: CodegenProvider): string => {
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
  parts.push(`Operation via \`.op(...)\`; submit them with run_plan([...]).`);
  parts.push(`Calling a write action directly raises — it never executes.`);
  parts.push(`"""`);
  parts.push("");
  parts.push("from typing import Any, Literal, Optional");
  parts.push("from pydantic import BaseModel");
  parts.push("from ._runtime import FretikActionError, Operation, _call_read");
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

// ── fretik_apps/__init__.py ──────────────────────────────────────────

export const emitInit = (manifests: readonly CodegenProvider[]): string => {
  const lines: string[] = [];
  lines.push(
    `"""fretik_apps — Fretik's external-apps SDK for the chatbot sandbox."""`,
  );
  lines.push("");
  lines.push(
    "from ._runtime import ApprovalPending, FretikActionError, Operation, run_plan",
  );
  for (const name of STATIC_MODULE_TEMPLATES) {
    lines.push(`from . import ${name}`);
  }
  for (const m of manifests) {
    lines.push(`from . import ${pyModuleName(m.key)}`);
  }
  lines.push("");
  const exports = [
    '"ApprovalPending"',
    '"FretikActionError"',
    '"Operation"',
    '"run_plan"',
    ...STATIC_MODULE_TEMPLATES.map((name) => `"${name}"`),
    ...manifests.map((m) => `"${pyModuleName(m.key)}"`),
  ];
  lines.push(`__all__ = [${exports.join(", ")}]`);
  return lines.join("\n");
};
