import {
  arr,
  asString,
  bool,
  num,
  prop,
  str,
  strArray,
} from "@fretik/shared/external-apps/json-access";
import type {
  ProviderHandler,
  ProviderHandlers,
} from "@fretik/shared/external-apps/provider-types";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import {
  decodeMessageId,
  encodeMessageId,
  fetchMessageFull,
  type OutgoingAttachment,
  resolveWellKnownFolder,
  sendViaSmtp,
  toMessageSummary,
  type WellKnownFolder,
  withImap,
  withMailbox,
} from "./client";
import { parseImapConfig, parseSmtpConfig } from "./config";

/**
 * One handler per manifest action. Each handler is invoked with the
 * action's validated args and a `{ credentials, connection_config }`
 * context fetched by the dispatcher from Nango right before this call.
 *
 * Every action that needs IMAP opens a fresh session (no pooling in v1)
 * and ensures cleanup via `withImap` / `withMailbox` helpers. SMTP gets
 * its own transport per call. This is wasteful in theory but trivial in
 * practice for a chatbot turn-based hot path (sub-second actions, a few
 * per minute at most).
 */

// ── Helpers ───────────────────────────────────────────────────────────

const WELL_KNOWN: readonly WellKnownFolder[] = [
  "inbox",
  "sentitems",
  "drafts",
  "deleteditems",
  "archive",
  "junkemail",
  "flagged",
  "important",
  "allmail",
];

const isWellKnownFolder = (value: unknown): value is WellKnownFolder => {
  if (typeof value !== "string") return false;
  return (WELL_KNOWN as readonly string[]).includes(value);
};

/**
 * Strip "Re: " prefixes already present in a subject — case-insensitive,
 * collapses multiple "Re: Re: …" into a single one.
 */
const replySubject = (original: string): string => {
  const trimmed = original.replace(/^(?:\s*re\s*:\s*)+/i, "").trim();
  return `Re: ${trimmed}`;
};

const forwardSubject = (original: string): string => {
  const trimmed = original.replace(/^(?:\s*(?:fwd?|tr)\s*:\s*)+/i, "").trim();
  return `Fwd: ${trimmed}`;
};

/**
 * Build an HTML quote block of the original message, appended below the
 * user-authored reply/forward body. Plain and unstyled on purpose — most
 * mail clients re-style their own quote anyway.
 */
const quoteOriginal = (full: {
  from_address: string;
  received_at: string;
  subject: string;
  body_html: string;
}): string =>
  `<br><br><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">` +
  `<div><b>From:</b> ${full.from_address}</div>` +
  `<div><b>Date:</b> ${full.received_at}</div>` +
  `<div><b>Subject:</b> ${full.subject}</div>` +
  `<br>${full.body_html}` +
  `</blockquote>`;

const attachmentsFromArgs = (value: unknown): OutgoingAttachment[] =>
  arr(value).map((att) => ({
    filename: str(prop(att, "name")),
    contentType: str(prop(att, "content_type")),
    contentBase64: str(prop(att, "content_base64")),
  }));

/**
 * Order a fetched page newest-first by the message's own `received_at`
 * (the sender's `Date` header, falling back to the server's
 * `internalDate` — see `toMessageSummary` in `client.ts`).
 *
 * What this fixes: IMAP hands rows back in UID order (≈ server arrival),
 * which disagrees with the Date header whenever a sender's clock is off
 * or a message was APPENDed/MOVEd into the folder after the fact. Without
 * this sort, consumers rendered the page out of chronological order.
 *
 * What this does NOT fix: the page is still WINDOWED by UID — the
 * `slice(offset, offset + limit)` over the reversed UID list picks WHICH
 * messages are fetched, and that stays arrival-based. A message whose
 * date disagrees with its arrival can therefore still fall outside the
 * window, i.e. a newer-dated message may sit on a later page. This orders
 * the rows of one page; it is not a mailbox-wide sort by date.
 *
 * Rows with a missing or unparseable `received_at` sort last rather than
 * letting `NaN` scramble the comparator. `Array.prototype.sort` is stable,
 * so ties (and those trailing rows) keep their UID order.
 */
