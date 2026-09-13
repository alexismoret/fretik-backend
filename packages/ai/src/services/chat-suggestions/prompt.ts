import {
  MAX_CHAT_SUGGESTIONS,
  MAX_PER_KIND,
  suggestionOutputSchema,
} from "@fretik/shared/schemas/chat-suggestions";
import {
  SCHEMA_BLOCK_TRAILER,
  zodToPromptSchema,
} from "../../lib/schema-prompt";
import type { SuggestionPack } from "./pack";

/**
 * The suggestion writer's instructions.
 *
 * Aux prompt, so it lives beside its service rather than in Langfuse — same
 * placement as recall, compaction and the distillers.
 *
 * What every rule here is defending against, in order: generic filler that
 * could be shown to any team on any day; a suggestion the assistant cannot
 * actually act on in one turn; six variations of the same idea; and an
 * invented client, figure or id. The last one is also enforced in code —
 * `parseSuggestions` drops any draft citing an id the pack did not offer — so
 * the prompt states the rule and the parser keeps it.
 */
export const SYSTEM_PROMPT = `Propose what this person should ask their workplace assistant next. The context below is everything known about their team and their own recent work; every line ends with the id it came from.

Return ${String(MAX_CHAT_SUGGESTIONS - 2)} to ${String(MAX_CHAT_SUGGESTIONS)} suggestions, each one a thing this person plausibly wants done TODAY.

- \`prompt\` is the message itself, sent verbatim. Name the real client, document, workflow, conversation or decision it is about, and give the assistant enough to finish in one turn.
- \`label\` is the card: imperative, what they get.
- \`reason\` says why now, citing the fact it rests on.
- \`sourceIds\` lists the ids from the context the suggestion rests on, copied exactly.

Spread the batch: at most ${String(MAX_PER_KIND)} of any one kind, and skip a kind with nothing to say rather than padding it.

NEVER invent a name, a figure, a date or an id — everything you assert comes from the context. Never propose something already listed as suggested. Never write a request that would work for any team ("summarise a document", "help me organise my files"). Never include credentials, tokens or personal data.

Write \`label\`, \`prompt\` and \`reason\` in the language named at the top of the context.

${zodToPromptSchema(suggestionOutputSchema)}

${SCHEMA_BLOCK_TRAILER}`;

export const buildSuggestionPrompt = (pack: SuggestionPack): string =>
  pack.text;
