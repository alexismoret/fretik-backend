import {
  ImapFlow,
  type FetchMessageObject,
  type MailboxObject,
} from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

type SmtpTransporter = Transporter<SMTPTransport.SentMessageInfo>;

/**
 * Thin async wrappers around `imapflow` (IMAP) and `nodemailer` (SMTP),
 * plus `mailparser` for full MIME parsing. One short-lived connection per
 * action — no pool, no long-lived sessions. Sufficient for v1 (chatbot
 * turn-based, sub-second actions); a per-connection LRU pool can be added
 * later if a hot path emerges.
 *
 * The handlers in `./handlers.ts` are the only consumers — keep this
 * module free of provider-handler glue (no `ProviderHandlerContext` here).
 */

// ── Connection config (from Nango connection_config + credentials) ────

export type SecureMode = "tls" | "starttls";

export interface ImapConnectionConfig {
  host: string;
  port: number;
  secure: SecureMode;
  username: string;
  password: string;
}

export interface SmtpConnectionConfig {
  host: string;
  port: number;
  secure: SecureMode;
  username: string;
  password: string;
}

/** Composite, opaque message id surfaced to the agent: `<base64url(folder)>.<uid>`. */
export const encodeMessageId = (folder: string, uid: number): string => {
  const folderB64 = Buffer.from(folder, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${folderB64}.${uid.toString()}`;
};

export const decodeMessageId = (
  messageId: string,
): { folder: string; uid: number } => {
  const dot = messageId.lastIndexOf(".");
  if (dot <= 0 || dot === messageId.length - 1) {
    throw new Error(`Invalid imap-smtp message_id: ${messageId}`);
  }
  const folderB64 = messageId.slice(0, dot);
  const uidStr = messageId.slice(dot + 1);
  const uid = Number.parseInt(uidStr, 10);
  if (!Number.isFinite(uid) || uid <= 0) {
    throw new Error(`Invalid imap-smtp uid in message_id: ${messageId}`);
  }
  const b64 = folderB64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const folder = Buffer.from(b64 + pad, "base64").toString("utf-8");
  if (folder.length === 0) {
    throw new Error(`Invalid imap-smtp folder in message_id: ${messageId}`);
  }
  return { folder, uid };
};

// ── IMAP client construction ──────────────────────────────────────────

/**
 * Build an `ImapFlow` instance for one short-lived session.
 * - `secure: "tls"`      → implicit TLS on connect (typically port 993).
 * - `secure: "starttls"` → plain connect then STARTTLS (typically port 143).
 */
const buildImapClient = (cfg: ImapConnectionConfig): ImapFlow => {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure === "tls",
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
    socketTimeout: 30_000,
  });
  // imapflow emits asynchronous 'error' events on the client (e.g. socket
  // timeout, TLS handshake failure). Without a registered listener, Node
  // upgrades the event to an uncaught exception and crashes the whole
  // process. The error is already surfaced through the awaited promise
  // returned by `connect()` / `fetch()` / etc., so this listener is just
  // a sink to keep the process alive.
  client.on("error", () => {});
  return client;
};

/**
 * Open an IMAP session, run the callback, and always close it. Returns
 * whatever the callback resolves to.
 */
export const withImap = async <T>(
  cfg: ImapConnectionConfig,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> => {
  const client = buildImapClient(cfg);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      // best-effort close — primary error already propagating
    }
  }
};

/**
 * Open an IMAP session, select+lock a mailbox, run the callback, release
 * the lock, then logout. The callback receives both the client and the
 * locked mailbox info.
 */
export const withMailbox = async <T>(
  cfg: ImapConnectionConfig,
  folder: string,
  fn: (client: ImapFlow, mailbox: MailboxObject) => Promise<T>,
): Promise<T> => {
  return withImap(cfg, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      // `client.mailbox` is set to the active mailbox info after lock acquisition.
      const mailbox = client.mailbox;
      if (typeof mailbox === "boolean") {
        throw new Error(`Failed to open mailbox: ${folder}`);
      }
      return await fn(client, mailbox);
    } finally {
      lock.release();
    }
  });
};

// ── Well-known folder resolution ──────────────────────────────────────

/**
 * Public-facing well-known folder names — lowercase aliases mapped to
 * RFC 6154 SPECIAL-USE flags (`\All`, `\Archive`, `\Drafts`, `\Flagged`,
 * `\Junk`, `\Sent`, `\Trash`) plus the widely-supported `\Important`
 * extension (Gmail). `inbox` is the literal `INBOX` from RFC 3501.
 *
 * Kept in sync with Outlook where the names overlap (`inbox`,
 * `sentitems`, `drafts`, `deleteditems`, `archive`, `junkemail`) so
 * the agent uses the same vocabulary across providers.
 */
export type WellKnownFolder =
  | "inbox"
  | "sentitems"
  | "drafts"
  | "deleteditems"
  | "archive"
  | "junkemail"
  | "flagged"
  | "important"
  | "allmail";

const SPECIAL_USE_FOR: Record<WellKnownFolder, string> = {
  inbox: "INBOX",
  sentitems: "\\Sent",
  drafts: "\\Drafts",
  deleteditems: "\\Trash",
  archive: "\\Archive",
  junkemail: "\\Junk",
  flagged: "\\Flagged",
  important: "\\Important",
  allmail: "\\All",
};

/**
 * Fallback display-name candidates when SPECIAL-USE isn't advertised.
 * Order matters — the first match wins. Localised entries cover the
 * common French (`Tous les messages`, `Corbeille` ...), German
 * (`Gesendet`) and Spanish (`Enviados`) Gmail/Exchange variants so a
 * non-English mailbox still resolves.
 */
const FALLBACK_NAMES_FOR: Record<WellKnownFolder, string[]> = {
  inbox: ["INBOX", "Boîte de réception", "Posteingang", "Bandeja de entrada"],
  sentitems: [
    "Sent",
    "Sent Items",
    "Sent Messages",
    "[Gmail]/Sent Mail",
    "Messages envoyés",
    "[Gmail]/Messages envoyés",
    "Gesendet",
    "Enviados",
  ],
  drafts: [
    "Drafts",
    "[Gmail]/Drafts",
    "Brouillons",
    "[Gmail]/Brouillons",
    "Entwürfe",
    "Borradores",
  ],
  deleteditems: [
    "Trash",
    "Deleted Items",
    "Deleted Messages",
    "[Gmail]/Trash",
    "Corbeille",
    "[Gmail]/Corbeille",
    "Papierkorb",
    "Papelera",
  ],
  archive: ["Archive", "Archives", "[Gmail]/Archive"],
  junkemail: [
    "Junk",
    "Junk Email",
    "Spam",
    "[Gmail]/Spam",
    "Indésirables",
    "Pourriels",
  ],
  flagged: [
    "Flagged",
    "Starred",
    "[Gmail]/Starred",
    "Suivis",
    "[Gmail]/Suivis",
    "Markiert",
    "Destacados",
  ],
  important: ["Important", "[Gmail]/Important", "Wichtig", "Importantes"],
  allmail: [
    "All Mail",
    "All",
    "[Gmail]/All Mail",
    "Tous les messages",
    "[Gmail]/Tous les messages",
    "Alle Nachrichten",
    "Todos",
  ],
};

/**
 * Resolve a well-known folder name to the actual IMAP folder path on this
 * server. Prefers SPECIAL-USE flags, falls back to common names. Throws if
 * no match is found.
 */
export const resolveWellKnownFolder = async (
  client: ImapFlow,
  wellKnown: WellKnownFolder,
): Promise<string> => {
  if (wellKnown === "inbox") return "INBOX";

  const target = SPECIAL_USE_FOR[wellKnown];
  const list = await client.list();
  const bySpecial = list.find((m) => m.specialUse === target);
  if (bySpecial !== undefined) return bySpecial.path;

  const candidates = FALLBACK_NAMES_FOR[wellKnown];
  for (const name of candidates) {
    const match = list.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (match !== undefined) return match.path;
  }
  throw new Error(`No ${wellKnown} folder on this IMAP server`);
};

// ── Message normalization (IMAP → Fretik Message / MessageFull shape) ──

const firstAddress = (
  addresses: ReadonlyArray<{ address?: string; name?: string }> | undefined,
): string => {
  if (addresses === undefined || addresses.length === 0) return "";
  return addresses[0]?.address ?? "";
};

const allAddresses = (
  addresses: ReadonlyArray<{ address?: string; name?: string }> | undefined,
): string[] => {
  if (addresses === undefined) return [];
  return addresses.map((a) => a.address ?? "").filter((a) => a.length > 0);
};

/** Coerce a possibly-string IMAP date into an ISO 8601 string. */
const toIso = (value: Date | string | undefined): string => {
  if (value === undefined) return new Date().toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? new Date().toISOString()
      : parsed.toISOString();
  }
  return value.toISOString();
};

/** Normalize an `imapflow` fetch result into Fretik's `Message` shape. */
export const toMessageSummary = (
  folder: string,
  msg: FetchMessageObject,
): {
  id: string;
  subject: string;
  from_address: string;
  to: string[];
  received_at: string;
  is_read: boolean;
  has_attachments: boolean;
  body_preview: string;
} => {
  const env = msg.envelope;
  const childNodes = (
    msg.bodyStructure as { childNodes?: unknown[] } | undefined
  )?.childNodes;
  return {
    id: encodeMessageId(folder, msg.uid),
    subject: env?.subject ?? "",
    from_address: firstAddress(env?.from),
    to: allAddresses(env?.to),
    received_at: toIso(env?.date ?? msg.internalDate),
    is_read: msg.flags?.has("\\Seen") ?? false,
    has_attachments: Array.isArray(childNodes) && childNodes.length > 0,
    body_preview: "",
  };
};

/**
 * Fetch + parse a full message (envelope + flags + source) into Fretik's
 * `MessageFull` shape (HTML body extracted).
 */
export const fetchMessageFull = async (
  client: ImapFlow,
  folder: string,
  uid: number,
): Promise<{
  id: string;
  subject: string;
  from_address: string;
  to: string[];
  cc: string[];
  received_at: string;
  is_read: boolean;
  has_attachments: boolean;
  body_html: string;
}> => {
  const msg = await client.fetchOne(
    uid.toString(),
    { envelope: true, flags: true, source: true, bodyStructure: true },
    { uid: true },
  );
  if (typeof msg === "boolean" || msg === null) {
    throw new Error(`Message uid=${uid.toString()} not found in ${folder}`);
  }
  const source = msg.source;
  let parsed: ParsedMail | undefined;
  if (source !== undefined) {
    parsed = await simpleParser(source);
  }
  const env = msg.envelope;
  const bodyHtml =
    parsed?.html === false || parsed?.html === undefined
      ? (parsed?.textAsHtml ?? "")
      : parsed.html;
  return {
    id: encodeMessageId(folder, msg.uid),
    subject: env?.subject ?? parsed?.subject ?? "",
    from_address: firstAddress(env?.from),
    to: allAddresses(env?.to),
    cc: allAddresses(env?.cc),
    received_at: toIso(env?.date ?? msg.internalDate),
    is_read: msg.flags?.has("\\Seen") ?? false,
    has_attachments: (parsed?.attachments?.length ?? 0) > 0,
    body_html: bodyHtml,
  };
};

// ── SMTP client ───────────────────────────────────────────────────────

const buildSmtpTransport = (cfg: SmtpConnectionConfig): SmtpTransporter => {
  const options: SMTPTransport.Options = {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure === "tls",
    auth: { user: cfg.username, pass: cfg.password },
    connectionTimeout: 30_000,
    socketTimeout: 30_000,
  };
  if (cfg.secure === "starttls") {
    options.requireTLS = true;
  }
  return nodemailer.createTransport(options);
};

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  /** Base64-encoded bytes (matches the public manifest shape). */
  contentBase64: string;
}

export interface OutgoingMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  attachments?: OutgoingAttachment[];
  /** Optional headers — used for replies/forwards (In-Reply-To, References). */
  headers?: Record<string, string>;
}

export const sendViaSmtp = async (
  cfg: SmtpConnectionConfig,
  message: OutgoingMessage,
): Promise<{ messageId: string }> => {
  const transport = buildSmtpTransport(cfg);
  try {
    const result = await transport.sendMail({
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      html: message.html,
      headers: message.headers,
      attachments: message.attachments?.map((att) => ({
        filename: att.filename,
        contentType: att.contentType,
        content: Buffer.from(att.contentBase64, "base64"),
      })),
    });
    return { messageId: result.messageId };
  } finally {
    transport.close();
  }
};

/** Validate SMTP login + transport readiness without sending anything. */
export const verifySmtp = async (cfg: SmtpConnectionConfig): Promise<void> => {
  const transport = buildSmtpTransport(cfg);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
};