export const byReceivedAtDesc = (
  a: { received_at: string },
  b: { received_at: string },
): number => {
  const left = Date.parse(a.received_at);
  const right = Date.parse(b.received_at);
  const leftBad = Number.isNaN(left);
  const rightBad = Number.isNaN(right);
  if (leftBad && rightBad) return 0;
  if (leftBad) return 1;
  if (rightBad) return -1;
  return right - left;
};

// ── Read handlers ─────────────────────────────────────────────────────

const listMessages: ProviderHandler = async (args, ctx) => {
  const folderArg = asString(args.folder) ?? "inbox";
  if (!isWellKnownFolder(folderArg)) {
    throw new Error(`Unknown folder: ${folderArg}`);
  }
  const unreadOnly = bool(args.unread_only);
  const limit = num(args.limit, 25);
  const offset = num(args.offset, 0);

  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);
  return withImap(imapCfg, async (client) => {
    const folder = await resolveWellKnownFolder(client, folderArg);
    return listMessagesInFolderImpl(client, folder, unreadOnly, limit, offset);
  });
};

const listMessagesInFolder: ProviderHandler = async (args, ctx) => {
  const folderId = str(args.folder_id);
  if (folderId.length === 0) throw new Error("folder_id is required");
  const unreadOnly = bool(args.unread_only);
  const limit = num(args.limit, 25);
  const offset = num(args.offset, 0);

  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);
  return withImap(imapCfg, async (client) => {
    return listMessagesInFolderImpl(
      client,
      folderId,
      unreadOnly,
      limit,
      offset,
    );
  });
};

/**
 * Shared body for both list_messages and list_messages_in_folder.
 * Locks the mailbox, searches with the right criteria, fetches a page
 * of newest-first messages, normalizes.
 *
 * Pagination: the search returns ALL matching UIDs sorted ascending by
 * UID (≈ chronological). We reverse to newest-first, then slice with
 * `[offset, offset + limit)`. Stable as long as no new messages arrive
 * between pages (rare in chatbot turn-cycles); for very volatile
 * mailboxes the agent should request a larger first page instead.
 *
 * The fetched page is then ordered by `received_at` — see
 * `byReceivedAtDesc` for exactly what that does and does not guarantee.
 */
const listMessagesInFolderImpl = async (
  client: ImapFlow,
  folder: string,
  unreadOnly: boolean,
  limit: number,
  offset: number,
): Promise<unknown[]> => {
  const lock = await client.getMailboxLock(folder);
  try {
    const uids = await client.search(
      unreadOnly ? { seen: false } : { all: true },
      { uid: true },
    );
    if (!Array.isArray(uids) || uids.length === 0) return [];
    const reversed = [...uids].reverse(); // newest UID first
    const slice = reversed.slice(offset, offset + limit);
    if (slice.length === 0) return [];
    const results: Array<ReturnType<typeof toMessageSummary>> = [];
    for await (const msg of client.fetch(
      slice,
      { envelope: true, flags: true, bodyStructure: true },
      { uid: true },
    )) {
      results.push(toMessageSummary(folder, msg));
    }
    // Window picked by UID above, display order by date here.
    return results.sort(byReceivedAtDesc);
  } finally {
    lock.release();
  }
};

const getMessage: ProviderHandler = async (args, ctx) => {
  const messageId = str(args.message_id);
  const { folder, uid } = decodeMessageId(messageId);
  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);
  return withMailbox(imapCfg, folder, async (client) => {
    return fetchMessageFull(client, folder, uid);
  });
};

const searchMessages: ProviderHandler = async (args, ctx) => {
  const query = str(args.query);
  const orTerms = strArray(args.query_or);
  if (query.length === 0 && orTerms.length === 0) {
    throw new Error("Either `query` or `query_or` is required");
  }
  const limit = num(args.limit, 25);
  const offset = num(args.offset, 0);

  // IMAP SEARCH does NOT parse the Gmail-style `OR` keyword in TEXT,
  // so when the agent wants `a OR b OR c` we build it via the native
  // `or: [...]` composition on imapflow's SearchObject (RFC 3501
  // SEARCH OR a b semantics). When `query_or` is empty, fall back to
  // a single TEXT term.
  const criterion =
    orTerms.length > 0
      ? { or: orTerms.map((t) => ({ text: t })) }
      : { text: query };

  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);
  return withMailbox(imapCfg, "INBOX", async (client) => {
    // IMAP TEXT search is the closest cross-server equivalent of a
    // full-text search — matches headers + body. Servers vary in how
    // they index; this is a deliberate v1 trade-off (single folder,
    // server-side text search).
    const uids = await client.search(criterion, { uid: true });
    if (!Array.isArray(uids) || uids.length === 0) return [];
    const reversed = [...uids].reverse();
    const slice = reversed.slice(offset, offset + limit);
    if (slice.length === 0) return [];
    const results: Array<ReturnType<typeof toMessageSummary>> = [];
    for await (const msg of client.fetch(
      slice,
      { envelope: true, flags: true, bodyStructure: true },
      { uid: true },
    )) {
      results.push(toMessageSummary("INBOX", msg));
    }
    // Window picked by UID above, display order by date here.
    return results.sort(byReceivedAtDesc);
  });
};

