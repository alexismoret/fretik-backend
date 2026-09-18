import type { UIMessage } from "ai";
import { getConversationMessages } from "../ai/messages";

/**
 * WHAT THE AGENT MEANT TO HAND OVER.
 *
 * A conversation's `outputs/` folder holds two very different things. One
 * is the deliverable — the spreadsheet that was asked for. The rest is
 * the working-out: the JSON an intermediate step wrote, the CSV a chart
 * was built from, the scratch file a retry left behind. Nothing about
 * the bytes tells them apart, and burying the one file someone wanted
 * under six they did not is how a file panel stops being read.
 *
 * `presentFiles` already draws the line, because calling it IS the act
 * of handing a file over: the tool exists so the agent can say "this one
 * is for you", and writing a file to the sandbox deliberately shows the
 * user nothing on its own. So the transcript is the record of intent,
 * and this reads it back.
 *
 * DERIVED, NOT STORED. The alternative — a manifest object beside the
 * files, or a marker per deliverable — would mean more S3 objects owned
 * by nobody in particular, which is the failure mode we are trying to
 * get away from. The messages are in Postgres already, they are deleted
 * with the conversation by a cascade that needs no help, and they
 * answer for conversations that finished long before this existed.
 */

export interface PresentedFileRef {
  /** Workspace-relative path, e.g. `outputs/report.xlsx`. */
  path: string;
  filename: string;
  mimeType?: string;
  size?: number;
}

const stringField = (obj: object, key: string): string | undefined => {
  if (!(key in obj)) return undefined;
  const value: unknown = Reflect.get(obj, key);
  return typeof value === "string" ? value : undefined;
};

const numberField = (obj: object, key: string): number | undefined => {
  if (!(key in obj)) return undefined;
  const value: unknown = Reflect.get(obj, key);
  return typeof value === "number" ? value : undefined;
};

/**
 * Every file presented across these messages, keyed by workspace path.
 *
 * Last occurrence wins: re-presenting a regenerated file is the same
 * deliverable in a newer state, not a second one.
 */
export const presentedFilesInMessages = (
  messages: UIMessage[],
): Map<string, PresentedFileRef> => {
  const byPath = new Map<string, PresentedFileRef>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-presentFiles") continue;
      if (!("output" in part)) continue;
      const output: unknown = part.output;
      if (output === null || typeof output !== "object") continue;
      if (!("files" in output)) continue;
      const files: unknown = output.files;
      if (!Array.isArray(files)) continue;

      for (const fileRaw of files) {
        // `Array.isArray` widens to `any[]`; re-bind to `unknown` and narrow.
        const file: unknown = fileRaw;
        if (file === null || typeof file !== "object") continue;
        const filename = stringField(file, "filename");
        const path = stringField(file, "path");
        if (filename === undefined || path === undefined) continue;
        const mimeType = stringField(file, "mimeType");
        const size = numberField(file, "size");
        byPath.set(path, {
          path,
          filename,
          ...(mimeType !== undefined ? { mimeType } : {}),
          ...(size !== undefined ? { size } : {}),
        });
      }
    }
  }

  return byPath;
};

/** The same, read from a conversation's persisted transcript. */
export const listPresentedFiles = async (
  conversationId: string,
): Promise<Map<string, PresentedFileRef>> =>
  presentedFilesInMessages(await getConversationMessages(conversationId));
