import type { ToolApprovalPayload } from "../../db/schema";
import { isRecordWritePayload } from "./payload-guards";

/**
 * Items a `record_write` card renders one-by-one before it switches to a
 * summary.
 *
 * The number is a review threshold, not a transport one. Below it a reviewer
 * can actually read each proposed record, tick the ones they want and edit a
 * value; the virtualized list shows about five cards at a time, so 25 is
 * roughly five screens of scrolling — already the outer edge of what anyone
 * audits row by row. Above it nobody reads the list, they approve on trust, and
 * the only honest card is one that states the count and shows a sample.
 *
 * The transport cost falls out of that choice rather than driving it: 25 items
 * is ~10 KB on the wire where 5 000 (the bulk ceiling) is several MB, doubled
 * again for update/delete because every item carries a full `currentData`
 * snapshot.
 */
export const RECORD_PREVIEW_LIMIT = 25;

/**
 * Items kept once the card HAS switched to its summary form.
 *
 * Distinct from {@link RECORD_PREVIEW_LIMIT} on purpose — that one decides
 * WHICH card renders, this one sizes the sample the summary shows. A summary
 * exists because the list stopped being reviewable, so the sample is not a
 * short list: it is evidence that the column mapping is right ("name went to
 * Name, not to VAT"), and three rows show that as well as twenty-five while
 * keeping the response in kilobytes.
 */
export const RECORD_SUMMARY_SAMPLE = 3;

/**
 * Project an approval `payload` for the browser.
 *
 * `record_write` is the one kind whose payload is unbounded by construction —
 * it holds one entry per record of a bulk write, so a single approval could
 * ship megabytes and render thousands of cards. Above
 * {@link RECORD_PREVIEW_LIMIT} the wire carries a PREVIEW and the card renders
 * a summary instead.
 *
 * No truncation marker is needed: the row's `itemCount` is stamped from the
 * full list at creation and travels on the DTO already, so `itemCount >
 * items.length` IS the signal, and it stays correct for a payload rewritten by
 * a grant's inline edits (which change values, never the length).
 *
 * Read-side only. The stored payload keeps every item, and a grant still
 * executes from it — which is also why the reviewer of a truncated card must
 * not send `selectedIndexes`: those indexes would address a list they never
 * saw. An omitted `selectedIndexes` already means "all".
 */
export const toWirePayload = (
  payload: ToolApprovalPayload | null,
): ToolApprovalPayload | null => {
  if (!isRecordWritePayload(payload)) return payload;
  if (payload.items.length <= RECORD_PREVIEW_LIMIT) return payload;
  return { ...payload, items: payload.items.slice(0, RECORD_SUMMARY_SAMPLE) };
};