// ── Attachment helpers ────────────────────────────────────────────────

/**
 * Fetch the full RFC822 source of a message and run `simpleParser` on it
 * to extract the attachment list. We re-parse the whole message even
 * when only metadata is asked for — IMAP servers don't expose a
 * metadata-only attachment listing without parsing MIME, and a chatbot
 * turn typically targets one message at a time, so the cost is fine in
 * practice.
 *
 * Each attachment's ID is the array index as a string. `mailparser`'s
 * ordering is deterministic per MIME structure, so the same listing
 * always returns the same attachment at the same index for the same
 * message — stable enough for the agent to call list-then-download.
 */
const fetchParsedAttachments = async (
  client: ImapFlow,
  uid: number,
): Promise<
  Array<{
    filename: string | undefined;
    contentType: string;
    size: number;
    content: Buffer;
  }>
> => {
  const msg = await client.fetchOne(
    uid.toString(),
    { source: true },
    { uid: true },
  );
  if (typeof msg === "boolean" || msg === null || msg.source === undefined) {
    throw new Error(`Message uid=${uid.toString()} not found`);
  }
  const parsed = await simpleParser(msg.source);
  return (parsed.attachments ?? []).map((att) => ({
    filename: att.filename,
    contentType: att.contentType,
    size: att.size,
    content: att.content,
  }));
};

const listMessageAttachments: ProviderHandler = async (args, ctx) => {
  const messageId = str(args.message_id);
  const { folder, uid } = decodeMessageId(messageId);
  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);
  const attachments = await withMailbox(imapCfg, folder, async (client) =>
    fetchParsedAttachments(client, uid),
  );
  // Metadata only — no `content_base64`, so the agent gets a light
  // listing it can scan before deciding which attachment(s) to download.
  return attachments.map((att, idx) => ({
    id: idx.toString(),
    name: att.filename ?? "untitled",
    content_type: att.contentType,
    size_bytes: att.size,
  }));
};

const downloadMessageAttachment: ProviderHandler = async (args, ctx) => {
  const messageId = str(args.message_id);
  const attachmentId = str(args.attachment_id);
  if (attachmentId.length === 0) {
    throw new Error("attachment_id is required");
  }
  const idx = Number.parseInt(attachmentId, 10);
  if (Number.isNaN(idx) || idx < 0) {
    throw new Error(`Invalid attachment_id: ${attachmentId}`);
  }
  const { folder, uid } = decodeMessageId(messageId);
  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);
  const attachments = await withMailbox(imapCfg, folder, async (client) =>
    fetchParsedAttachments(client, uid),
  );
  const match = attachments[idx];
  if (match === undefined) {
    throw new Error(
      `Attachment ${attachmentId} not found on message ${messageId}`,
    );
  }
  // `content_base64` is populated here; the Python `_runtime.py` will
  // spill it to disk and replace it with `sandbox_path` before the value
  // reaches the agent. We never need to do that spilling ourselves.
  return {
    id: attachmentId,
    name: match.filename ?? "untitled",
    content_type: match.contentType,
    size_bytes: match.size,
    content_base64: match.content.toString("base64"),
  };
};

