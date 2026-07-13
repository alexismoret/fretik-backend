import type { ParamSpec } from "@fretik/shared/external-apps/manifest-schema";
import { isOptional, pyModuleName, sortedParamEntries } from "./param-utils";
import type { CodegenAction, CodegenProvider } from "./types";

/**
 * SKILL.md emitters — verbatim from the original `generate-sdk.ts`, minus
 * the IO (guidance-file read + version hash) which stays in the CLI so the
 * hash covers the full manifest. Pure templating; CI diff-checked.
 */

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
const buildOneWriteExample = (manifest: CodegenProvider): string => {
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

const buildSkillBoilerplate = (manifest: CodegenProvider): string => {
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

const emitSkillReference = (manifest: CodegenProvider): string => {
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
  const sigOf = (a: CodegenAction): string => {
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

/**
 * Assemble a provider's `SKILL.md` from a `CodegenProvider`, the verbatim
 * `guidance.md` body, and the pre-computed `version` hash (the CLI hashes
 * the full manifest — this module never sees it, keeping the emitter pure).
 */
export interface ManifestSkillInput {
  provider: CodegenProvider;
  guidance: string;
  version: string;
}

/**
 * SKILL.md for an MCP-sourced provider — the deterministic index. No
 * `guidance.md` and no persona (those are manifest-only). Unlike the manifest
 * path, the reference section is NOT built from the lossy `ParamSpec`: the
 * caller passes `skillReference` compiled straight from the tool's JSON Schema
 * (full per-param types, bounds, allowed values), so the agent sees the exact
 * contract the server enforces. `version` is the tool-surface fingerprint.
 */
export interface McpSkillInput {
  provider: CodegenProvider;
  version: string;
  /** Rich reference section from `compileMcpModule` (draft-07 → detail). */
  skillReference: string;
}

export const emitMcpSkill = ({
  provider,
  version,
  skillReference,
}: McpSkillInput): string => {
  const front = [
    "---",
    `name: ${provider.key}`,
    `description: ${provider.description ?? provider.displayName}`,
    `version: ${version}`,
    "---",
    "",
  ].join("\n");

  return [
    front,
    skillReference,
    "---",
    "",
    buildSkillBoilerplate(provider),
  ].join("\n");
};

export const emitManifestSkill = ({
  provider,
  guidance,
  version,
}: ManifestSkillInput): string => {
  const front = [
    "---",
    `name: ${provider.key}`,
    `description: ${provider.description ?? provider.displayName}`,
    `version: ${version}`,
    "---",
    "",
  ].join("\n");

  // Persona/voice rules are scoped to communication providers — gating
  // off `manifest.categories.includes("communication")` keeps the section
  // out of CRM / storage / analytics SKILLs where it has no meaning.
  const persona = provider.categories.includes("communication")
    ? personaSection
    : "";

  return [
    front,
    emitSkillReference(provider),
    "",
    guidance.trimEnd(),
    "",
    ...(persona !== "" ? [persona, ""] : []),
    "---",
    "",
    buildSkillBoilerplate(provider),
  ].join("\n");
};
