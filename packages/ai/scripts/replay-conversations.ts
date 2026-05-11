#!/usr/bin/env bun
/**
 * Replay golden conversations against a running `@fretik/ai` instance
 * and aggregate per-turn telemetry from `ai_messages.metadata.telemetry`
 * (which `enrichAssistantMetadata` populates as part of S8 Task 1).
 *
 * Counters (`ragHits` per source type, `toolCallsByName`,
 * `memoryCommands`) are deterministic by construction of the retriever
 * scope filter — so even though MiniMax M2.7 will produce different
 * answer text on each replay, the metric deltas (post-refactor vs the
 * captured fixture's `summary`) are usable as a regression signal.
 *
 * Usage:
 *   bun run replay:conversations [--fixture <name>...] [--output <path>]
 *
 *   --fixture          Restrict to one or more fixture names (basename
 *                      without `.json`). Repeatable. Default: all
 *                      `evals/fixtures/conversations/*.json`.
 *   --output           Path for the aggregate JSON report.
 *                      Default: stdout.
 *
 * Required env vars (same as evals/http-client.ts):
 *   AI_SERVICE_URL, INTERNAL_KEY, EVAL_TEAM_ID, EVAL_ORGANIZATION_ID
 *   Optional: EVAL_USER_ID, EVAL_USER_NAME, EVAL_TIMEZONE
 *
 * Output JSON shape:
 *   {
 *     replayedAt, fixtures: [{
 *       name, conversationId, turns,
 *       baseline: { totalTurns, searchKnowledgeCalls, memoryCalls, ... },
 *       metrics: { memoryRagHits_total, skillRagHits_total, ...,
 *                  searchKnowledgeCalls, memoryToolCalls,
 *                  totalLatencyMs },
 *     }],
 *     aggregates: { memory_rag_hits_per_turn_median,
 *                   memory_tool_view_calls_total }
 *   }
 *
 * Pattern: standalone Bun script. NEVER imports from the AI service
 * runtime (boot side effects); talks to it strictly over HTTP and to
 * Postgres directly via the `pg` client.
 */

import { Glob } from "bun";
import { Client } from "pg";

const PROJECT_ROOT = `${import.meta.dir}/..`;
const FIXTURES_DIR = `${PROJECT_ROOT}/evals/fixtures/conversations`;

interface CliOptions {
  fixtures: string[] | null;
  outputPath: string | null;
}

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
};

const parseArgs = (argv: string[]): CliOptions => {
  let outputPath: string | null = null;
  const fixtures: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--output requires a path");
      outputPath = next;
      i += 1;
    } else if (arg === "--fixture") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--fixture requires a name");
      fixtures.push(next);
      i += 1;
    } else {
      throw new Error(`Unknown flag: ${arg ?? "<empty>"}`);
    }
  }
  return {
    fixtures: fixtures.length > 0 ? fixtures : null,
    outputPath,
  };
};

interface FixtureFile {
  conversationId: string;
  capturedAt: string;
  redacted: boolean;
  conversation: {
    title: string;
    teamId: string;
    organizationId: string;
    userId: string | null;
  };
  messages: Array<{
    id: string;
    role: string;
    parts: unknown;
    metadata: unknown;
  }>;
  summary: {
    totalTurns: number;
    turnsWithSearchKnowledge: number;
    turnsWithMemory: number;
    searchKnowledgeCalls: number;
    memoryCalls: number;
  };
}

