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
} from "../src/external-apps/manifest-schema";
import { providerManifestSchema } from "../src/external-apps/manifest-schema";
import { outlookManifest } from "../src/external-apps/providers/outlook/manifest";

// ── Provider registry (extend here when adding a new provider) ────────

interface ProviderInput {
  manifest: ProviderManifest;
  guidancePath: string;
}

const PROVIDERS: ProviderInput[] = [
  {
    manifest: outlookManifest,
    guidancePath: `${import.meta.dir}/../src/external-apps/providers/outlook/guidance.md`,
  },
];

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

const emitDocstring = (action: ManifestAction, indentSpaces = 4): string => {
  const lines: string[] = [`"""${action.summary}`];
  if (action.kind === "write") {
    lines.push("");
    lines.push("(WRITE — requires user approval. Raises ApprovalPending");
    lines.push("until the user grants the plan.)");
  }
  for (const [field, spec] of sortedParamEntries(action.params)) {
    if (spec.description === undefined) continue;
    lines.push("");
    lines.push(`${field}: ${spec.description}`);
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
    `All calls go through fretik-backend → Nango Proxy. Write actions return`,
  );
  parts.push(
    `an Operation when called as \`.op(...)\` (use with run_plan(...));`,
  );
  parts.push(`when called directly they are sugar for run_plan([op]).`);
  parts.push(`"""`);
  parts.push("");
  parts.push("from typing import Any, Literal");
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

const skillBoilerplate = `## Write actions & approval

Write actions NEVER execute on their own. Build them with \`.op()\` and
submit them together via \`run_plan([...])\` — the user approves the whole
plan ONCE.

- One write:   \`outlook.send_email(to=[...], subject="…", body_html="…")\`
- Many writes: \`run_plan([ <provider>.<action>.op(...), ... ])\`

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
  const sigOf = (a: ManifestAction): string => {
    const entries = sortedParamEntries(a.params);
    const args = entries
      .map(([k, s]) => (isOptional(s) ? `${k}=${renderDefault(s.default)}` : k))
      .join(", ");
    return `${manifest.key}.${a.name}(${args})`;
  };

  const lines: string[] = [];
  lines.push(`# ${manifest.displayName} — ${manifest.actions.length} actions`);
  lines.push("");
  lines.push(
    `You can interact with the user's ${manifest.displayName} account via the \`fretik_apps.${manifest.key}\` Python module.`,
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

  return lines.join("\n");
};

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

  return [
    front,
    emitSkillReference(manifest),
    "",
    guidance.trimEnd(),
    "",
    "---",
    "",
    skillBoilerplate,
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
    lines.push(`from . import ${m.key}`);
  }
  lines.push("");
  const exports = [
    '"ApprovalPending"',
    '"FretikActionError"',
    '"Operation"',
    '"run_plan"',
    ...manifests.map((m) => `"${m.key}"`),
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
        `${SDK_DIR}/${p.manifest.key}.py`,
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
