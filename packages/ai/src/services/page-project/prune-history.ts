import type { ModelMessage } from "ai";

/**
 * Drop the bodies of file writes a later write has already replaced.
 *
 * A build's history grows by the size of every file it writes, and every step
 * pays for all of it again. The first multi-file build measured what that
 * costs: 39 model calls averaging 83 000 input tokens, 3.25M in total against
 * 44K of output — output down 45% on the single-file design it replaced, and
 * the bill up 19% anyway, because the cost had simply moved sides.
 *
 * The observation that fixes it: once `components/KpiStrip.vue` has been
 * written twice, the FIRST body is not context, it is history. Nothing the
 * model does next depends on the version it already replaced, and the current
 * one is a `pageRead` away. So the superseded body becomes one line saying so.
 *
 * What is deliberately NOT pruned:
 *   - the last write of every path — that is the file, as the model believes it
 *     to be, and forgetting it would make the model re-read what it just wrote;
 *   - tool RESULTS, which are small and carry the lint findings a fix depends
 *     on;
 *   - anything that is not a page write. This function knows one tool.
 *
 * `prepareStep` applies it: the override carries forward, so a body is pruned
 * once and stays pruned.
 */

const WRITE_TOOL = "pageWrite";

const SUPERSEDED =
  "[superseded: you wrote this file again later. The body was dropped from this message to keep the context small — pageRead it if you need what it says now.]";

/** A tool-call part, structurally — the SDK's union is wider than we need. */
interface WriteCall {
  type: string;
  toolName?: unknown;
  input?: unknown;
}

const isWriteCall = (part: unknown): part is WriteCall =>
  typeof part === "object" &&
  part !== null &&
  Reflect.get(part, "type") === "tool-call" &&
  Reflect.get(part, "toolName") === WRITE_TOOL;

/** The paths one `pageWrite` call wrote, in order. */
const pathsOf = (input: unknown): string[] => {
  if (typeof input !== "object" || input === null) return [];
  const files = Reflect.get(input, "files");
  if (!Array.isArray(files)) return [];
  const paths: string[] = [];
  for (const file of files) {
    if (typeof file !== "object" || file === null) continue;
    const path = Reflect.get(file, "path");
    if (typeof path === "string") paths.push(path);
  }
  return paths;
};

/** The same input with the named files' bodies replaced by one line. */
const withoutBodies = (input: unknown, drop: Set<string>): unknown => {
  if (typeof input !== "object" || input === null) return input;
  const files = Reflect.get(input, "files");
  if (!Array.isArray(files)) return input;
  const next = files.map((file) => {
    if (typeof file !== "object" || file === null) return file;
    const path = Reflect.get(file, "path");
    if (typeof path !== "string" || !drop.has(path)) return file;
    return { ...file, content: SUPERSEDED };
  });
  return { ...input, files: next };
};

/**
 * Every message, with superseded write bodies collapsed.
 *
 * Returns the SAME array when there is nothing to prune, so a build that writes
 * each file once pays nothing for this — including the identity check the SDK
 * makes on the override.
 */
export const prunePageWriteHistory = (
  messages: readonly ModelMessage[],
): ModelMessage[] | null => {
  // Where each path was written LAST. Walking forward and overwriting leaves
  // exactly the surviving write per path.
  const lastWrite = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    for (const part of message.content) {
      if (!isWriteCall(part)) continue;
      for (const path of pathsOf(part.input)) lastWrite.set(path, index);
    }
  });

  let changed = false;
  const pruned: ModelMessage[] = [];
  for (const [index, message] of messages.entries()) {
    // Tool calls live on assistant messages and nowhere else. Narrowing on the
    // role keeps every other message its own type rather than widening the
    // whole array to the union's lowest common shape.
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      pruned.push(message);
      continue;
    }
    let touched = false;
    const content = message.content.map((part) => {
      if (!isWriteCall(part)) return part;
      const drop = new Set(
        pathsOf(part.input).filter((path) => lastWrite.get(path) !== index),
      );
      if (drop.size === 0) return part;
      touched = true;
      return { ...part, input: withoutBodies(part.input, drop) };
    });
    if (!touched) {
      pruned.push(message);
      continue;
    }
    changed = true;
    pruned.push({ ...message, content });
  }

  return changed ? pruned : null;
};
