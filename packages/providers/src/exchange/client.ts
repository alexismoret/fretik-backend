import { XhrApi } from "@ewsjs/xhr";
import {
  arr,
  bool,
  num,
  path,
  prop,
  str,
} from "@fretik/shared/external-apps/json-access";
import {
  AppointmentSchema,
  BasePropertySet,
  BodyType,
  ContactSchema,
  DateTime,
  EmailAddressKey,
  EmailMessageSchema,
  ExchangeService,
  ExchangeVersion,
  Folder,
  FolderId,
  ItemSchema,
  PhoneNumberKey,
  PropertySet,
  Uri,
  WebCredentials,
  WellKnownFolderName,
  type Appointment,
  type Attachment,
  type Contact,
  type EmailMessage,
  type FileAttachment,
  type Item,
  type Rule,
} from "ews-javascript-api";

/**
 * Thin layer over `ews-javascript-api` (EWS/SOAP). Auth is HTTP Basic over TLS:
 * `WebCredentials` makes ews set `Authorization: Basic …` on every request and
 * the default `@ewsjs/xhr` transport just forwards it. NTLM is intentionally
 * NOT used — it must read the server's `WWW-Authenticate: NTLM <challenge>`
 * header, and Bun's HTTP client drops duplicate `WWW-Authenticate` headers
 * (keeping only the last), so the challenge never reaches JS.
 *
 * One short-lived `ExchangeService` per action — EWS is stateless HTTP, so
 * there is no session to open/close (simpler than the IMAP `withImap`). Each
 * service carries its own credentials, so concurrent calls with different
 * connections never share state.
 *
 * All `ews-javascript-api` imports for the connection + normalization layer
 * live here; handlers add the operation-specific classes they need.
 */

// ── Connection config ─────────────────────────────────────────────────

/** Supported on-prem schema versions (matches the credentials-form select). */
export type EwsVersionId =
  | "Exchange2010_SP2"
  | "Exchange2013"
  | "Exchange2013_SP1"
  | "Exchange2016";

export interface EwsConnectionConfig {
  /** Email — Autodiscover key + identity + default login. */
  email: string;
  /** Basic-auth login sent to the server (= email unless an override is set). */
  loginUsername: string;
  password: string;
  /** Manual EWS endpoint; when undefined, resolved from conventions/Autodiscover. */
  ewsUrl?: string;
  /** Manual schema version; when undefined, detected from ServerInfo. */
  exchangeVersion?: EwsVersionId;
  /** Accept self-signed / internal-CA TLS certs (common on self-hosted). */
  allowSelfSigned: boolean;
}

const VERSION_MAP: Record<EwsVersionId, ExchangeVersion> = {
  Exchange2010_SP2: ExchangeVersion.Exchange2010_SP2,
  Exchange2013: ExchangeVersion.Exchange2013,
  Exchange2013_SP1: ExchangeVersion.Exchange2013_SP1,
  Exchange2016: ExchangeVersion.Exchange2016,
};

/**
 * Universal baseline for Autodiscover + version probing: a 2010_SP2-schema
 * request is accepted by every Exchange ≥ 2010, so it works before we know
 * the real version. The detected version is then used for actual actions.
 */
const PROBE_VERSION: EwsVersionId = "Exchange2010_SP2";

/** Build a service with Basic auth set; `url` omitted for the Autodiscover probe. */
const buildServiceAt = (
  cfg: EwsConnectionConfig,
  version: EwsVersionId,
  url?: string,
): ExchangeService => {
  const service = new ExchangeService(VERSION_MAP[version]);
  if (url !== undefined) service.Url = new Uri(url);
  // WebCredentials makes ews send `Authorization: Basic <base64(user:pass)>` on
  // every request; the default XHRApi forwards it (no challenge to read, so it
  // works under Bun). `rejectUnauthorized` enforces TLS cert validation unless
  // the user opted into self-signed.
  service.Credentials = new WebCredentials(cfg.loginUsername, cfg.password);
  service.XHRApi = new XhrApi({ rejectUnauthorized: !cfg.allowSelfSigned });
  return service;
};

/** Surface a readable message from EWS exceptions (which extend Error). */
const ewsErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.length > 0) return error.message;
  const message = prop(error, "Message");
  if (typeof message === "string" && message.length > 0) return message;
  return "Exchange request failed";
};

// ── URL + version resolution (resolved once, cached) ──────────────────

/**
 * Library Autodiscover (POX/SOAP) — last-resort fallback only. It is fragile
 * for self-hosted servers and, on failure, masks the real error behind
 * "Not implemented." (its legacy path is a non-ported stub), so we try the
 * conventional URLs first and only fall back here.
 */
