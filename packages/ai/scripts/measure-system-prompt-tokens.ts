#!/usr/bin/env bun
/**
 * Token-usage measurer for the chatbot's static prefix.
 *
 * Three independent surfaces compose the cacheable static prefix:
 *  - the rendered system prompt (HTML comments stripped, like the
 *    runtime renderer in agents/shared/prompt-renderer.ts)
 *  - every chatbot tool's `description` field plus its Zod
 *    `.describe()` strings (tracked separately)
 *  - the `description` line in each bundled SKILL.md frontmatter
 *    (the L1 catalog injected as `- **name** — description`)
 *
 * Token counts use the `o200k_base` encoder (GPT-4o / recent OpenAI
 * models). Although MiniMax M2.7 and DeepSeek have their own BPEs,
 * o200k_base is publicly available, stable across measurements, and
 * gives realistic numbers for English/French text — exactly what a
 * delta tracker needs.
 *
 * Usage: `bun run measure:tokens` (writes a JSON snapshot to stdout).
 *
 * Implementation note: the script reads source files as text and
 * extracts description literals with regex. Importing the tool
 * factories would be cleaner but would also pull in DB / Redis /
 * S3 setup at module init through their `@fretik/shared` deps — the
 * script must stay runnable in a fresh shell with no env file.
 */

import { Glob } from "bun";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

const PROJECT_ROOT = `${import.meta.dir}/..`;
const SYSTEM_PROMPT_PATH = `${PROJECT_ROOT}/src/agents/shared/agent-system-prompt.md`;
const TOOLS_DIR = `${PROJECT_ROOT}/src/tools`;
const SKILLS_DIR = `${PROJECT_ROOT}/src/skills/bundled`;

const HTML_COMMENT_RE = /<!--[\s\S]*?-->\n?/g;

const tokensOf = (text: string): number =>
  text.length === 0 ? 0 : encode(text).length;

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

const resolveIdentifierBlock = (source: string, block: string): string => {
  const identMatch = block.match(/description:\s*([A-Za-z_][A-Za-z0-9_]*)/);
  if (!identMatch) return "";
  const ident = identMatch[1];
  const constIdx = source.indexOf(`const ${ident}`);
  if (constIdx === -1) return "";
  const bodyStart = source.indexOf("=", constIdx);
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

const extractDescriptionText = (source: string): string => {
  const head = extractDescriptionBlock(source);
  if (!head) return "";
  const target = head.isIdentifier
    ? resolveIdentifierBlock(source, head.block)
    : head.block;
  return concatStringLiterals(target);
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

const measureSystemPrompt = async (): Promise<{
  chars: number;
  tokens: number;
}> => {
  const raw = await Bun.file(SYSTEM_PROMPT_PATH).text();
  const stripped = raw.replace(HTML_COMMENT_RE, "");
  return { chars: stripped.length, tokens: tokensOf(stripped) };
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
    const frontmatterMatch = source.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) continue;
    const frontmatter = frontmatterMatch[1];
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
    const description = descMatch ? descMatch[1].trim() : "";
    const tokens = tokensOf(description);
    per_skill[skills[i]] = { desc_tokens: tokens };
    total += tokens;
  }
  return { per_skill, total_tokens: total };
};

const main = async (): Promise<void> => {
  const system_prompt = await measureSystemPrompt();
  const tools = await measureTools();
  const skills = await measureSkills();
  const grand_total =
    system_prompt.tokens + tools.total_tokens + skills.total_tokens;

  const output = {
    tokenizer: "o200k_base (gpt-tokenizer)",
    measured_at: new Date().toISOString(),
    system_prompt,
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
    grand_total_tokens: grand_total,
  };

  console.log(JSON.stringify(output, null, 2));
};

await main();
