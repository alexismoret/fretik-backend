/**
 * Print the context pack a reader's suggestions would be written from, and
 * then the suggestions themselves.
 *
 * The tuning loop for `services/chat-suggestions/prompt.ts`. Reaches the real
 * model on purpose — which is exactly why it is a script and not a test: a
 * suite that spends money is a bill, and this one is run by a person who wants
 * to read the output.
 *
 * Usage, from `backend/packages/ai`:
 *   bun run scripts/probe-chat-suggestions.ts <teamId> <userId> [language]
 *   bun run scripts/probe-chat-suggestions.ts --list
 *
 * Model bake-off (`--bench <profileKey,…> [repeats]`), because "is the cheap
 * model good enough here" is a question about THIS pack on THIS workspace and
 * nothing else answers it:
 *   bun run scripts/probe-chat-suggestions.ts <teamId> <userId> fr \
 *     --bench gpt-oss-120b,gpt-oss-20b 3
 */
import db from "@fretik/shared/db";
import { sql } from "drizzle-orm";
import { ensureModelRegistryWarm } from "../src/lib/model-registry/resolve";
import { generateSuggestions } from "../src/services/chat-suggestions/generate";
import { renderSuggestionPack } from "../src/services/chat-suggestions/pack";
import { loadSuggestionSources } from "../src/services/chat-suggestions/sources";

const listCandidates = async (): Promise<void> => {
  const rows = await db.execute<{
    team_id: string;
    team_name: string;
    user_id: string;
    user_name: string;
    language: string;
    episodes: number;
  }>(sql`
    SELECT t.id AS team_id, t.name AS team_name,
           u.id AS user_id, u.name AS user_name, u.language,
           count(e.id) AS episodes
    FROM team t
    JOIN team_member tm ON tm.team_id = t.id
    JOIN "user" u ON u.id = tm.user_id
    LEFT JOIN ai_episodes e
      ON e.team_id = t.id AND e.state = 'active'
     AND (e.user_id IS NULL OR e.user_id = u.id)
    GROUP BY t.id, t.name, u.id, u.name, u.language
    ORDER BY count(e.id) DESC
    LIMIT 10
  `);
  for (const row of rows.rows) {
    console.log(
      `${row.team_id}  ${row.user_id}  ${row.language}  ${String(row.episodes).padStart(3)} episodes  — ${row.team_name} / ${row.user_name}`,
    );
  }
};

/**
 * One arm of the bake-off. Reports what a person would actually notice: how
 * many cards survive, how specific they are (a suggestion naming nothing from
 * the pack is filler), and how long the first visit blocks.
 */
const benchArm = async (
  profileKey: string,
  repeats: number,
  team: { id: string; organizationId: string },
  userId: string,
  pack: Awaited<ReturnType<typeof renderSuggestionPack>>,
): Promise<void> => {
  const kept: number[] = [];
  const latencies: number[] = [];
  const kinds = new Map<string, number>();
  let grounded = 0;
  let total = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (let run = 0; run < repeats; run += 1) {
    const started = Date.now();
    const generated = await generateSuggestions({
      teamId: team.id,
      userId,
      pack,
      profileOverride: profileKey,
    });
    latencies.push(Date.now() - started);
    kept.push(generated?.items.length ?? 0);
    inputTokens += generated?.usage.inputTokens ?? 0;
    outputTokens += generated?.usage.outputTokens ?? 0;
    for (const item of generated?.items ?? []) {
      total += 1;
      if (item.sourceIds.length > 0) grounded += 1;
      kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
    }
    if (run === 0 && generated) {
      console.log(`\n  sample (${profileKey}):`);
      for (const item of generated.items) {
        console.log(`    [${item.kind}] ${item.label}`);
        console.log(`        ${item.prompt}`);
      }
    }
  }

  const median = (xs: number[]): number =>
    [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const avgIn = Math.round(inputTokens / repeats);
  const avgOut = Math.round(outputTokens / repeats);
  console.log(
    `\n  ${profileKey}: kept ${kept.join("/")} (of 4-6 asked) · grounded ${String(grounded)}/${String(total)} · median ${String(median(latencies))}ms · tokens ${String(avgIn)} in / ${String(avgOut)} out per run · kinds ${[...kinds].map(([k, n]) => `${k}:${String(n)}`).join(" ")}`,
  );
};

const main = async (): Promise<void> => {
  const [teamId, userId, language] = process.argv.slice(2);

  if (teamId === "--list" || teamId === undefined || userId === undefined) {
    console.log("Candidate (team, user) pairs, busiest first:\n");
    await listCandidates();
    console.log(
      "\nUsage: bun run scripts/probe-chat-suggestions.ts <teamId> <userId> [language]",
    );
    return;
  }

  const team = await db.query.team.findFirst({
    where: { id: teamId },
    columns: { id: true, organizationId: true, name: true },
  });
  if (!team) throw new Error(`No team ${teamId}`);

  const startedSources = Date.now();
  const sources = await loadSuggestionSources({
    organizationId: team.organizationId,
    teamId: team.id,
    userId,
  });
  const pack = renderSuggestionPack(sources, {
    language: language ?? "fr",
    now: new Date(),
  });

  console.log("=".repeat(72));
  console.log(pack.text);
  console.log("=".repeat(72));
  console.log(
    `sources: ${String(Date.now() - startedSources)}ms · ${String(pack.text.length)} chars · ${String(pack.sourceIds.size)} ids · cold=${String(pack.isCold)} · hash=${pack.inputHash.slice(0, 12)}`,
  );

  if (pack.isCold) {
    console.log("\nCold start — no model would run for this reader.");
    return;
  }

  // The service does this in a middleware; a script has no middleware, and a
  // cold registry resolves no model at all.
  await ensureModelRegistryWarm();

  const benchFlag = process.argv.indexOf("--bench");
  if (benchFlag !== -1) {
    const profiles = (process.argv[benchFlag + 1] ?? "")
      .split(",")
      .filter(Boolean);
    const repeats = Number(process.argv[benchFlag + 2] ?? "3");
    console.log(
      `\nBake-off on this pack — ${profiles.join(" vs ")}, ${String(repeats)} repeats each.`,
    );
    for (const profileKey of profiles) {
      await benchArm(profileKey, repeats, team, userId, pack);
    }
    return;
  }

  const startedGeneration = Date.now();
  const generated = await generateSuggestions({
    teamId: team.id,
    userId,
    pack,
  });
  const elapsed = Date.now() - startedGeneration;

  if (!generated) {
    console.log(`\nGeneration failed after ${String(elapsed)}ms.`);
    return;
  }

  console.log(
    `\n${String(generated.items.length)} suggestions in ${String(elapsed)}ms on ${generated.modelKey}:\n`,
  );
  for (const item of generated.items) {
    console.log(`[${item.kind}] ${item.label}`);
    console.log(`   prompt: ${item.prompt}`);
    console.log(`   why:    ${item.reason}`);
    console.log(`   from:   ${item.sourceIds.join(", ") || "(none)"}`);
    console.log();
  }
};

await main();
process.exit(0);