const listFolders: ProviderHandler = async (_args, ctx) => {
  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);
  return withImap(imapCfg, async (client) => {
    const folders = await client.list();
    // STATUS gives counts without selecting the mailbox. Some servers
    // refuse STATUS on \Noselect folders → swallow per-folder errors and
    // surface zeroes rather than aborting the whole listing.
    const statuses = await Promise.all(
      folders.map((f) =>
        client
          .status(f.path, { messages: true, unseen: true })
          .then((s) => ({
            total: s.messages ?? 0,
            unread: s.unseen ?? 0,
          }))
          .catch(() => ({ total: 0, unread: 0 })),
      ),
    );
    return folders.map((f, i) => ({
      id: f.path,
      display_name: f.name,
      parent_folder_id:
        f.parentPath !== undefined && f.parentPath !== ""
          ? f.parentPath
          : undefined,
      total_item_count: statuses[i]?.total ?? 0,
      unread_item_count: statuses[i]?.unread ?? 0,
    }));
  });
};

// ── Write handlers ────────────────────────────────────────────────────

const sendEmail: ProviderHandler = async (args, ctx) => {
  const smtpCfg = parseSmtpConfig(ctx.credentials, ctx.connection_config);

  const to = strArray(args.to);
  if (to.length === 0)
    throw new Error("`to` must include at least one address");

  // No IMAP APPEND to Sent in v1: nodemailer doesn't surface the raw
  // RFC822 by default, and most modern SMTP servers (Exchange, Gmail)
  // auto-archive to Sent on submit anyway.
  const result = await sendViaSmtp(smtpCfg, {
    from: smtpCfg.username,
    to,
    cc: strArray(args.cc),
    bcc: strArray(args.bcc),
    subject: str(args.subject),
    html: str(args.body_html),
    attachments: attachmentsFromArgs(args.attachments),
  });
  return { id: result.messageId };
};

const replyEmail: ProviderHandler = async (args, ctx) => {
  const messageId = str(args.message_id);
  const { folder, uid } = decodeMessageId(messageId);
  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);
  const smtpCfg = parseSmtpConfig(ctx.credentials, ctx.connection_config);

  const original = await withMailbox(imapCfg, folder, async (client) => {
    return fetchMessageFull(client, folder, uid);
  });

  // The original Message-ID header is the threading anchor. We fetch the
  // raw envelope again only to pick it up — `fetchMessageFull` already
  // discards it. Keeping a single read here keeps the reply path simple.
  const originalMessageIdHeader = await withMailbox(
    imapCfg,
    folder,
    async (client) => {
      const msg = await client.fetchOne(
        uid.toString(),
        { envelope: true },
        { uid: true },
      );
      if (typeof msg === "boolean" || msg === null) return undefined;
      return msg.envelope?.messageId ?? undefined;
    },
  );

  const bodyHtml = str(args.body_html);
  const result = await sendViaSmtp(smtpCfg, {
    from: smtpCfg.username,
    to: original.from_address.length > 0 ? [original.from_address] : [],
    subject: replySubject(original.subject),
    html: bodyHtml + quoteOriginal(original),
    headers:
      originalMessageIdHeader !== undefined
        ? {
            "In-Reply-To": originalMessageIdHeader,
            References: originalMessageIdHeader,
          }
        : undefined,
    attachments: attachmentsFromArgs(args.attachments),
  });
  return { id: result.messageId };
};

const forwardEmail: ProviderHandler = async (args, ctx) => {
  const messageId = str(args.message_id);
  const { folder, uid } = decodeMessageId(messageId);
  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);
  const smtpCfg = parseSmtpConfig(ctx.credentials, ctx.connection_config);

  const original = await withMailbox(imapCfg, folder, async (client) => {
    return fetchMessageFull(client, folder, uid);
  });

  const to = strArray(args.to);
  if (to.length === 0)
    throw new Error("`to` must include at least one address");
  const comment = str(args.comment);
  const body =
    (comment.length > 0 ? `<p>${comment}</p>` : "") + quoteOriginal(original);

  const result = await sendViaSmtp(smtpCfg, {
    from: smtpCfg.username,
    to,
    subject: forwardSubject(original.subject),
    html: body,
    attachments: attachmentsFromArgs(args.attachments),
  });
  return { id: result.messageId };
};

const setFlags = async (
  ctx: {
    credentials: Record<string, unknown>;
    connection_config: Record<string, unknown>;
  },
  messageId: string,
  flag: "\\Seen",
  add: boolean,
): Promise<{ id: string }> => {
  const { folder, uid } = decodeMessageId(messageId);
  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);
  await withMailbox(imapCfg, folder, async (client) => {
    if (add) {
      await client.messageFlagsAdd(uid.toString(), [flag], { uid: true });
    } else {
      await client.messageFlagsRemove(uid.toString(), [flag], { uid: true });
    }
  });
  return { id: messageId };
};