const loadFixtures = async (
  filter: string[] | null,
): Promise<Array<{ name: string; data: FixtureFile }>> => {
  const glob = new Glob("*.json");
  const out: Array<{ name: string; data: FixtureFile }> = [];
  for await (const filename of glob.scan(FIXTURES_DIR)) {
    const name = filename.replace(/\.json$/, "");
    if (filter && !filter.includes(name)) continue;
    const text = await Bun.file(`${FIXTURES_DIR}/${filename}`).text();
    out.push({ name, data: JSON.parse(text) as FixtureFile });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

const extractText = (parts: unknown): string => {
  if (!Array.isArray(parts)) return "";
  const chunks: string[] = [];
  for (const p of parts) {
    if (
      p &&
      typeof p === "object" &&
      "type" in p &&
      (p as { type: unknown }).type === "text" &&
      "text" in p &&
      typeof (p as { text: unknown }).text === "string"
    ) {
      chunks.push((p as { text: string }).text);
    }
  }
  return chunks.join("\n").trim();
};

const buildHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    "X-Internal-Key": requireEnv("INTERNAL_KEY"),
    "X-Context-Team-Id": requireEnv("EVAL_TEAM_ID"),
    "X-Context-Organization-Id": requireEnv("EVAL_ORGANIZATION_ID"),
  };
  if (process.env.EVAL_USER_ID)
    headers["X-Context-User-Id"] = process.env.EVAL_USER_ID;
  if (process.env.EVAL_USER_NAME)
    headers["X-Context-User-Name"] = process.env.EVAL_USER_NAME;
  if (process.env.EVAL_TIMEZONE)
    headers["X-Context-Timezone"] = process.env.EVAL_TIMEZONE;
  return headers;
};

interface AggregatedTelemetry {
  ragHits: Record<string, number>;
  ragHitsTotal: number;
  toolCallsByName: Record<string, number>;
  memoryCommands: Record<string, number>;
  steps: number;
  assistantMessages: number;
}

const emptyAgg = (): AggregatedTelemetry => ({
  ragHits: {},
  ragHitsTotal: 0,
  toolCallsByName: {},
  memoryCommands: {},
  steps: 0,
  assistantMessages: 0,
});

const mergeTelemetry = (agg: AggregatedTelemetry, raw: unknown): void => {
  if (!raw || typeof raw !== "object") return;
  const t = raw as Record<string, unknown>;
  agg.assistantMessages += 1;
  if (typeof t.steps === "number") agg.steps += t.steps;
  if (t.ragHits && typeof t.ragHits === "object") {
    for (const [k, v] of Object.entries(t.ragHits as Record<string, unknown>)) {
      if (typeof v !== "number") continue;
      if (k === "total") agg.ragHitsTotal += v;
      else agg.ragHits[k] = (agg.ragHits[k] ?? 0) + v;
    }
  }
  if (t.toolCallsByName && typeof t.toolCallsByName === "object") {
    for (const [k, v] of Object.entries(
      t.toolCallsByName as Record<string, unknown>,
    )) {
      if (typeof v === "number")
        agg.toolCallsByName[k] = (agg.toolCallsByName[k] ?? 0) + v;
    }
  }
  if (t.memoryCommands && typeof t.memoryCommands === "object") {
    for (const [k, v] of Object.entries(
      t.memoryCommands as Record<string, unknown>,
    )) {
      if (typeof v === "number")
        agg.memoryCommands[k] = (agg.memoryCommands[k] ?? 0) + v;
    }
  }
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
};

interface ReplayedFixture {
  name: string;
  conversationId: string;
  turns: number;
  durationMs: number;
  baseline: FixtureFile["summary"];
  metrics: AggregatedTelemetry & { totalLatencyMs: number };
}

