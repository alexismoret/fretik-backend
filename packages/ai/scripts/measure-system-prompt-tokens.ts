#!/usr/bin/env bun
/**
 * Token-usage measurer for the agent context surfaces.
 *
 * Measures the three surfaces that compose what the model reads every
 * turn, per agent:
 *  - the system prompt, resolved PER AGENT via `resolveAgentBlocks`
 *    (chatbot vs workflow — the raw template contains both variants and
 *    overstates each), HTML comments stripped like the runtime renderer,
 *    then split at the DYNAMIC SUFFIX marker into the cacheable static
 *    prefix and the per-turn dynamic suffix. Suffix numbers are
 *    TEMPLATE-side: `{{placeholders}}` are unexpanded, so the runtime
 *    suffix is larger (attachments, context manifest, memory block...).
 *  - every tool's `description` field plus its Zod `.describe()` strings
 *    (tracked separately; all of src/tools/, both agents mixed)
 *  - the `description` in each bundled SKILL.md frontmatter (the L1
 *    catalog injected as `- **name** — description`; runtime catalog
 *    also carries provider skills from the DB, not measured here)
 *
 * The per-section breakdown maps 1:1 to the section registry in
 * `.agent/agent-context-framework.md` §2 — use it to enforce the
 * declared token budgets after any prompt edit.
 *
 * Token counts use the `o200k_base` encoder: publicly available, stable
 * across measurements, realistic for English/French text — what a delta
 * tracker needs. Snapshots before 2026-07-17 measured the RAW unified
 * template (both agent variants) and are ~3-4K tokens higher than the
 * per-agent numbers here; don't compare across that boundary.
 *
 * Usage: `bun run measure:tokens` (writes a JSON snapshot to stdout).
 *
 * Implementation note: tool source files are read as text and the
 * description literals extracted with regex. Importing the tool
 * factories would be cleaner but would pull in DB / Redis / S3 setup at
 * module init through their `@fretik/shared` deps — the script must stay
 * runnable in a fresh shell with no env file. `prompt-blocks.ts` is a
 * PURE module (no imports) and is safe to import directly.
 */

import { Glob } from "bun";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import {
  resolveAgentBlocks,
  type PromptAgentKind,
} from "../src/agents/shared/prompt-blocks";

const PROJECT_ROOT = `${import.meta.dir}/..`;
const SYSTEM_PROMPT_PATH = `${PROJECT_ROOT}/src/agents/shared/agent-system-prompt.md`;
const PAGE_BUILDER_PROMPT_PATH = `${PROJECT_ROOT}/src/agents/chatbot/page-builder-system-prompt.md`;
const TOOLS_DIR = `${PROJECT_ROOT}/src/tools`;
const SKILLS_DIR = `${PROJECT_ROOT}/src/skills/bundled`;

const HTML_COMMENT_RE = /<!--[\s\S]*?-->\n?/g;

/** Must stay in sync with `scripts/seed-langfuse-prompts.ts`. */
const DYNAMIC_MARKER = "DYNAMIC SUFFIX — every section below";

const tokensOf = (text: string): number =>
  text.length === 0 ? 0 : encode(text).length;

const stripComments = (text: string): string =>
  text.replace(HTML_COMMENT_RE, "");

interface ZoneSnapshot {
  chars: number;
  tokens: number;
  /** Tokens per top-level `<section>` block, in document order. */
  sections: Record<string, number>;
}

interface AgentPromptSnapshot {
  resolved_tokens: number;
  static_prefix: ZoneSnapshot;
  dynamic_suffix_template: ZoneSnapshot;
}

/**
 * Tokens per top-level `<tag>`…`</tag>` block. Only lines that are
 * exactly an opening tag open a section; nested sub-tags (different
 * names, e.g. `<language>` inside `<communication>`) are section
 * content. Text outside any section lands in `_untagged`.
 */
