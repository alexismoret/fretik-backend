#!/usr/bin/env bun
/**
 * Dump a chatbot conversation (parent row + messages) to a versioned
 * JSON fixture under `evals/fixtures/conversations/`. Used by S8 Task
 * 3 to seed the golden dataset (`alliance-logistics.json` + 4 others)
 * that `replay-conversations.ts` (S8 Task 4) feeds back through the
 * agent to measure RAG hit counts vs the post-refactor baseline.
 *
 * Pattern: standalone Bun script, no boot side effects until the DB
 * is actually queried — matches `measure-system-prompt-tokens.ts`.
 *
 * Usage:
 *   bun run dump:conversation <conversationId> [--output <path>] [--redact|--no-redact]
 *
 * Defaults:
 *   --redact ON. PII regex passes (emails, IBANs, French SIREN/SIRET,
 *   phone numbers) replace matches with stable placeholders so
 *   re-running the dump on the same conversation yields a stable diff.
 *   `--no-redact` is provided as an explicit escape hatch for local
 *   debugging — NEVER commit a non-redacted dump to the repo.
 *
 * Output JSON shape (see `evals/fixtures/conversations/<slug>.json`):
 *   {
 *     conversationId, capturedAt, captureRefactorVersion: "S8",
 *     redacted: boolean,
 *     conversation: { id, title, agentType, organizationId, teamId,
 *                     userId, createdAt, updatedAt },
 *     messages: [{ id, role, parts, metadata, createdAt }],
 *     summary: { totalTurns, turnsWithSearchKnowledge, turnsWithMemory,
 *                searchKnowledgeCalls, memoryCalls }
 *   }
 *
 * The summary is derived from the captured messages so the replay
 * runner can assert pre/post deltas without re-walking parts.
 */

import db from "@fretik/shared/db";
import { aiMessages } from "@fretik/shared/db/schema";
import { asc, eq } from "drizzle-orm";

const PROJECT_ROOT = `${import.meta.dir}/..`;

interface CliOptions {
  conversationId: string;
  outputPath: string | null;
  redact: boolean;
}

const printUsage = (): void => {
  console.error(
    `Usage: bun run dump:conversation <conversationId> [--output <path>] [--redact|--no-redact]`,
  );
};

const parseArgs = (argv: string[]): CliOptions => {
  let conversationId: string | null = null;
  let outputPath: string | null = null;
  let redact = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output") {
      const next = argv[i + 1];
      if (next === undefined) {
        printUsage();
        throw new Error("--output requires a path argument");
      }
      outputPath = next;
      i += 1;
    } else if (arg === "--redact") {
      redact = true;
    } else if (arg === "--no-redact") {
      redact = false;
    } else if (arg && !arg.startsWith("--")) {
      if (conversationId !== null) {
        printUsage();
        throw new Error(`Unexpected positional argument: ${arg}`);
      }
      conversationId = arg;
    } else {
      printUsage();
      throw new Error(`Unknown flag: ${arg ?? "<empty>"}`);
    }
  }
  if (conversationId === null) {
    printUsage();
    throw new Error("conversationId is required");
  }
  return { conversationId, outputPath, redact };
};

/**
 * PII redaction passes. Order matters — narrower patterns first so
 * the broader phone regex doesn't swallow a SIREN-shaped substring.
 */
const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  // Emails — RFC-compliant-enough.
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "<email>"],
  // IBAN (FR + most EU shapes, 14-34 alphanumerics, with optional
  // spaces between groups of 4).
  [/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,8}\b/g, "<iban>"],
  // French SIRET (14 digits) — checked before SIREN so the SIREN
  // regex doesn't strip the leading 9 digits.
  [/\b\d{14}\b/g, "<siret>"],
  // French SIREN (9 digits).
  [/\b\d{9}\b/g, "<siren>"],
  // French phone numbers (loose: 0X XX XX XX XX, +33 ..., or
  // continuous 10 digits).
  [/\b(?:\+33[ -]?|0)[1-9](?:[ -]?\d{2}){4}\b/g, "<phone>"],
];

const redactString = (s: string): string => {
  let out = s;
  for (const [re, sub] of REDACTION_PATTERNS) {
    out = out.replace(re, sub);
  }
  return out;
};

/**
 * Walk an arbitrary JSON value and apply `redactString` to every
 * string leaf. Objects and arrays are reconstructed (no in-place
 * mutation of the row pulled from the DB).
 */
const redactDeep = (value: unknown): unknown => {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
};

interface MessageDump {
  id: string;
  role: string;
  parts: unknown;
  metadata: unknown;
  createdAt: string;
}

const summariseMessages = (
  messages: MessageDump[],
): {
  totalTurns: number;
  turnsWithSearchKnowledge: number;
  turnsWithMemory: number;
  searchKnowledgeCalls: number;
  memoryCalls: number;
} => {
  let totalTurns = 0;
  let turnsWithSearchKnowledge = 0;
  let turnsWithMemory = 0;
  let searchKnowledgeCalls = 0;
  let memoryCalls = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    totalTurns += 1;
    let sawSearch = false;
    let sawMemory = false;
    if (Array.isArray(m.parts)) {
      for (const p of m.parts) {
        if (
          p &&
          typeof p === "object" &&
          "type" in p &&
          typeof (p as { type: unknown }).type === "string"
        ) {
          const t = (p as { type: string }).type;
          if (t === "tool-searchKnowledge") {
            sawSearch = true;
            searchKnowledgeCalls += 1;
          } else if (t === "tool-memory") {
            sawMemory = true;
            memoryCalls += 1;
          }
        }
      }
    }
    if (sawSearch) turnsWithSearchKnowledge += 1;
    if (sawMemory) turnsWithMemory += 1;
  }
  return {
    totalTurns,
    turnsWithSearchKnowledge,
    turnsWithMemory,
    searchKnowledgeCalls,
    memoryCalls,
  };
};

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";

const main = async (): Promise<void> => {
  const opts = parseArgs(Bun.argv.slice(2));

  const conv = await db.query.aiConversations.findFirst({
    where: { id: opts.conversationId },
  });
  if (!conv) {
    throw new Error(`conversation not found: ${opts.conversationId}`);
  }

  const rows = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, opts.conversationId))
    .orderBy(asc(aiMessages.createdAt));

  const messagesRaw: MessageDump[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    parts: r.parts,
    metadata: r.metadata,
    createdAt: r.createdAt.toISOString(),
  }));

  const messages = opts.redact
    ? (redactDeep(messagesRaw) as MessageDump[])
    : messagesRaw;

  const summary = summariseMessages(messages);

  const fixture = {
    conversationId: conv.id,
    capturedAt: new Date().toISOString(),
    captureRefactorVersion: "S8" as const,
    redacted: opts.redact,
    conversation: {
      id: conv.id,
      title: opts.redact ? redactString(conv.title) : conv.title,
      agentType: conv.agentType,
      organizationId: conv.organizationId,
      teamId: conv.teamId,
      userId: conv.userId,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
    },
    messages,
    summary,
  };

  const outputPath =
    opts.outputPath ??
    `${PROJECT_ROOT}/evals/fixtures/conversations/${slugify(conv.title)}.json`;

  await Bun.write(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
  console.error(
    `[dump-conversation] wrote ${outputPath} (turns=${summary.totalTurns.toString()}, redacted=${opts.redact.toString()})`,
  );
  console.log(outputPath);
};

await main();