const autodiscoverUrl = async (cfg: EwsConnectionConfig): Promise<string> => {
  // The internal AutodiscoverService inherits this service's credentials +
  // XHRApi (Basic), so the probe authenticates like every other call. SCP
  // lookup is off — we are not domain-joined.
  const service = buildServiceAt(cfg, PROBE_VERSION);
  service.EnableScpLookup = false;
  try {
    await service.AutodiscoverUrl(cfg.email, (redirectUrl: string) =>
      redirectUrl.toLowerCase().startsWith("https://"),
    );
  } catch (error) {
    throw new Error(
      `Autodiscover failed for ${cfg.email} — set the EWS server URL manually in the connection's advanced settings (${ewsErrorMessage(error)})`,
      { cause: error },
    );
  }
  const uri = service.Url;
  const url = uri instanceof Uri ? uri.ToString() : "";
  if (url.length === 0) {
    throw new Error(
      `Autodiscover returned no EWS URL for ${cfg.email} — set the EWS server URL manually`,
    );
  }
  return url;
};

/** Map the server's ServerVersionInfo to our schema-version id. */
const mapServerVersion = (info: unknown): EwsVersionId => {
  const major = num(prop(info, "MajorVersion"));
  const minor = num(prop(info, "MinorVersion"));
  if (major === 14) return "Exchange2010_SP2";
  if (major === 15) return minor === 0 ? "Exchange2013" : "Exchange2016";
  // Unknown/newer → 2013 schema is the safe floor (works on 2013/2016/2019).
  return "Exchange2013";
};

/** Detect the schema version: one light request populates `service.ServerInfo`. */
const detectVersion = async (
  cfg: EwsConnectionConfig,
  url: string,
): Promise<EwsVersionId> => {
  const service = buildServiceAt(cfg, PROBE_VERSION, url);
  await Folder.Bind(
    service,
    new FolderId(WellKnownFolderName.Inbox),
    idOnlyPropertySet(),
  );
  return mapServerVersion(service.ServerInfo);
};

interface ResolvedConnection {
  url: string;
  version: EwsVersionId;
}

const domainOf = (email: string): string => {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1) : "";
};

/**
 * Conventional EWS endpoints derived from the email domain — the de-facto
 * layout for self-hosted Exchange (`autodiscover.<domain>` fronts EWS). Tried
 * before the library's fragile Autodiscover.
 */
const conventionalEwsUrls = (email: string): string[] => {
  const domain = domainOf(email);
  if (domain.length === 0) return [];
  return [
    `https://autodiscover.${domain}/EWS/Exchange.asmx`,
    `https://mail.${domain}/EWS/Exchange.asmx`,
    `https://${domain}/EWS/Exchange.asmx`,
  ];
};

/** A 401/403 from a probe = URL reachable but credentials rejected. */
const isAuthError = (error: unknown): boolean => {
  // ews throws non-Error objects (text in `.Message`) — reuse the extractor.
  const message = ewsErrorMessage(error);
  return /\b40[13]\b/.test(message) || /unauthor/i.test(message);
};

/**
 * Find a working EWS URL + schema version for `cfg`:
 *  1. manual `ews_url` → validate (+ detect version if on auto),
 *  2. conventional `autodiscover.<domain>/EWS/Exchange.asmx` etc. — each
 *     validated by a real authenticated request, which also detects the
 *     version via ServerInfo, so a failure is a REAL error (auth / TLS / DNS),
 *  3. the library's Autodiscover as a last automated attempt.
 * On total failure we surface the canonical candidate's real error — the
 * library's Autodiscover otherwise masks it behind "Not implemented.".
 */
