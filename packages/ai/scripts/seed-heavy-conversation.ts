/**
 * Seed one conversation large enough to trip compaction, and leave it there.
 *
 * ## Why this exists
 *
 * `ChatStepCompaction.vue` renders a `data-compaction` part, and that part is
 * only ever written on the CRITICAL path — a turn that loads an over-cap
 * history and has to summarise before it can answer. Measured on 30 days of
 * production (`scripts/measure-context-distribution.ts`), 3.48 % of
 * conversations ever reach that size, and `compactAheadOfNextTurn` now cuts
 * most of those at the end of the previous turn instead, where no part is
 * written because no reader is waiting.
 *
 * So the card is correct, rare, and effectively unobservable by chance — which
 * is indistinguishable from broken until someone forces the condition. This
 * forces it: one conversation, over the cap, owned by a real user, openable in
 * the browser. Send it any message and the next frame is the card.
 *
 * It writes to whatever `DATABASE_URL` points at and attaches the conversation
 * to a real org/team/user, so it is a DEV instrument. Point it at production
 * and it puts a fake conversation in someone's sidebar.
 *
 * ## Usage
 *
 *   bun --env-file=.env run scripts/seed-heavy-conversation.ts [historyTokens]
 *
 * Prints the conversation id and the URL to open. Delete it from the UI when
 * finished — nothing here cleans up, on purpose: the point is that it survives
 * long enough to be looked at.
 */
import db from "@fretik/shared/db";
import { aiConversationMembers } from "@fretik/shared/db/schema";
import { createEphemeralConversation } from "../evals/conversation-lifecycle";
import { buildLongHistory } from "../evals/history";

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

const NEEDLE = {
  statement:
    "Le lot de rapprochement de référence porte le code RCN-8842-QK, et l'écart résiduel validé s'élève à 41 328,60 €.",
  expected: "RCN-8842-QK",
} as const;

const historyTokens = Number(Bun.argv[2] ?? "120000");

const history = buildLongHistory({
  seed: `heavy-${Date.now().toString()}`,
  targetTokens: historyTokens,
  needle: NEEDLE,
});

const conversationId = await createEphemeralConversation({
  teamId: requireEnv("EVAL_TEAM_ID"),
  organizationId: requireEnv("EVAL_ORGANIZATION_ID"),
  userId: requireEnv("EVAL_USER_ID"),
  label: `compaction-ui-check-${history.estimatedTokens.toString()}t`,
  // Seeded as the trailing user message; the browser turn is what actually
  // exercises the handler, so this one is only a placeholder.
  prompt: "Reprends le dossier.",
  history: history.turns,
});

/**
 * The row `createEphemeralConversation` does not write, and the reason a
 * seeded conversation is invisible without it.
 *
 * `getConversation` scopes on `members: { userId }`, not on the conversation's
 * own `user_id`, so the API answers 404 for a conversation whose owner has no
 * membership row — which is every conversation the eval harness has ever made,
 * because the harness posts straight to the AI service's internal route and
 * never passes through the API at all.
 */
await db
  .insert(aiConversationMembers)
  .values({
    conversationId,
    userId: requireEnv("EVAL_USER_ID"),
    role: "owner",
  })
  .onConflictDoNothing();

console.log(
  `seeded ${history.estimatedTokens.toLocaleString()} tokens of history`,
);
console.log(`conversationId: ${conversationId}`);
console.log(`open: http://localhost:3000/chatbot/${conversationId}`);
process.exit(0);
