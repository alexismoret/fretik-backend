import { listStandingEpisodes } from "@fretik/shared/services/episodes/list-standing";
import { renderStandingEpisodes } from "../../src/agents/shared/standing-memory";
import { runUnifiedRecall } from "../../src/services/recall/recall";

/**
 * Print `<standing_memory>` and `<active_memory>` for one message, side by
 * side, plus the episode ids they share.
 *
 * Why this exists. `mr-broad` scores 29/30 with the standing block cut and
 * 9/30 with it, and the failing runs spend 5-13 tool calls — so the block does
 * not stop the agent retrieving. The remaining explanation is that the two
 * blocks carry the SAME episodes, one pre-digested and one in full, and the
 * answer gets composed from the tidy one. That is a claim about overlap, and
 * overlap is a thing to measure rather than argue: this prints it.
 *
 *   AI_SERVICE_URL=… bun run evals/scripts/probe-standing-overlap.ts "Fais le point sur Nordwind GmbH."
 */

const message = Bun.argv[2] ?? "Fais le point sur Nordwind GmbH.";

const organizationId = process.env.EVAL_ORGANIZATION_ID ?? "";
const teamId = process.env.EVAL_TEAM_ID ?? "";
const userId = process.env.EVAL_USER_ID ?? "";

if (!organizationId || !teamId || !userId) {
  console.error("Missing EVAL_ORGANIZATION_ID / EVAL_TEAM_ID / EVAL_USER_ID");
  process.exit(1);
}

const episodeIdsIn = (block: string): string[] => [
  ...new Set(
    [...block.matchAll(/\(episode:([0-9a-f-]{36})\)/gi)].flatMap((m) =>
      m[1] === undefined ? [] : [m[1].toLowerCase()],
    ),
  ),
];

const standing = await listStandingEpisodes({
  organizationId,
  teamId,
  userId,
});
const standingBlock = renderStandingEpisodes(standing);

const recall = await runUnifiedRecall({
  organizationId,
  teamId,
  userId,
  conversationId: crypto.randomUUID(),
  userMessage: message,
  attachedFiles: [],
  recentTail: "",
  agentType: "chatbot",
  // The in-process cache keys on the message, and a probe re-run would read
  // its own first answer back rather than the current code's.
  bypassCache: true,
});

const activeBlock = recall?.block ?? "";

const standingIds = episodeIdsIn(standingBlock);
const activeIds = episodeIdsIn(activeBlock);
const shared = standingIds.filter((id) => activeIds.includes(id));

console.info(`\n=== message ===\n${message}`);
console.info(
  `\n=== <standing_memory> (${standing.items.length.toString()} items, ${standing.visibleInWindow.toString()} visible in window) ===\n${standingBlock || "(empty)"}`,
);
console.info(`\n=== <active_memory> ===\n${activeBlock || "(empty)"}`);
console.info(
  `\n=== overlap ===\nstanding ids: ${standingIds.length.toString()}\nactive ids:   ${activeIds.length.toString()}\nshared:       ${shared.length.toString()}${shared.length > 0 ? `\n  ${shared.join("\n  ")}` : ""}`,
);
console.info(
  `\nHorizon in standing: ${standingBlock.includes("Horizon").toString()}\nHorizon in active:   ${activeBlock.includes("Horizon").toString()}`,
);

process.exit(0);
