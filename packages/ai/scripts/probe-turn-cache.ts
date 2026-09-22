#!/usr/bin/env bun
/**
 * The acceptance measurement, on one real conversation.
 *
 * ── What it measures and why it is the right number ────────────────────────
 *
 * `cacheRead_{N+1} / totalInput_N`: of everything turn N put on the wire, how
 * much came back from the provider's cache on turn N+1. It is the only figure
 * that says whether a prefix survived a turn boundary, and it is the figure
 * the whole prompt-cache work is judged on. Measured over 7 days of
 * production traffic on 2026-09-22, before any of it: **0.300** across a turn
 * boundary against 0.813 between steps WITHIN a turn — the signature of a
 * prefix that stops at a fixed offset, because the blocks that change every
 * turn sat in front of the history rather than behind it.
 *
 * ── Why a purpose-made probe and not the eval suite ────────────────────────
 *
 * Almost every eval case is ONE turn. A single turn has no boundary to
 * measure, so the suite — at any number of repeats, at any cost — cannot see
 * this. What it needs is the opposite shape: few turns, same conversation.
 *
 * ── Three conditions, each learned from a run that lied ────────────────────
 *
 * **The history is seeded.** The loss is proportional to what sits behind the
 * volatile block, so the conversation has to be production-sized before the
 * number means anything — and four turns of ordinary prose moved the prefix by
 * 142 tokens (measured 2026-09-22). `buildLongHistory` puts it at size in one
 * write.
 *
 * **Turns are spaced past a minute** (`--gap`, 65 s). The clock in the prompt
 * has minute precision, and ten seconds between turns — what a script does by
 * default — leaves it unchanged most of the time. A prompt that breaks the
 * cache on a clock change then scores well for no reason: the first paired run
 * got 98 % cached on a boundary of the arm that was supposed to fail, because
 * the minute had not turned. Production turns are minutes apart.
 *
 * **Only the PRIMARY model's generations count, and the host is read.** A turn
 * the fallback model rescued, or one routed to a different upstream than the
 * previous turn, measures the routing and not the prompt: a cold host returns
 * zero whatever the prompt does. The first paired run read the fallback
 * model's generation as "the last step" and reported 0.000 for a prompt that
 * had held 98 % one call earlier. Such boundaries are printed and flagged, and
 * the headline figure is computed without them.
 *
 * The prompts are small language tasks that need no tool: "a difference
 * between two kinds of invoice" drew a web search, and a tool call adds steps
 * whose cache is the within-turn figure, not this one.
 *
 *   bun run probe:turn-cache                     # 4 turns, 65 s apart, 60k history
 *   bun run probe:turn-cache -- --history 100000 --turns 5
 *   bun run probe:turn-cache -- --gap 0          # the quick, clock-blind run
 *   bun run probe:turn-cache -- --keep           # leave the conversation behind
 */

import { saveMessage } from "@fretik/shared/services/ai/messages";
import {
  createEphemeralConversation,
  destroyEphemeralConversation,
} from "../evals/conversation-lifecycle";
import { buildLongHistory } from "../evals/history";
import { invokeChatbot } from "../evals/http-client";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const turns = Number.parseInt(flag("turns") ?? "4", 10);
const historyTokens = Number.parseInt(flag("history") ?? "60000", 10);
const gapSeconds = Number.parseInt(flag("gap") ?? "65", 10);
const keep = argv.includes("--keep");

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const PROMPTS = [
  "Traduis en anglais : « la réunion est reportée à jeudi ».",
  "Donne trois synonymes du mot « important ».",
  "Reformule plus poliment : « envoyez-moi le fichier ».",
  "Corrige l'orthographe : « il a était décidé de reporté la réunion ».",
  "Traduis en espagnol : « merci pour votre retour rapide ».",
  "Donne l'antonyme de « provisoire ».",
];

interface StepUsage {
  input: number;
  cacheRead: number;
  host: string;
}

