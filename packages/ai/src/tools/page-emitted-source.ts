import type { ModelMessage } from "ai";

/**
 * Page source travels as streamed TEXT, never as a tool-call argument.
 *
 * Measured 2026-08-26 in production (Langfuse sessions `01a03bc5…` /
 * `01a03dbc…`, cross-checked against OpenRouter's generation log): a
 * page-scale `managePage` write emits ~16-18k output tokens as the JSON
 * argument `definition.code.source`, and BOTH serving stacks the builder runs
 * on buffer function-call arguments — Google emits them in one final chunk,
 * MiniMax's parser holds the whole invoke block. For the two-plus minutes the
 * model spends writing the file, not one byte crosses the upstream socket, so
 * an idle watchdog we do not control (~120s) cuts the connection: ten kills
 * measured, every one at `preamble + ~120s`, `finish_reason: null`,
 * `cancelled: false`, unbilled. The fallback model buffered identically and
 * died at the same point — the failure belongs to the transport, not to a
 * model. When the same provider ran fast (~200 tok/s, 11:00 UTC) the identical
 * write finished in 81s and shipped.
 *
 * Text has no such hole: every provider streams it token by token, so the
 * socket stays warm however long the file is, and a run cut mid-way leaves the
 * source in the trajectory where `build-page.ts` can still save it. Hence the
 * protocol: the builder writes the SFC in a ```vue fence, then sends
 * `"@emitted"` where the source used to go.
 *
 * The fence is read back from the model's own transcript, one step later. That
 * delay is not a design choice: `ToolExecutionOptions.messages` carries the
 * messages that PROMPTED the step, never the assistant message the tool call
 * sits in, so a fence and the call that claims it cannot share a message.
 */

/** What `definition.code.source` carries instead of the file. */
export const EMITTED_SOURCE_SENTINEL = "@emitted";

/**
 * A closed ```vue block. Opened-but-unclosed matches nothing on purpose: half
 * an SFC compiles to nothing, and resolving to it would turn a cut generation
 * into a corrupt page instead of a recoverable one.
 */
const VUE_FENCE_RE = /```vue[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

/**
 * The last complete SFC in one block of text, or null.
 *
 * `<template` is the sanity gate: a builder quotes fragments while it reasons
 * ("the current card renders …"), and the last fence in a message is not
 * necessarily a page. A real SFC always carries one.
 */
export const lastVueFence = (text: string): string | null => {
  let found: string | null = null;
  for (const match of text.matchAll(VUE_FENCE_RE)) {
    const body = match[1];
    if (body !== undefined && body.includes("<template")) found = body;
  }
  return found;
};

/** The text an assistant message actually wrote — its other parts are not it. */
const assistantText = (message: ModelMessage): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");

/**
 * The source a `"@emitted"` call is claiming: the last fence the ASSISTANT
 * wrote, searched from the most recent message back.
 *
 * Assistant messages only. Tool results carry sources too — `get` returns a
 * whole page, `components` returns worked examples — and resolving to one of
 * those would silently save the wrong file over the right one.
 */
export const resolveEmittedSource = (
  messages: readonly ModelMessage[] | undefined,
): string | null => {
  for (const message of [...(messages ?? [])].reverse()) {
    if (message.role !== "assistant") continue;
    const found = lastVueFence(assistantText(message));
    if (found !== null) return found;
  }
  return null;
};
