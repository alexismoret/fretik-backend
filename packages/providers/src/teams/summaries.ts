import type { ToolApprovalSummaryField } from "@fretik/shared/db/schema";
import {
  arr,
  asString,
  prop,
  str,
  strArray,
} from "@fretik/shared/external-apps/json-access";
import type {
  OperationSummaryPart,
  ProviderSummaries,
  SummaryMapper,
} from "@fretik/shared/external-apps/provider-types";

/**
 * Approval-card summaries for every Teams write action.
 *
 * Rule (see ADDING_A_PROVIDER.md §8): the approval card is read by a
 * non-technical end user. Surface what they can verify — message body,
 * subject, attachment names — NOT opaque Graph IDs (chat_id, team_id,
 * channel_id, message_id, user_id). Skip IDs unless they're the only
 * signal available; if every field would be an ID, the title alone
 * (plus the body when present) is the card.
 *
 * Each mapper returns the per-operation block in its structural form —
 * i18n keys and interpolation params, not display strings. The backend
 * renderer in `i18n/render-summary.ts` translates them at display time.
 */

const field = (
  labelKey: string,
  value: string,
  kind?: "text" | "html",
): ToolApprovalSummaryField =>
  kind ? { labelKey, value, kind } : { labelKey, value };

const optionalField = (
  labelKey: string,
  value: string | undefined,
  kind?: "text" | "html",
): ToolApprovalSummaryField | null =>
  value !== undefined && value !== "" ? field(labelKey, value, kind) : null;

const compact = (
  ...fields: (ToolApprovalSummaryField | null)[]
): ToolApprovalSummaryField[] =>
  fields.filter((f): f is ToolApprovalSummaryField => f !== null);

/**
 * Inline-image preview — count + filenames so the reviewer can sanity-
 * check the visual content about to be posted. Names are user-supplied
 * (the agent picks them from `/workspace/.../<file>.png`), so they're
 * already friendly.
 */
const inlineImagesField = (value: unknown): ToolApprovalSummaryField | null => {
  const items = arr(value);
  if (items.length === 0) return null;
  const names = items
    .map((item) => str(prop(item, "name")))
    .filter((n) => n !== "");
  const summary =
    names.length > 0
      ? `${items.length.toString()}: ${names.join(", ")}`
      : items.length.toString();
  return { labelKey: "inline_images", value: summary };
};

// ── Write summaries ────────────────────────────────────────────────────

const sendChatMessage: SummaryMapper = (args): OperationSummaryPart => ({
  titleKey: "default",
  fields: compact(
    field("body", str(args.body_html), "html"),
    inlineImagesField(args.inline_images),
  ),
});

const createChat: SummaryMapper = (args) => {
  const ids = strArray(args.member_user_ids);
  const titleKey = ids.length >= 2 ? "group" : "oneOnOne";
  return {
    titleKey,
    titleParams: { count: ids.length.toString() },
    fields: compact(
      field("member_count", ids.length.toString()),
      optionalField("topic", asString(args.topic)),
    ),
  };
};

const sendChannelMessage: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: compact(
    optionalField("subject", asString(args.subject)),
    field("body", str(args.body_html), "html"),
    inlineImagesField(args.inline_images),
  ),
});

const replyToChannelMessage: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: compact(
    field("body", str(args.body_html), "html"),
    inlineImagesField(args.inline_images),
  ),
});

export const teamsSummaries: ProviderSummaries = {
  send_chat_message: sendChatMessage,
  create_chat: createChat,
  send_channel_message: sendChannelMessage,
  reply_to_channel_message: replyToChannelMessage,
};