const markRead: ProviderHandler = async (args, ctx) =>
  setFlags(ctx, str(args.message_id), "\\Seen", true);

const markUnread: ProviderHandler = async (args, ctx) =>
  setFlags(ctx, str(args.message_id), "\\Seen", false);

const deleteMessage: ProviderHandler = async (args, ctx) => {
  const messageId = str(args.message_id);
  const { folder, uid } = decodeMessageId(messageId);
  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);

  await withImap(imapCfg, async (client) => {
    let trash: string | undefined;
    try {
      trash = await resolveWellKnownFolder(client, "deleteditems");
    } catch {
      trash = undefined;
    }
    const lock = await client.getMailboxLock(folder);
    try {
      if (trash !== undefined && trash !== folder) {
        await client.messageMove(uid.toString(), trash, { uid: true });
      } else {
        // Already in Trash, or no Trash exists — STORE \Deleted + EXPUNGE.
        await client.messageDelete(uid.toString(), { uid: true });
      }
    } finally {
      lock.release();
    }
  });
  return { id: messageId };
};

const moveMessage: ProviderHandler = async (args, ctx) => {
  const messageId = str(args.message_id);
  const destination = str(args.destination_folder_id);
  if (destination.length === 0) {
    throw new Error("destination_folder_id is required");
  }
  const { folder, uid } = decodeMessageId(messageId);
  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);

  const newUid = await withImap(imapCfg, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const result = await client.messageMove(uid.toString(), destination, {
        uid: true,
      });
      // imapflow returns `false` if no message matched; otherwise a
      // CopyResponseObject whose `uidMap` is populated when the server
      // supports UIDPLUS — handy to give the agent the new UID.
      if (result === false) return uid;
      return result.uidMap?.get(uid) ?? uid;
    } finally {
      lock.release();
    }
  });
  return { id: encodeMessageId(destination, newUid) };
};

// ── Batch helpers + handlers ──────────────────────────────────────────

/**
 * Decode `message_ids` and group their UIDs by folder. IMAP STORE /
 * MOVE / DELETE are strictly per-mailbox, so a single batch call must
 * be split per source folder. Throws if any id is malformed —
 * defensive: a bad id usually means the agent constructed the array
 * from stale data and should retry the read.
 */
const groupByFolder = (messageIds: string[]): Map<string, number[]> => {
  const groups = new Map<string, number[]>();
  for (const id of messageIds) {
    const { folder, uid } = decodeMessageId(id);
    const existing = groups.get(folder);
    if (existing === undefined) groups.set(folder, [uid]);
    else existing.push(uid);
  }
  return groups;
};

const deleteMessages: ProviderHandler = async (args, ctx) => {
  const ids = strArray(args.message_ids);
  if (ids.length === 0) return [];
  const groups = groupByFolder(ids);
  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);
  const results: Array<{ id: string }> = [];
  await withImap(imapCfg, async (client) => {
    let trash: string | undefined;
    try {
      trash = await resolveWellKnownFolder(client, "deleteditems");
    } catch {
      trash = undefined;
    }
    // Sequential by design — one mailbox lock at a time on a single
    // IMAP connection. Parallel folder ops on the same connection
    // would interleave IMAP commands and break the lock contract.
    for (const [folder, uids] of groups) {
      // eslint-disable-next-line no-await-in-loop -- per-folder sequencing on a shared IMAP connection
      const lock = await client.getMailboxLock(folder);
      try {
        if (trash !== undefined && trash !== folder) {
          // eslint-disable-next-line no-await-in-loop -- same connection, must serialize
          await client.messageMove(uids, trash, { uid: true });
        } else {
          // Already in Trash, or no Trash exists → STORE +\Deleted + EXPUNGE.
          // eslint-disable-next-line no-await-in-loop -- same connection, must serialize
          await client.messageDelete(uids, { uid: true });
        }
        for (const uid of uids) {
          results.push({ id: encodeMessageId(folder, uid) });
        }
      } finally {
        lock.release();
      }
    }
  });
  return results;
};

