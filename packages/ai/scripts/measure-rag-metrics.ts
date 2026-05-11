#!/usr/bin/env bun
/**
 * Aggregate `metadata.telemetry` rolled in by `enrichAssistantMetadata`
 * (S8 Task 1.A) across a rolling production window — companion to
 * `measure:tokens` (the static-prefix counterpart).
 *
 * Two views, one in each output:
 *  1. Per-source RAG hits per turn (mean / median / p95).
 *  2. Memory tool command counts (view/create/overwrite/delete/rename
 *     totals + per-turn means). The `view` count is the surveillance
 *     metric set up in S6 deviation #1: if it stays high relative to
 *     `searchKnowledge` calls, the model is still relying on the memory
 *     tool for retrieval and we want to know.
 *
 * Output JSON shape mirrors `measure-system-prompt-tokens.ts` for
 * consistency.
 *
 * Usage:
 *   bun run measure:rag [--days <N>] [--output <path>]
 *
 *   --days     Rolling window in days (default 7).
 *   --output   File path to write the JSON; default stdout.
 *
 * Required env: DATABASE_URL.
 */

import { Client } from "pg";

interface CliOptions {
  days: number;
  outputPath: string | null;
}

const parseArgs = (argv: string[]): CliOptions => {
  let days = 7;
  let outputPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--days requires an integer");
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --days value: ${next}`);
      }
      days = parsed;
      i += 1;
    } else if (arg === "--output") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--output requires a path");
      outputPath = next;
      i += 1;
    } else {
      throw new Error(`Unknown flag: ${arg ?? "<empty>"}`);
    }
  }
  return { days, outputPath };
};

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
};

const SOURCE_TYPES = [
  "documents",
  "extractions",
  "memories",
  "skills",
  "context",
] as const;

const MEMORY_COMMANDS = [
  "view",
  "create",
  "overwrite",
  "delete",
  "rename",
] as const;

interface Snapshot {
  measured_at: string;
  rolling_window_days: number;
  total_assistant_messages: number;
  rag_hits_per_turn: Record<
    string,
    { mean: number; median: number; p95: number; total: number }
  >;
  rag_hits_per_turn_total: { mean: number; median: number; p95: number };
  memory_commands_per_turn: Record<string, { mean: number; total: number }>;
  tool_calls_total: Record<string, number>;
  memory_view_to_search_ratio: number | null;
  notes: string[];
}

const stats = (
  xs: number[],
): { mean: number; median: number; p95: number; total: number } => {
  if (xs.length === 0) return { mean: 0, median: 0, p95: 0, total: 0 };
  const total = xs.reduce((s, x) => s + x, 0);
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    mean: total / xs.length,
    median,
    p95: sorted[p95Idx] ?? 0,
    total,
  };
};

const numFromTelemetry = (telemetry: unknown, ...path: string[]): number => {
  let cursor: unknown = telemetry;
  for (const segment of path) {
    if (!cursor || typeof cursor !== "object") return 0;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "number" ? cursor : 0;
};

const main = async (): Promise<void> => {
  const opts = parseArgs(Bun.argv.slice(2));
  const databaseUrl = requireEnv("DATABASE_URL");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  // Pull the metadata blob for every assistant message in the window.
  // Casting through `Record<string, unknown>` keeps the script honest
  // — telemetry shape evolves, so we only address known keys defensively.
  const rows = await client.query<{
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT metadata FROM ai_messages
     WHERE role = 'assistant'
       AND created_at > NOW() - ($1::int || ' days')::interval;`,
    [opts.days],
  );
  await client.end();

  const total = rows.rows.length;
  const ragHitsBySource: Record<string, number[]> = {};
  for (const t of SOURCE_TYPES) ragHitsBySource[t] = [];
  const ragHitsTotal: number[] = [];
  const memoryCmds: Record<string, number[]> = {};
  for (const c of MEMORY_COMMANDS) memoryCmds[c] = [];
  const toolCallsTotal: Record<string, number> = {};

  for (const row of rows.rows) {
    const md = row.metadata;
    if (!md || typeof md !== "object" || !("telemetry" in md)) continue;
    const telemetry = (md as { telemetry: unknown }).telemetry;
    let perTurnTotal = 0;
    for (const t of SOURCE_TYPES) {
      const v = numFromTelemetry(telemetry, "ragHits", t);
      ragHitsBySource[t]!.push(v);
      perTurnTotal += v;
    }
    ragHitsTotal.push(perTurnTotal);
    for (const c of MEMORY_COMMANDS) {
      memoryCmds[c]!.push(numFromTelemetry(telemetry, "memoryCommands", c));
    }
    if (
      telemetry &&
      typeof telemetry === "object" &&
      "toolCallsByName" in telemetry &&
      typeof (telemetry as { toolCallsByName: unknown }).toolCallsByName ===
        "object"
    ) {
      const tcb = (telemetry as { toolCallsByName: Record<string, unknown> })
        .toolCallsByName;
      for (const [name, n] of Object.entries(tcb)) {
        if (typeof n === "number") {
          toolCallsTotal[name] = (toolCallsTotal[name] ?? 0) + n;
        }
      }
    }
  }

  const ragHitsPerTurn: Snapshot["rag_hits_per_turn"] = {};
  for (const t of SOURCE_TYPES) {
    ragHitsPerTurn[t] = stats(ragHitsBySource[t] ?? []);
  }
  const memoryCommandsPerTurn: Snapshot["memory_commands_per_turn"] = {};
  for (const c of MEMORY_COMMANDS) {
    const s = stats(memoryCmds[c] ?? []);
    memoryCommandsPerTurn[c] = { mean: s.mean, total: s.total };
  }
  const memoryViewTotal = memoryCommandsPerTurn.view?.total ?? 0;
  const searchTotal = toolCallsTotal.searchKnowledge ?? 0;
  const ratio = searchTotal === 0 ? null : memoryViewTotal / searchTotal;

  const notes: string[] = [];
  if (total === 0) {
    notes.push(
      `No assistant messages found in last ${opts.days.toString()}d — telemetry persistence may not be active yet, or no live traffic in the window.`,
    );
  }
  if (ratio !== null && ratio > 0.5) {
    notes.push(
      "memory_view_to_search_ratio > 0.5 — model still leans on memory.view. Investigate; consider re-introducing memory grep (S6 deviation #1 surveillance trigger).",
    );
  }

  const snapshot: Snapshot = {
    measured_at: new Date().toISOString(),
    rolling_window_days: opts.days,
    total_assistant_messages: total,
    rag_hits_per_turn: ragHitsPerTurn,
    rag_hits_per_turn_total: stats(ragHitsTotal),
    memory_commands_per_turn: memoryCommandsPerTurn,
    tool_calls_total: toolCallsTotal,
    memory_view_to_search_ratio: ratio,
    notes,
  };

  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (opts.outputPath) {
    await Bun.write(opts.outputPath, json);
    console.error(`[measure-rag] wrote ${opts.outputPath}`);
  } else {
    console.log(json);
  }
};

await main();