const measureSections = (text: string): Record<string, number> => {
  const sections: Record<string, number> = {};
  const untagged: string[] = [];
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = (name: string): void => {
    sections[name] = (sections[name] ?? 0) + tokensOf(buffer.join("\n"));
    buffer = [];
  };

  for (const line of text.split("\n")) {
    if (current === null) {
      const open = line.match(/^<([a-z_]+)>\s*$/);
      if (open?.[1]) {
        current = open[1];
        buffer = [line];
      } else {
        untagged.push(line);
      }
      continue;
    }
    buffer.push(line);
    if (line.trimEnd() === `</${current}>`) {
      flush(current);
      current = null;
    }
  }
  if (current !== null) flush(current); // unclosed tag — count anyway

  const untaggedText = untagged.join("\n").trim();
  if (untaggedText.length > 0) sections._untagged = tokensOf(untaggedText);
  return sections;
};

const measureZone = (raw: string): ZoneSnapshot => {
  const stripped = stripComments(raw);
  return {
    chars: stripped.length,
    tokens: tokensOf(stripped),
    sections: measureSections(stripped),
  };
};

const measureAgentPrompt = (
  template: string,
  agent: PromptAgentKind,
): AgentPromptSnapshot => {
  const resolved = resolveAgentBlocks(template, agent);
  const markerIdx = resolved.indexOf(DYNAMIC_MARKER);
  if (markerIdx === -1) {
    throw new Error(`DYNAMIC SUFFIX marker not found in resolved ${agent}`);
  }
  // The marker sits inside an HTML comment — split at the comment's
  // opening so neither half carries an unterminated `<!--`.
  const splitAt = resolved.lastIndexOf("<!--", markerIdx);
  const staticPrefix = measureZone(resolved.slice(0, splitAt));
  const dynamicSuffix = measureZone(resolved.slice(splitAt));
  return {
    resolved_tokens: staticPrefix.tokens + dynamicSuffix.tokens,
    static_prefix: staticPrefix,
    dynamic_suffix_template: dynamicSuffix,
  };
};

/**
 * Tool source files are TS, but the description literal is always
 * one of three shapes (see src/tools/*.ts):
 *   1. `description: "single string"`
 *   2. `description: [\n    "line",\n    ...,\n  ].join("\n")`
 *   3. `description: SOME_UPPER_CASE_CONST` (resolve the const body)
 *
 * The `inputSchema` / `execute:` keys sit at the same indentation
 * as `description:` — we cut at the first one we hit so the regex
 * can stay greedy without chasing into the schema.
 */
const TOOL_FILE_BLACKLIST = new Set(["_e2b-errors.ts", "README.md"]);

interface ToolSnapshot {
  desc_tokens: number;
  schema_describes_tokens: number;
  total_tokens: number;
}

interface SkillSnapshot {
  desc_tokens: number;
}

const STRING_LITERAL_RE =
  /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

const concatStringLiterals = (block: string): string => {
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  STRING_LITERAL_RE.lastIndex = 0;
  while ((match = STRING_LITERAL_RE.exec(block)) !== null) {
    const literal = match[1] ?? match[2] ?? match[3] ?? "";
    parts.push(literal);
  }
  // The runtime joins array literals with "\n" via .join("\n"); we
  // mirror that join when the block had multiple parts. Single
  // literals keep their byte-exact content.
  return parts.length > 1 ? parts.join("\n") : (parts[0] ?? "");
};