const replayFixture = async (
  fx: { name: string; data: FixtureFile },
  client: Client,
): Promise<ReplayedFixture> => {
  const aiServiceUrl = requireEnv("AI_SERVICE_URL");
  const teamId = requireEnv("EVAL_TEAM_ID");
  const organizationId = requireEnv("EVAL_ORGANIZATION_ID");
  const userId = process.env.EVAL_USER_ID ?? null;

  const userMessages = fx.data.messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) {
    throw new Error(`Fixture ${fx.name} has no user messages`);
  }

  // Create a fresh ephemeral conversation row directly via SQL — same
  // strategy as evals/conversation-lifecycle.ts but without importing
  // it (to avoid pulling shared/db init into this script's boot path).
  const insertConv = await client.query<{ id: string }>(
    `INSERT INTO ai_conversations
       (organization_id, team_id, user_id, agent_type, title)
     VALUES ($1, $2, $3, 'chatbot', $4)
     RETURNING id;`,
    [organizationId, teamId, userId, `[replay-s8] ${fx.name}`.slice(0, 200)],
  );
  const conversationId = insertConv.rows[0]?.id;
  if (!conversationId) throw new Error("Failed to create ephemeral conv");

  const startedAt = Date.now();
  try {
    for (const userMsg of userMessages) {
      const text = extractText(userMsg.parts);
      if (text.length === 0) continue;

      // Append the user message to ai_messages so the chatbot handler
      // sees the full history when /invoke runs (chatbot.ts loads
      // history via loadConversationForAgent when conversationId is
      // present and IGNORES the request body's `messages` field).
      await client.query(
        `INSERT INTO ai_messages (conversation_id, role, parts, metadata)
         VALUES ($1, 'user', $2::jsonb, $3::jsonb);`,
        [
          conversationId,
          JSON.stringify([{ type: "text", text }]),
          JSON.stringify({}),
        ],
      );

      // Drive a single turn via /invoke. We don't parse the SSE stream
      // because the post-turn telemetry we care about is persisted in
      // `ai_messages.metadata.telemetry` (Task 1.A `enrichAssistantMetadata`).
      // Drain quickly without buffering.
      const res = await fetch(
        `${aiServiceUrl}/internal/agents/chatbot/invoke`,
        {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify({
            conversationId,
            messages: [
              {
                id: crypto.randomUUID(),
                role: "user",
                parts: [{ type: "text", text }],
                metadata: {},
              },
            ],
          }),
        },
      );
      if (!res.ok || !res.body) {
        throw new Error(
          `Replay /invoke failed for fixture ${fx.name}: HTTP ${res.status.toString()}`,
        );
      }
      // Drain the stream so the server's onFinish fires before we
      // read the persisted assistant metadata.
      const reader = res.body.getReader();
      while (true) {
        const r = await reader.read();
        if (r.done) break;
      }
    }
    const durationMs = Date.now() - startedAt;

    // Aggregate persisted telemetry across every assistant message
    // produced during this replay session.
    const assistantRows = await client.query<{
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT metadata FROM ai_messages
       WHERE conversation_id = $1 AND role = 'assistant'
       ORDER BY created_at ASC;`,
      [conversationId],
    );
    const agg = emptyAgg();
    for (const row of assistantRows.rows) {
      const md = row.metadata;
      if (md && typeof md === "object" && "telemetry" in md) {
        mergeTelemetry(agg, (md as { telemetry: unknown }).telemetry);
      }
    }
    return {
      name: fx.name,
      conversationId,
      turns: userMessages.length,
      durationMs,
      baseline: fx.data.summary,
      metrics: { ...agg, totalLatencyMs: durationMs },
    };
  } finally {
    // Cascade-delete the ephemeral conversation row + its messages.
    await client
      .query(`DELETE FROM ai_conversations WHERE id = $1`, [conversationId])
      .catch((err: unknown) => {
        console.warn(
          `[replay] cleanup failed for ${fx.name}:`,
          err instanceof Error ? err.message : err,
        );
      });
  }
};

const main = async (): Promise<void> => {
  const opts = parseArgs(Bun.argv.slice(2));
  const fixtures = await loadFixtures(opts.fixtures);
  if (fixtures.length === 0) {
    console.error("[replay] no fixtures to replay");
    process.exit(1);
  }

  const databaseUrl = requireEnv("DATABASE_URL");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const replayed: ReplayedFixture[] = [];
  try {
    for (const fx of fixtures) {
      console.error(
        `[replay] running ${fx.name} (${fx.data.summary.totalTurns.toString()} historical turns)`,
      );
      const result = await replayFixture(fx, client);
      replayed.push(result);
    }
  } finally {
    await client.end();
  }

  const memoryRagPerTurn: number[] = [];
  let memoryViewCallsTotal = 0;
  for (const r of replayed) {
    if (r.metrics.assistantMessages > 0) {
      memoryRagPerTurn.push(
        (r.metrics.ragHits.memories ?? 0) / r.metrics.assistantMessages,
      );
    }
    memoryViewCallsTotal += r.metrics.memoryCommands.view ?? 0;
  }

  const report = {
    replayedAt: new Date().toISOString(),
    fixtures: replayed,
    aggregates: {
      memory_rag_hits_per_turn_median: median(memoryRagPerTurn),
      memory_tool_view_calls_total: memoryViewCallsTotal,
    },
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (opts.outputPath) {
    await Bun.write(opts.outputPath, json);
    console.error(`[replay] wrote ${opts.outputPath}`);
  } else {
    console.log(json);
  }
};

await main();