const resolveUrlAndVersion = async (
  cfg: EwsConnectionConfig,
): Promise<ResolvedConnection> => {
  if (cfg.ewsUrl !== undefined) {
    const version =
      cfg.exchangeVersion ?? (await detectVersion(cfg, cfg.ewsUrl));
    return { url: cfg.ewsUrl, version };
  }

  const candidates = conventionalEwsUrls(cfg.email);
  let firstError: unknown;
  for (const url of candidates) {
    try {
      // A successful bind validates the URL AND yields the server version.
      // eslint-disable-next-line no-await-in-loop -- candidates tried in order; stop at the first that binds
      const version = await detectVersion(cfg, url);
      return { url, version: cfg.exchangeVersion ?? version };
    } catch (error) {
      // A 401/403 means the URL is right but the credentials are wrong — stop
      // now; trying the other candidates would only repeat the rejection.
      if (isAuthError(error)) {
        throw new Error(
          `Exchange authentication failed for ${cfg.email} — check the password, or set the sign-in name (e.g. DOMAIN\\user) in the connection's advanced settings.`,
          { cause: error },
        );
      }
      if (firstError === undefined) firstError = error;
    }
  }

  // Last automated attempt: the library's Autodiscover (POX/SOAP).
  try {
    const url = await autodiscoverUrl(cfg);
    const version = cfg.exchangeVersion ?? (await detectVersion(cfg, url));
    return { url, version };
  } catch {
    // Report the canonical candidate's real failure, not Autodiscover's mask.
    throw new Error(
      `Could not reach an Exchange EWS endpoint for ${cfg.email}. Set the EWS server URL manually in the connection's advanced settings (e.g. https://autodiscover.${domainOf(cfg.email)}/EWS/Exchange.asmx). Last error: ${ewsErrorMessage(firstError)}`,
    );
  }
};

// In-process cache: URL + version are resolved once per connection per process
// (a few hundred ms), then every action reuses the result — zero resolution
// cost on the hot path. `inFlight` dedupes concurrent first calls.
const resolutionCache = new Map<string, ResolvedConnection>();
const inFlight = new Map<string, Promise<ResolvedConnection>>();

const cacheKey = (cfg: EwsConnectionConfig): string =>
  `${cfg.email}|${cfg.loginUsername}`;

const resolveConnection = async (
  cfg: EwsConnectionConfig,
): Promise<ResolvedConnection> => {
  // Both provided manually → trust them, no probe.
  if (cfg.ewsUrl !== undefined && cfg.exchangeVersion !== undefined) {
    return { url: cfg.ewsUrl, version: cfg.exchangeVersion };
  }
  const key = cacheKey(cfg);
  const cached = resolutionCache.get(key);
  if (cached !== undefined) return cached;
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;

  const promise = (async (): Promise<ResolvedConnection> => {
    const resolved = await resolveUrlAndVersion(cfg);
    resolutionCache.set(key, resolved);
    return resolved;
  })();
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
};

/**
 * Resolve the connection (Autodiscover URL + ServerInfo version, cached),
 * build a fresh Basic-authed service, run `fn`, and normalize EWS errors to an
 * actionable message. `fn` receives the resolved version (some actions, e.g.
 * flag, are gated on Exchange 2013+).
 */
export const withService = async <T>(
  cfg: EwsConnectionConfig,
  fn: (service: ExchangeService, version: EwsVersionId) => Promise<T>,
): Promise<T> => {
  try {
    const { url, version } = await resolveConnection(cfg);
    const service = buildServiceAt(cfg, version, url);
    return await fn(service, version);
  } catch (error) {
    throw new Error(ewsErrorMessage(error), { cause: error });
  }
};

// ── Well-known folders ────────────────────────────────────────────────

export type EwsWellKnownFolder =
  | "inbox"
  | "sentitems"
  | "drafts"
  | "deleteditems"
  | "archive"
  | "junkemail";

const WELL_KNOWN: Record<EwsWellKnownFolder, WellKnownFolderName> = {
  inbox: WellKnownFolderName.Inbox,
  sentitems: WellKnownFolderName.SentItems,
  drafts: WellKnownFolderName.Drafts,
  deleteditems: WellKnownFolderName.DeletedItems,
  archive: WellKnownFolderName.ArchiveMsgFolderRoot,
  junkemail: WellKnownFolderName.JunkEmail,
};

export const wellKnownFolder = (
  name: EwsWellKnownFolder,
): WellKnownFolderName => WELL_KNOWN[name];

// ── Property sets ─────────────────────────────────────────────────────

/** Lightweight set for message listings (no body, no recipients). */
export const messageSummaryPropertySet = (): PropertySet =>
  new PropertySet(
    BasePropertySet.IdOnly,
    ItemSchema.Subject,
    ItemSchema.DateTimeReceived,
    ItemSchema.HasAttachments,
    EmailMessageSchema.From,
    EmailMessageSchema.IsRead,
  );

/** Full set with the HTML body forced — for get_message. */
export const messageFullPropertySet = (): PropertySet => {
  const set = new PropertySet(BasePropertySet.FirstClassProperties);
  set.RequestedBodyType = BodyType.HTML;
  return set;
};