interface TurnUsage {
  /** First and last generation of the PRIMARY model in this turn. */
  first: StepUsage;
  last: StepUsage;
  steps: number;
  /** A generation by another model ran in this turn — the fallback. */
  fallback: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const readTurnUsage = async (
  traceId: string,
): Promise<TurnUsage | undefined> => {
  const { LangfuseClient } = await import("@langfuse/client");
  const client = new LangfuseClient();
  const res = await client.api.observations.getMany({
    traceId,
    type: "GENERATION",
    // `metadata` is where the serving upstream lives, and it is opt-in: leave
    // it out and every host reads as unknown, which hides the one thing that
    // separates a prompt effect from a routing one.
    fields: "core,basic,usage,metadata",
    limit: 100,
  });
  const chats = (res.data ?? [])
    .filter((o) => o.name?.startsWith("chat "))
    .sort(
      (a, b) =>
        new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    );
  const primaryName = chats[0]?.name;
  if (primaryName === undefined) return undefined;
  const primary = chats.filter((o) => o.name === primaryName);

  const stepOf = (o: (typeof chats)[number]): StepUsage => {
    const usage: Record<string, unknown> = { ...(o.usageDetails ?? {}) };
    const meta: Record<string, unknown> = { ...(o.metadata ?? {}) };
    const num = (value: unknown): number =>
      typeof value === "number" ? value : 0;
    const host = meta["servingProvider"];
    return {
      input: num(usage["input"]),
      cacheRead: num(usage["input_cache_read"]),
      host: typeof host === "string" ? host : "?",
    };
  };
  const first = primary[0];
  const last = primary[primary.length - 1];
  if (first === undefined || last === undefined) return undefined;
  return {
    first: stepOf(first),
    last: stepOf(last),
    steps: primary.length,
    fallback: primary.length < chats.length,
  };
};

const main = async (): Promise<void> => {
  const teamId = requireEnv("EVAL_TEAM_ID");
  const organizationId = requireEnv("EVAL_ORGANIZATION_ID");
  requireEnv("AI_SERVICE_URL");

  const history = buildLongHistory({
    seed: `turn-cache-${Date.now().toString()}`,
    targetTokens: historyTokens,
    needle: {
      statement:
        "Le lot de rapprochement de référence porte le code RCN-8842-QK.",
      expected: "RCN-8842-QK",
    },
  });
  const conversationId = await createEphemeralConversation({
    teamId,
    organizationId,
    ...(process.env["EVAL_USER_ID"] === undefined
      ? {}
      : { userId: process.env["EVAL_USER_ID"] }),
    label: "probe-turn-cache",
    // Seeded as the trailing user message — what turn 1 answers.
    prompt: PROMPTS[0] ?? "",
    history: history.turns,
  });
  console.log(
    `conversation ${conversationId} · historique semé ${history.estimatedTokens.toLocaleString()} tokens · ${turns.toString()} tours espacés de ${gapSeconds.toString()} s\n`,
  );

  const usages: (TurnUsage | undefined)[] = [];
  for (let i = 0; i < turns; i++) {
    if (i > 0 && gapSeconds > 0) await sleep(gapSeconds * 1000);
    const prompt = PROMPTS[i % PROMPTS.length] ?? "";
    // `/invoke` with a conversation IGNORES the message it is sent and loads
    // the history from the database instead — the route says so in a warning.
    // A probe that only calls it re-answers the seeded message on every turn:
    // the history never grows, and the one thing production does between two
    // turns — the previous user message coming BACK from the database, one
    // text part where the wire had carried two — is never exercised. The first
    // turn answers the message the conversation was seeded with; every later
    // one is written here first, exactly as `/stream` writes it.
    if (i > 0) {
      await saveMessage({
        conversationId,
        role: "user",
        parts: [{ type: "text", text: prompt }],
        authorId: process.env["EVAL_USER_ID"] ?? null,
      });
    }
    const result = await invokeChatbot(prompt, conversationId);
    if (result.error !== undefined) {
      console.log(`  tour ${(i + 1).toString()} : ERREUR ${result.error}`);
      usages.push(undefined);
      continue;
    }
    // Langfuse ingests asynchronously; the usage is not queryable the instant
    // the stream ends.
    await sleep(5000);
    const u =
      result.traceId === undefined
        ? undefined
        : await readTurnUsage(result.traceId);
    usages.push(u);
    console.log(
      `  tour ${(i + 1).toString()} : ${
        u === undefined
          ? "usage introuvable"
          : `1er step input ${u.first.input.toLocaleString()} · cacheRead ${u.first.cacheRead.toLocaleString()} · ${u.first.host}${u.steps > 1 ? ` · ${u.steps.toString()} steps` : ""}${u.fallback ? " · SECOURS" : ""}`
      }`,
    );
  }

  console.log(
    "\nborne de tour — cacheRead(N+1, 1er step) / input(N, dernier step)",
  );
  const clean: number[] = [];
  const all: number[] = [];
  for (let i = 1; i < usages.length; i++) {
    const prev = usages[i - 1];
    const cur = usages[i];
    if (prev === undefined || cur === undefined || prev.last.input === 0) {
      continue;
    }
    const ratio = cur.first.cacheRead / prev.last.input;
    all.push(ratio);
    const reasons = [
      ...(prev.last.host !== cur.first.host
        ? [`hôte ${prev.last.host} → ${cur.first.host}`]
        : []),
      ...(prev.fallback ? ["secours au tour précédent"] : []),
    ];
    if (reasons.length === 0) clean.push(ratio);
    console.log(
      `  ${i.toString()}→${(i + 1).toString()} : ${ratio.toFixed(3)}${reasons.length > 0 ? `   [écarté : ${reasons.join(", ")}]` : ""}`,
    );
  }

  const mean = (xs: number[]): number =>
    xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(
    `\n  borne de tour, même hôte : ${clean.length === 0 ? "aucune borne propre" : `${mean(clean).toFixed(3)} sur ${clean.length.toString()} borne(s)`}`,
  );
  console.log(
    `  borne de tour, brut      : ${mean(all).toFixed(3)} sur ${all.length.toString()} borne(s)`,
  );
  console.log("  (référence prod avant le chantier : 0.300 — cible > 0.8)");

  if (keep) {
    console.log(`\nconversation conservée : ${conversationId}`);
  } else {
    await destroyEphemeralConversation(conversationId);
  }
  process.exit(0);
};

await main();