const readBlockFromIndex = (
  source: string,
  start: number,
): { block: string; isIdentifier: boolean } => {
  const stop = source.indexOf("\n    inputSchema:", start);
  const fallback = source.indexOf("\n    execute:", start);
  const end = stop === -1 ? (fallback === -1 ? source.length : fallback) : stop;
  const block = source.slice(start, end);
  const hasLiteral = /[`"']/.test(block);
  return { block, isIdentifier: !hasLiteral };
};

const extractDescriptionBlock = (
  source: string,
): { block: string; isIdentifier: boolean } | null => {
  const descIdx = source.indexOf("\n    description:");
  if (descIdx !== -1) return readBlockFromIndex(source, descIdx + 1);
  const looser = source.indexOf("description:");
  if (looser === -1) return null;
  return readBlockFromIndex(source, looser);
};

/** The body of `const <ident> = …;`, or "" when there is no such const. */
const resolveConstBody = (source: string, ident: string): string => {
  // `indexOf("const " + ident)` would match `const editingDescription`
  // for the identifier `editing`; the boundary keeps a prefix from
  // resolving to a longer neighbour. `ident` is already known to be
  // `[A-Za-z_][A-Za-z0-9_]*`, so it carries no regex metacharacters.
  const declared = new RegExp(`const\\s+${ident}\\b`).exec(source);
  if (!declared) return "";
  const bodyStart = source.indexOf("=", declared.index);
  if (bodyStart === -1) return "";
  // Walk forward tracking bracket depth; stop at the first `;` at
  // depth 0. Handles `[...].join("\n")` cleanly.
  let depth = 0;
  let i = bodyStart;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ";" && depth === 0) break;
    i++;
  }
  return source.slice(bodyStart, i);
};

/**
 * A description can be a ternary over two named consts — `managePage`
 * serves a narrower surface to the parent agent than to the page builder
 * (see `createManagePageTool`). Every identifier in the block is resolved
 * and the LARGEST variant wins: this table is a per-tool budget, and the
 * budget is the most any model is ever handed.
 *
 * Before this, the single-identifier regex captured `config` out of
 * `config.authoring ? … : …`, found no `const config`, and reported
 * `manage-page` at ZERO description tokens — the tool with the longest
 * description in the registry, silently exempt from its own budget.
 */
const resolveIdentifierBlock = (source: string, block: string): string => {
  const afterKey = block.slice(block.indexOf("description:"));
  const idents = afterKey.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  let widest = "";
  for (const ident of idents) {
    const text = concatStringLiterals(resolveConstBody(source, ident));
    if (text.length > widest.length) widest = text;
  }
  return widest;
};

const extractDescriptionText = (source: string): string => {
  const head = extractDescriptionBlock(source);
  if (!head) return "";
  // An identifier block is resolved all the way to its literals; an
  // inline block still has to be concatenated.
  return head.isIdentifier
    ? resolveIdentifierBlock(source, head.block)
    : concatStringLiterals(head.block);
};

// Match `.describe("...")` or `.describe('...')`, tolerating any
// trailing chars (e.g. a trailing comma + newline + indent + `)`).
// We only need the literal body — what follows the closing quote is
// irrelevant to the token count.
const SCHEMA_DESCRIBE_RE =
  /\.describe\(\s*("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;

const extractSchemaDescribesText = (source: string): string => {
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  SCHEMA_DESCRIBE_RE.lastIndex = 0;
  while ((match = SCHEMA_DESCRIBE_RE.exec(source)) !== null) {
    const literal = match[2] ?? match[3] ?? "";
    parts.push(literal);
  }
  return parts.join("\n");
};

const measureTools = async (): Promise<{
  per_tool: Record<string, ToolSnapshot>;
  total_desc_tokens: number;
  total_schema_tokens: number;
  total_tokens: number;
}> => {
  const glob = new Glob("*.ts");
  const files: string[] = [];
  for (const name of glob.scanSync({ cwd: TOOLS_DIR, onlyFiles: true })) {
    if (!TOOL_FILE_BLACKLIST.has(name)) files.push(name);
  }
  files.sort();
  const sources = await Promise.all(
    files.map((file) => Bun.file(`${TOOLS_DIR}/${file}`).text()),
  );
  const per_tool: Record<string, ToolSnapshot> = {};
  let totalDesc = 0;
  let totalSchema = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const source = sources[i];
    const descText = extractDescriptionText(source);
    const schemaText = extractSchemaDescribesText(source);
    const desc_tokens = tokensOf(descText);
    const schema_describes_tokens = tokensOf(schemaText);
    per_tool[file.replace(/\.ts$/, "")] = {
      desc_tokens,
      schema_describes_tokens,
      total_tokens: desc_tokens + schema_describes_tokens,
    };
    totalDesc += desc_tokens;
    totalSchema += schema_describes_tokens;
  }
  return {
    per_tool,
    total_desc_tokens: totalDesc,
    total_schema_tokens: totalSchema,
    total_tokens: totalDesc + totalSchema,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Frontmatter descriptions can be YAML block scalars (multi-line) —
 * parse with Bun.YAML like the runtime catalogue sync does, never with
 * a single-line regex.
 */
const readFrontmatterDescription = (source: string): string | null => {
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(match[1] ?? "");
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.description !== "string") return null;
  return parsed.description.trim();
};

const measureSkills = async (): Promise<{
  per_skill: Record<string, SkillSnapshot>;
  total_tokens: number;
}> => {
  // List subdirectories of bundled/ by globbing for SKILL.md and
  // pulling the parent directory name from each match.
  const glob = new Glob("*/SKILL.md");
  const skills: string[] = [];
  for (const relPath of glob.scanSync({ cwd: SKILLS_DIR, onlyFiles: true })) {
    const skillName = relPath.split("/")[0];
    if (skillName) skills.push(skillName);
  }
  skills.sort();
  const sources = await Promise.all(
    skills.map(async (name) => {
      const file = Bun.file(`${SKILLS_DIR}/${name}/SKILL.md`);
      return (await file.exists()) ? file.text() : null;
    }),
  );
  const per_skill: Record<string, SkillSnapshot> = {};
  let total = 0;
  for (let i = 0; i < skills.length; i++) {
    const source = sources[i];
    if (source === null) continue;
    const description = readFrontmatterDescription(source);
    if (description === null) {
      console.error(`[measure] ${skills[i]}: unreadable frontmatter, skipped`);
      continue;
    }
    const tokens = tokensOf(description);
    per_skill[skills[i]] = { desc_tokens: tokens };
    total += tokens;
  }
  return { per_skill, total_tokens: total };
};

/**
 * The page builder's own prefix, which had no instrument until 2026-09-04.
 *
 * It is not a section of the unified template — it is a second agent with a
 * second prompt, assembled in `prompt-renderer.ts` out of four blocks, three
 * of them RENDERED from files rather than written in the `.md`. That
 * assembly is what made it invisible here: nothing reads the four together
 * except the runtime, so the surface this agent pays for on every one of its
 * ~40 calls per build was the only unbudgeted one in the product.
 *
 * Safe to import: all three renderers read files at module load and pull in no
 * DB, Redis or S3 client — the same property that lets `prompt-blocks.ts` be
 * imported above, checked the same way (a fresh shell, no env file).
 */
const measurePageBuilder = async (): Promise<Record<string, number>> => {
  const [
    { renderComponentCatalogue },
    { renderPageDesignDoctrine },
    { renderPageEnvironmentContract },
  ] = await Promise.all([
    import("../src/tools/page-component-catalogue"),
    import("../src/agents/chatbot/page-design-doctrine"),
    import("../src/tools/page-environment-guide"),
  ]);
  const prompt = (await Bun.file(PAGE_BUILDER_PROMPT_PATH).text())
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();

  const blocks = {
    system_prompt: tokensOf(prompt),
    environment_contract: tokensOf(renderPageEnvironmentContract()),
    design_doctrine: tokensOf(renderPageDesignDoctrine()),
    component_catalogue: tokensOf(renderComponentCatalogue()),
  };
  return {
    ...blocks,
    _total_tokens: Object.values(blocks).reduce((sum, n) => sum + n, 0),
  };
};

const main = async (): Promise<void> => {
  const template = await Bun.file(SYSTEM_PROMPT_PATH).text();
  const chatbot = measureAgentPrompt(template, "chatbot");
  const workflow = measureAgentPrompt(template, "workflow");
  const tools = await measureTools();
  const skills = await measureSkills();
  const pageBuilder = await measurePageBuilder();

  const output = {
    tokenizer: "o200k_base (gpt-tokenizer)",
    measured_at: new Date().toISOString(),
    agents: { chatbot, workflow },
    tools: {
      per_tool: tools.per_tool,
      _total_desc_tokens: tools.total_desc_tokens,
      _total_schema_tokens: tools.total_schema_tokens,
      _total_tokens: tools.total_tokens,
    },
    skills_catalog: {
      per_skill: skills.per_skill,
      _total_tokens: skills.total_tokens,
    },
    page_builder: pageBuilder,
    // Chatbot's turn-0 static surface: resolved prompt + every tool
    // description + the L1 skills catalog. Runtime adds the expanded
    // dynamic suffix on top.
    grand_total_tokens:
      chatbot.resolved_tokens + tools.total_tokens + skills.total_tokens,
  };

  console.log(JSON.stringify(output, null, 2));
};

await main();