/** Scalar calendar fields for event listings (attendees come on bind). */
export const eventPropertySet = (): PropertySet =>
  new PropertySet(
    BasePropertySet.IdOnly,
    ItemSchema.Subject,
    AppointmentSchema.Start,
    AppointmentSchema.End,
    AppointmentSchema.Location,
    AppointmentSchema.Organizer,
    AppointmentSchema.IsOnlineMeeting,
  );

export const contactPropertySet = (): PropertySet =>
  new PropertySet(
    BasePropertySet.IdOnly,
    ContactSchema.DisplayName,
    ContactSchema.CompanyName,
    ContactSchema.JobTitle,
    ContactSchema.EmailAddresses,
    ContactSchema.PhoneNumbers,
  );

/** Id + attachment metadata — for list/download attachment binds. */
export const attachmentsPropertySet = (): PropertySet =>
  new PropertySet(BasePropertySet.IdOnly, ItemSchema.Attachments);

export const idOnlyPropertySet = (): PropertySet =>
  new PropertySet(BasePropertySet.IdOnly);

/** Id + IsRead — minimal set for read/unread flips. */
export const readStatePropertySet = (): PropertySet =>
  new PropertySet(BasePropertySet.IdOnly, EmailMessageSchema.IsRead);

// ── Read helpers (null/not-loaded safe, no `as`) ──────────────────────

/** Read an `.Address` off any EWS mailbox-like object. */
const readAddress = (value: unknown): string => str(prop(value, "Address"));

/** Coerce an EWS `DateTime` to ISO 8601; "" when absent/invalid. */
export const ewsDateToIso = (value: unknown): string => {
  if (!(value instanceof DateTime)) return "";
  try {
    return value.ToISOString();
  } catch {
    return "";
  }
};

/** Run a read that may throw "property not loaded"; fall back on error. */
const safe = <T>(read: () => T, fallback: T): T => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

/** Collect non-empty addresses from an EWS address/attendee collection. */
const collectAddresses = (collection: {
  GetEnumerator(): unknown[];
}): string[] =>
  collection
    .GetEnumerator()
    .map((entry) => readAddress(entry))
    .filter((address) => address.length > 0);

const optionalStr = (value: unknown): string | undefined => {
  const s = str(value);
  return s.length > 0 ? s : undefined;
};

// ── Normalized shapes (match the manifest `types`) ─────────────────────

export interface MessageSummary {
  id: string;
  subject: string;
  from_address: string;
  to: string[];
  received_at: string;
  is_read: boolean;
  has_attachments: boolean;
  body_preview: string;
}

export interface MessageFull {
  id: string;
  subject: string;
  from_address: string;
  to: string[];
  cc: string[];
  received_at: string;
  is_read: boolean;
  has_attachments: boolean;
  body_html: string;
}

export interface CalendarEventShape {
  id: string;
  subject: string;
  start: string;
  end: string;
  location?: string;
  organizer?: string;
  attendees: string[];
  is_online_meeting: boolean;
  body_preview?: string;
}

export interface ContactShape {
  id: string;
  display_name: string;
  email_addresses: string[];
  company_name?: string;
  job_title?: string;
  mobile_phone?: string;
}

export interface MailFolderShape {
  id: string;
  display_name: string;
  parent_folder_id?: string;
  total_item_count: number;
  unread_item_count: number;
}

export interface InboxRuleShape {
  id: string;
  display_name: string;
  sequence: number;
  is_enabled: boolean;
  has_error?: boolean;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  content_type: string;
  size_bytes: number;
}

// ── Normalizers ───────────────────────────────────────────────────────

const itemId = (item: Item): string => str(path(item, "Id", "UniqueId"));

/** Item id as `string | undefined` — for write results where it may be absent. */
export const optionalItemId = (item: unknown): string | undefined => {
  const id = str(path(item, "Id", "UniqueId"));
  return id.length > 0 ? id : undefined;
};

export const toMessageSummary = (item: Item): MessageSummary => ({
  id: itemId(item),
  subject: str(prop(item, "Subject")),
  from_address: safe(() => readAddress(prop(item, "From")), ""),
  // EWS FindItem never returns recipient collections — use get_message for full to/cc.
  to: [],
  received_at: ewsDateToIso(prop(item, "DateTimeReceived")),
  is_read: bool(prop(item, "IsRead")),
  has_attachments: bool(prop(item, "HasAttachments")),
  body_preview: "",
});