const moveMessages: ProviderHandler = async (args, ctx) => {
  const ids = strArray(args.message_ids);
  if (ids.length === 0) return [];
  const destination = str(args.destination_folder_id);
  if (destination.length === 0) {
    throw new Error("destination_folder_id is required");
  }
  const groups = groupByFolder(ids);
  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);
  const results: Array<{ id: string }> = [];
  await withImap(imapCfg, async (client) => {
    for (const [folder, uids] of groups) {
      // eslint-disable-next-line no-await-in-loop -- per-folder sequencing on a shared IMAP connection
      const lock = await client.getMailboxLock(folder);
      try {
        // eslint-disable-next-line no-await-in-loop -- same connection, must serialize
        const result = await client.messageMove(uids, destination, {
          uid: true,
        });
        // Map original → destination UID when UIDPLUS is supported,
        // otherwise fall back to the source UID so the agent still
        // has an addressable id (move within same folder = same uid).
        const uidMap =
          result === false
            ? undefined
            : (result as { uidMap?: Map<number, number> }).uidMap;
        for (const uid of uids) {
          const newUid = uidMap?.get(uid) ?? uid;
          results.push({ id: encodeMessageId(destination, newUid) });
        }
      } finally {
        lock.release();
      }
    }
  });
  return results;
};

const setFlagsBatch = async (
  ctx: {
    credentials: Record<string, unknown>;
    connection_config: Record<string, unknown>;
  },
  messageIds: string[],
  flag: "\\Seen",
  add: boolean,
): Promise<Array<{ id: string }>> => {
  if (messageIds.length === 0) return [];
  const groups = groupByFolder(messageIds);
  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);
  const results: Array<{ id: string }> = [];
  await withImap(imapCfg, async (client) => {
    for (const [folder, uids] of groups) {
      // eslint-disable-next-line no-await-in-loop -- per-folder sequencing on a shared IMAP connection
      const lock = await client.getMailboxLock(folder);
      try {
        if (add) {
          // eslint-disable-next-line no-await-in-loop -- same connection, must serialize
          await client.messageFlagsAdd(uids, [flag], { uid: true });
        } else {
          // eslint-disable-next-line no-await-in-loop -- same connection, must serialize
          await client.messageFlagsRemove(uids, [flag], { uid: true });
        }
        for (const uid of uids) {
          results.push({ id: encodeMessageId(folder, uid) });
        }
      } finally {
        lock.release();
      }
    }
  });
  return results;
};

const markMessagesRead: ProviderHandler = async (args, ctx) =>
  setFlagsBatch(ctx, strArray(args.message_ids), "\\Seen", true);

const markMessagesUnread: ProviderHandler = async (args, ctx) =>
  setFlagsBatch(ctx, strArray(args.message_ids), "\\Seen", false);

const createFolder: ProviderHandler = async (args, ctx) => {
  const displayName = str(args.display_name);
  if (displayName.length === 0) {
    throw new Error("display_name is required");
  }
  const parentId = asString(args.parent_folder_id);
  const imapCfg = parseImapConfig(ctx.credentials, ctx.connection_config);

  return withImap(imapCfg, async (client) => {
    const path =
      parentId !== undefined && parentId.length > 0
        ? `${parentId}/${displayName}`
        : displayName;
    const created = await client.mailboxCreate(path);
    const createdPath =
      (created as { path?: string } | undefined)?.path ?? path;
    // STATUS for counts; best-effort.
    let total = 0;
    let unread = 0;
    try {
      const status = await client.status(createdPath, {
        messages: true,
        unseen: true,
      });
      total = status.messages ?? 0;
      unread = status.unseen ?? 0;
    } catch {
      // ignore — newly-created folder is empty anyway
    }
    return {
      id: createdPath,
      display_name: displayName,
      parent_folder_id: parentId ?? undefined,
      total_item_count: total,
      unread_item_count: unread,
    };
  });
};

// ── Exported handler registry ─────────────────────────────────────────

export const imapSmtpHandlers: ProviderHandlers = {
  listMessages,
  getMessage,
  searchMessages,
  listMessagesInFolder,
  listFolders,
  listMessageAttachments,
  downloadMessageAttachment,
  sendEmail,
  replyEmail,
  forwardEmail,
  markRead,
  markUnread,
  deleteMessage,
  moveMessage,
  deleteMessages,
  moveMessages,
  markMessagesRead,
  markMessagesUnread,
  createFolder,
};