export const toMessageFull = (message: EmailMessage): MessageFull => ({
  id: itemId(message),
  subject: str(prop(message, "Subject")),
  from_address: safe(() => readAddress(prop(message, "From")), ""),
  to: safe(() => collectAddresses(message.ToRecipients), []),
  cc: safe(() => collectAddresses(message.CcRecipients), []),
  received_at: ewsDateToIso(prop(message, "DateTimeReceived")),
  is_read: bool(prop(message, "IsRead")),
  has_attachments: bool(prop(message, "HasAttachments")),
  body_html: str(path(message, "Body", "Text")),
});

export const toCalendarEvent = (
  appointment: Appointment,
): CalendarEventShape => ({
  id: itemId(appointment),
  subject: str(prop(appointment, "Subject")),
  start: ewsDateToIso(prop(appointment, "Start")),
  end: ewsDateToIso(prop(appointment, "End")),
  location: optionalStr(prop(appointment, "Location")),
  organizer: safe(
    () => optionalStr(readAddress(prop(appointment, "Organizer"))),
    undefined,
  ),
  attendees: safe(() => collectAddresses(appointment.RequiredAttendees), []),
  is_online_meeting: bool(prop(appointment, "IsOnlineMeeting")),
  body_preview: optionalStr(path(appointment, "Body", "Text")),
});

/** Contact emails live in a key-indexed dictionary (EmailAddress1..3). */
const contactEmails = (contact: Contact): string[] => {
  const dict = contact.EmailAddresses;
  const keys = [
    EmailAddressKey.EmailAddress1,
    EmailAddressKey.EmailAddress2,
    EmailAddressKey.EmailAddress3,
  ];
  const out: string[] = [];
  for (const key of keys) {
    const address = safe(() => {
      // eslint-disable-next-line no-underscore-dangle -- EWS dictionary accessor
      return dict.Contains(key) ? readAddress(dict._getItem(key)) : "";
    }, "");
    if (address.length > 0) out.push(address);
  }
  return out;
};

const contactMobile = (contact: Contact): string | undefined =>
  safe(() => {
    const phones = contact.PhoneNumbers;
    if (!phones.Contains(PhoneNumberKey.MobilePhone)) return undefined;
    // eslint-disable-next-line no-underscore-dangle -- EWS dictionary accessor
    return optionalStr(phones._getItem(PhoneNumberKey.MobilePhone));
  }, undefined);

export const toContact = (contact: Contact): ContactShape => ({
  id: itemId(contact),
  display_name: str(prop(contact, "DisplayName")),
  email_addresses: safe(() => contactEmails(contact), []),
  company_name: optionalStr(prop(contact, "CompanyName")),
  job_title: optionalStr(prop(contact, "JobTitle")),
  mobile_phone: contactMobile(contact),
});

export const toMailFolder = (folder: Folder): MailFolderShape => ({
  id: str(path(folder, "Id", "UniqueId")),
  display_name: str(prop(folder, "DisplayName")),
  parent_folder_id: optionalStr(path(folder, "ParentFolderId", "UniqueId")),
  total_item_count: num(prop(folder, "TotalCount")),
  unread_item_count: num(prop(folder, "UnreadCount")),
});

export const toInboxRule = (rule: Rule): InboxRuleShape => ({
  id: str(prop(rule, "Id")),
  display_name: str(prop(rule, "DisplayName")),
  sequence: num(prop(rule, "Priority")),
  is_enabled: bool(prop(rule, "IsEnabled")),
  has_error: bool(prop(rule, "IsInError")),
});

export const toAttachmentMeta = (attachment: Attachment): AttachmentMeta => ({
  id: str(prop(attachment, "Id")),
  name: str(prop(attachment, "Name"), "untitled"),
  content_type: str(prop(attachment, "ContentType")),
  size_bytes: num(prop(attachment, "Size")),
});

/** Base64 content of a loaded file attachment (caller must `.Load()` first). */
export const fileAttachmentBase64 = (attachment: FileAttachment): string =>
  str(prop(attachment, "Base64Content"));

// ── Outgoing attachments ──────────────────────────────────────────────

export interface OutgoingAttachment {
  name: string;
  contentType: string;
  contentBase64: string;
}

const outgoingAttachments = (items: unknown[]): OutgoingAttachment[] =>
  items.map((item) => ({
    name: str(prop(item, "name")),
    contentType: str(prop(item, "content_type")),
    contentBase64: str(prop(item, "content_base64")),
  }));

/** Attach base64-encoded files from the agent's `attachments` arg to a message. */
export const addOutgoingAttachments = (
  message: EmailMessage,
  value: unknown,
): void => {
  for (const attachment of outgoingAttachments(arr(value))) {
    message.Attachments.AddFileAttachment(
      attachment.name,
      attachment.contentBase64,
    );
  }
};
