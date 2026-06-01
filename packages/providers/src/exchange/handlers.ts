import {
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
import type { ExchangeService } from "ews-javascript-api";
import {
  AffectedTaskOccurrence,
  Appointment,
  BodyType,
  CalendarView,
  ConflictResolutionMode,
  Contact,
  DateTime,
  DeleteMode,
  EmailAddress,
  EmailAddressKey,
  EmailMessage,
  EmailMessageSchema,
  FileAttachment,
  Flag,
  Folder,
  FolderId,
  FolderTraversal,
  FolderView,
  Item,
  ItemFlagStatus,
  ItemId,
  ItemSchema,
  ItemView,
  MessageBody,
  PhoneNumberKey,
  SearchFilter,
  SendCancellationsMode,
  SendInvitationsMode,
  SendInvitationsOrCancellationsMode,
  SortDirection,
  WellKnownFolderName,
} from "ews-javascript-api";
import {
  addOutgoingAttachments,
  attachmentsPropertySet,
  contactPropertySet,
  eventPropertySet,
  fileAttachmentBase64,
  idOnlyPropertySet,
  messageFullPropertySet,
  messageSummaryPropertySet,
  optionalItemId,
  readStatePropertySet,
  toAttachmentMeta,
  toCalendarEvent,
  toContact,
  toInboxRule,
  toMailFolder,
  toMessageFull,
  toMessageSummary,
  wellKnownFolder,
  withService,
  type EwsWellKnownFolder,
} from "./client";
import { parseEwsConfig } from "./config";

/**
 * One handler per manifest action. Each is invoked with the action's
 * validated args and a `{ credentials, connection_config }` context fetched
 * by the dispatcher from Nango. `withService` builds a fresh, Basic-authed
 * `ExchangeService` per call — EWS is stateless HTTP, so there is nothing to
 * close (simpler than the IMAP `withImap`).
 *
 * Errors are thrown with actionable messages (`withService` normalizes EWS
 * exceptions); the dispatcher surfaces them to the agent.
 */

// ── Shared helpers ────────────────────────────────────────────────────

const cfgOf = (ctx: {
  credentials: Record<string, unknown>;
  connection_config: Record<string, unknown>;
}) => parseEwsConfig(ctx.credentials, ctx.connection_config);

const WELL_KNOWN_FOLDERS: readonly string[] = [
  "inbox",
  "sentitems",
  "drafts",
  "deleteditems",
  "archive",
  "junkemail",
];

const isWellKnownFolder = (value: unknown): value is EwsWellKnownFolder =>
  typeof value === "string" && WELL_KNOWN_FOLDERS.includes(value);

const buildMessageView = (limit: number, offset: number): ItemView => {
  const view = new ItemView(limit, offset);
  view.PropertySet = messageSummaryPropertySet();
  view.OrderBy.Add(ItemSchema.DateTimeReceived, SortDirection.Descending);
  return view;
};

const listFolderMessages = async (
  service: ExchangeService,
  folderId: FolderId,
  unreadOnly: boolean,
  limit: number,
  offset: number,
): Promise<unknown[]> => {
  const view = buildMessageView(limit, offset);
  const results = unreadOnly
    ? await service.FindItems(
        folderId,
        new SearchFilter.IsEqualTo(EmailMessageSchema.IsRead, false),
        view,
      )
    : await service.FindItems(folderId, view);
  return results.Items.map((item) => toMessageSummary(item));
};

/** Bind, set IsRead, update — used by single + batch read/unread flips. */
const setReadState = async (
  service: ExchangeService,
  messageId: string,
  isRead: boolean,
): Promise<void> => {
  const message = await EmailMessage.Bind(
    service,
    new ItemId(messageId),
    readStatePropertySet(),
  );
  message.IsRead = isRead;
  await message.Update(ConflictResolutionMode.AutoResolve);
};

// ── Read handlers ─────────────────────────────────────────────────────

const listMessages: ProviderHandler = async (args, ctx) => {
  const folder = asString(args.folder) ?? "inbox";
  if (!isWellKnownFolder(folder)) throw new Error(`Unknown folder: ${folder}`);
  const unreadOnly = bool(args.unread_only);
  const limit = num(args.limit, 25);
  const offset = num(args.offset, 0);
  return withService(cfgOf(ctx), (service) =>
    listFolderMessages(
      service,
      new FolderId(wellKnownFolder(folder)),
      unreadOnly,
      limit,
      offset,
    ),
  );
};

const listMessagesInFolder: ProviderHandler = async (args, ctx) => {
  const folderId = str(args.folder_id);
  if (folderId.length === 0) throw new Error("folder_id is required");
  const unreadOnly = bool(args.unread_only);
  const limit = num(args.limit, 25);
  const offset = num(args.offset, 0);
  return withService(cfgOf(ctx), (service) =>
    listFolderMessages(
      service,
      new FolderId(folderId),
      unreadOnly,
      limit,
      offset,
    ),
  );
};

const getMessage: ProviderHandler = async (args, ctx) => {
  const id = str(args.message_id);
  return withService(cfgOf(ctx), async (service) => {
    const message = await EmailMessage.Bind(
      service,
      new ItemId(id),
      messageFullPropertySet(),
    );
    return toMessageFull(message);
  });
};

const searchMessages: ProviderHandler = async (args, ctx) => {
  const query = str(args.query);
  if (query.length === 0) throw new Error("query is required");
  const limit = num(args.limit, 25);
  const offset = num(args.offset, 0);
  return withService(cfgOf(ctx), async (service) => {
    const view = buildMessageView(limit, offset);
    // EWS AQS search is per-folder — search the Inbox (mirrors imap-smtp).
    const results = await service.FindItems(
      new FolderId(WellKnownFolderName.Inbox),
      query,
      view,
    );
    return results.Items.map((item) => toMessageSummary(item));
  });
};

const listFolders: ProviderHandler = async (_args, ctx) =>
  withService(cfgOf(ctx), async (service) => {
    const view = new FolderView(1000);
    view.Traversal = FolderTraversal.Deep;
    const results = await service.FindFolders(
      new FolderId(WellKnownFolderName.MsgFolderRoot),
      view,
    );
    return results.Folders.map((folder) => toMailFolder(folder));
  });

const listMessageAttachments: ProviderHandler = async (args, ctx) => {
  const id = str(args.message_id);
  return withService(cfgOf(ctx), async (service) => {
    const item = await Item.Bind(
      service,
      new ItemId(id),
      attachmentsPropertySet(),
    );
    return item.Attachments.GetEnumerator().map((attachment) =>
      toAttachmentMeta(attachment),
    );
  });
};

const downloadMessageAttachment: ProviderHandler = async (args, ctx) => {
  const id = str(args.message_id);
  const attachmentId = str(args.attachment_id);
  if (attachmentId.length === 0) throw new Error("attachment_id is required");
  return withService(cfgOf(ctx), async (service) => {
    const item = await Item.Bind(
      service,
      new ItemId(id),
      attachmentsPropertySet(),
    );
    const match = item.Attachments.GetEnumerator().find(
      (attachment) => str(prop(attachment, "Id")) === attachmentId,
    );
    if (match === undefined) {
      throw new Error(`Attachment ${attachmentId} not found on message ${id}`);
    }
    if (!(match instanceof FileAttachment)) {
      throw new Error("Only file attachments can be downloaded");
    }
    await match.Load();
    // content_base64 is spilled to sandbox_path by the Python runtime.
    return {
      id: attachmentId,
      name: str(prop(match, "Name"), "untitled"),
      content_type: str(prop(match, "ContentType")),
      size_bytes: num(prop(match, "Size")),
      content_base64: fileAttachmentBase64(match),
    };
  });
};

const listCalendarEvents: ProviderHandler = async (args, ctx) => {
  const start = str(args.start);
  const end = str(args.end);
  if (start.length === 0 || end.length === 0) {
    throw new Error("start and end are required");
  }
  const limit = num(args.limit, 50);
  const offset = num(args.offset, 0);
  return withService(cfgOf(ctx), async (service) => {
    // CalendarView expands recurring series into individual occurrences.
    const view = new CalendarView(
      DateTime.Parse(start),
      DateTime.Parse(end),
      offset + limit,
    );
    view.PropertySet = eventPropertySet();
    const results = await service.FindAppointments(
      WellKnownFolderName.Calendar,
      view,
    );
    return results.Items.slice(offset, offset + limit).map((appointment) =>
      toCalendarEvent(appointment),
    );
  });
};

const getCalendarEvent: ProviderHandler = async (args, ctx) => {
  const id = str(args.event_id);
  return withService(cfgOf(ctx), async (service) => {
    const appointment = await Appointment.Bind(
      service,
      new ItemId(id),
      messageFullPropertySet(),
    );
    return toCalendarEvent(appointment);
  });
};

const listContacts: ProviderHandler = async (args, ctx) => {
  const limit = num(args.limit, 50);
  const offset = num(args.offset, 0);
  return withService(cfgOf(ctx), async (service) => {
    const view = new ItemView(limit, offset);
    view.PropertySet = contactPropertySet();
    const results = await service.FindItems(
      new FolderId(WellKnownFolderName.Contacts),
      view,
    );
    return results.Items.filter(
      (item): item is Contact => item instanceof Contact,
    ).map((contact) => toContact(contact));
  });
};

const listInboxRules: ProviderHandler = async (_args, ctx) => {
  const cfg = cfgOf(ctx);
  return withService(cfg, async (service) => {
    const rules = await service.GetInboxRules(cfg.email);
    return rules.GetEnumerator().map((rule) => toInboxRule(rule));
  });
};

// ── Write handlers ────────────────────────────────────────────────────

const sendEmail: ProviderHandler = async (args, ctx) => {
  const to = strArray(args.to);
  if (to.length === 0)
    throw new Error("`to` must include at least one address");
  return withService(cfgOf(ctx), async (service) => {
    const message = new EmailMessage(service);
    message.Subject = str(args.subject);
    message.Body = new MessageBody(BodyType.HTML, str(args.body_html));
    for (const address of to) message.ToRecipients.Add(address);
    for (const address of strArray(args.cc)) message.CcRecipients.Add(address);
    for (const address of strArray(args.bcc))
      message.BccRecipients.Add(address);
    addOutgoingAttachments(message, args.attachments);
    await message.SendAndSaveCopy();
    return { id: optionalItemId(message) };
  });
};

const replyEmail: ProviderHandler = async (args, ctx) => {
  const id = str(args.message_id);
  return withService(cfgOf(ctx), async (service) => {
    const message = await EmailMessage.Bind(service, new ItemId(id));
    await message.Reply(
      new MessageBody(BodyType.HTML, str(args.body_html)),
      false,
    );
    return {};
  });
};

const replyAllEmail: ProviderHandler = async (args, ctx) => {
  const id = str(args.message_id);
  return withService(cfgOf(ctx), async (service) => {
    const message = await EmailMessage.Bind(service, new ItemId(id));
    await message.Reply(
      new MessageBody(BodyType.HTML, str(args.body_html)),
      true,
    );
    return {};
  });
};

const forwardEmail: ProviderHandler = async (args, ctx) => {
  const id = str(args.message_id);
  const to = strArray(args.to);
  if (to.length === 0)
    throw new Error("`to` must include at least one address");
  return withService(cfgOf(ctx), async (service) => {
    const message = await EmailMessage.Bind(service, new ItemId(id));
    await message.Forward(
      new MessageBody(BodyType.HTML, str(args.comment)),
      to.map((address) => new EmailAddress(address)),
    );
    return {};
  });
};

const createDraft: ProviderHandler = async (args, ctx) =>
  withService(cfgOf(ctx), async (service) => {
    const message = new EmailMessage(service);
    message.Subject = str(args.subject);
    message.Body = new MessageBody(BodyType.HTML, str(args.body_html));
    for (const address of strArray(args.to)) message.ToRecipients.Add(address);
    for (const address of strArray(args.cc)) message.CcRecipients.Add(address);
    addOutgoingAttachments(message, args.attachments);
    await message.Save(WellKnownFolderName.Drafts);
    return { id: optionalItemId(message) };
  });

const updateDraft: ProviderHandler = async (args, ctx) => {
  const id = str(args.message_id);
  return withService(cfgOf(ctx), async (service) => {
    const message = await EmailMessage.Bind(service, new ItemId(id));
    const subject = asString(args.subject);
    if (subject !== undefined) message.Subject = subject;
    const body = asString(args.body_html);
    if (body !== undefined) message.Body = new MessageBody(BodyType.HTML, body);
    await message.Update(ConflictResolutionMode.AutoResolve);
    return { id };
  });
};

const deleteMessage: ProviderHandler = async (args, ctx) => {
  const id = str(args.message_id);
  return withService(cfgOf(ctx), async (service) => {
    const item = await Item.Bind(service, new ItemId(id), idOnlyPropertySet());
    await item.Delete(DeleteMode.MoveToDeletedItems);
    return { id };
  });
};

const moveMessage: ProviderHandler = async (args, ctx) => {
  const id = str(args.message_id);
  const destination = str(args.destination_folder_id);
  if (destination.length === 0) {
    throw new Error("destination_folder_id is required");
  }
  return withService(cfgOf(ctx), async (service) => {
    const item = await Item.Bind(service, new ItemId(id), idOnlyPropertySet());
    const moved = await item.Move(new FolderId(destination));
    return { id: optionalItemId(moved) ?? id };
  });
};

const copyMessage: ProviderHandler = async (args, ctx) => {
  const id = str(args.message_id);
  const destination = str(args.destination_folder_id);
  if (destination.length === 0) {
    throw new Error("destination_folder_id is required");
  }
  return withService(cfgOf(ctx), async (service) => {
    const item = await Item.Bind(service, new ItemId(id), idOnlyPropertySet());
    const copied = await item.Copy(new FolderId(destination));
    return { id: optionalItemId(copied) ?? id };
  });
};

const deleteMessages: ProviderHandler = async (args, ctx) => {
  const ids = strArray(args.message_ids);
  if (ids.length === 0) return [];
  return withService(cfgOf(ctx), async (service) => {
    await service.DeleteItems(
      ids.map((id) => new ItemId(id)),
      DeleteMode.MoveToDeletedItems,
      SendCancellationsMode.SendToNone,
      AffectedTaskOccurrence.AllOccurrences,
    );
    return ids.map((id) => ({ id }));
  });
};

const moveMessages: ProviderHandler = async (args, ctx) => {
  const ids = strArray(args.message_ids);
  if (ids.length === 0) return [];
  const destination = str(args.destination_folder_id);
  if (destination.length === 0) {
    throw new Error("destination_folder_id is required");
  }
  return withService(cfgOf(ctx), async (service) => {
    const result = await service.MoveItems(
      ids.map((id) => new ItemId(id)),
      new FolderId(destination),
    );
    return result.Responses.map((response, index) => ({
      id: optionalItemId(response.Item) ?? ids[index],
    }));
  });
};

const markMessagesRead: ProviderHandler = async (args, ctx) => {
  const ids = strArray(args.message_ids);
  if (ids.length === 0) return [];
  return withService(cfgOf(ctx), async (service) => {
    await Promise.all(ids.map((id) => setReadState(service, id, true)));
    return ids.map((id) => ({ id }));
  });
};

const markMessagesUnread: ProviderHandler = async (args, ctx) => {
  const ids = strArray(args.message_ids);
  if (ids.length === 0) return [];
  return withService(cfgOf(ctx), async (service) => {
    await Promise.all(ids.map((id) => setReadState(service, id, false)));
    return ids.map((id) => ({ id }));
  });
};

const markRead: ProviderHandler = async (args, ctx) => {
  const id = str(args.message_id);
  return withService(cfgOf(ctx), async (service) => {
    await setReadState(service, id, true);
    return { id };
  });
};

const markUnread: ProviderHandler = async (args, ctx) => {
  const id = str(args.message_id);
  return withService(cfgOf(ctx), async (service) => {
    await setReadState(service, id, false);
    return { id };
  });
};

const flagMessage: ProviderHandler = async (args, ctx) => {
  const id = str(args.message_id);
  const status = str(args.status, "flagged");
  // `version` is the resolved (possibly auto-detected) schema version.
  return withService(cfgOf(ctx), async (service, version) => {
    if (version === "Exchange2010_SP2") {
      throw new Error("flag_message requires Exchange 2013 or newer");
    }
    const item = await Item.Bind(service, new ItemId(id));
    const flag = new Flag();
    flag.FlagStatus =
      status === "complete"
        ? ItemFlagStatus.Complete
        : status === "notFlagged"
          ? ItemFlagStatus.NotFlagged
          : ItemFlagStatus.Flagged;
    const dueDate = asString(args.due_date);
    if (status === "flagged" && dueDate !== undefined) {
      flag.DueDate = DateTime.Parse(dueDate);
    }
    item.Flag = flag;
    await item.Update(ConflictResolutionMode.AutoResolve);
    return { id };
  });
};

const createFolder: ProviderHandler = async (args, ctx) => {
  const displayName = str(args.display_name);
  if (displayName.length === 0) throw new Error("display_name is required");
  const parentId = asString(args.parent_folder_id);
  return withService(cfgOf(ctx), async (service) => {
    const folder = new Folder(service);
    folder.DisplayName = displayName;
    if (parentId !== undefined && parentId.length > 0) {
      await folder.Save(new FolderId(parentId));
    } else {
      await folder.Save(WellKnownFolderName.MsgFolderRoot);
    }
    return toMailFolder(folder);
  });
};

const createCalendarEvent: ProviderHandler = async (args, ctx) => {
  const start = str(args.start);
  const end = str(args.end);
  if (start.length === 0 || end.length === 0) {
    throw new Error("start and end are required");
  }
  return withService(cfgOf(ctx), async (service) => {
    const appointment = new Appointment(service);
    appointment.Subject = str(args.subject);
    const body = asString(args.body_html);
    if (body !== undefined) {
      appointment.Body = new MessageBody(BodyType.HTML, body);
    }
    appointment.Start = DateTime.Parse(start);
    appointment.End = DateTime.Parse(end);
    const location = asString(args.location);
    if (location !== undefined) appointment.Location = location;
    if (bool(args.is_online_meeting)) appointment.IsOnlineMeeting = true;
    for (const address of strArray(args.attendees)) {
      appointment.RequiredAttendees.Add(address);
    }
    await appointment.Save(SendInvitationsMode.SendToAllAndSaveCopy);
    return toCalendarEvent(appointment);
  });
};

const updateCalendarEvent: ProviderHandler = async (args, ctx) => {
  const id = str(args.event_id);
  return withService(cfgOf(ctx), async (service) => {
    const appointment = await Appointment.Bind(service, new ItemId(id));
    const subject = asString(args.subject);
    if (subject !== undefined) appointment.Subject = subject;
    const start = asString(args.start);
    if (start !== undefined) appointment.Start = DateTime.Parse(start);
    const end = asString(args.end);
    if (end !== undefined) appointment.End = DateTime.Parse(end);
    const location = asString(args.location);
    if (location !== undefined) appointment.Location = location;
    const body = asString(args.body_html);
    if (body !== undefined) {
      appointment.Body = new MessageBody(BodyType.HTML, body);
    }
    await appointment.Update(
      ConflictResolutionMode.AutoResolve,
      SendInvitationsOrCancellationsMode.SendToAllAndSaveCopy,
    );
    return toCalendarEvent(appointment);
  });
};

const deleteCalendarEvent: ProviderHandler = async (args, ctx) => {
  const id = str(args.event_id);
  return withService(cfgOf(ctx), async (service) => {
    const appointment = await Appointment.Bind(
      service,
      new ItemId(id),
      idOnlyPropertySet(),
    );
    await appointment.Delete(
      DeleteMode.MoveToDeletedItems,
      SendCancellationsMode.SendToAllAndSaveCopy,
    );
    return { id };
  });
};

const respondToEvent: ProviderHandler = async (args, ctx) => {
  const id = str(args.event_id);
  const response = str(args.response);
  return withService(cfgOf(ctx), async (service) => {
    const appointment = await Appointment.Bind(service, new ItemId(id));
    if (response === "accept") {
      await appointment.Accept(true);
    } else if (response === "decline") {
      await appointment.Decline(true);
    } else if (response === "tentativelyAccept") {
      await appointment.AcceptTentatively(true);
    } else {
      throw new Error(`Unknown response: ${response}`);
    }
    return { id };
  });
};

const createContact: ProviderHandler = async (args, ctx) => {
  const givenName = str(args.given_name);
  if (givenName.length === 0) throw new Error("given_name is required");
  const surname = asString(args.surname);
  return withService(cfgOf(ctx), async (service) => {
    const contact = new Contact(service);
    contact.GivenName = givenName;
    if (surname !== undefined) contact.Surname = surname;
    contact.DisplayName =
      surname !== undefined ? `${givenName} ${surname}` : givenName;
    const company = asString(args.company_name);
    if (company !== undefined) contact.CompanyName = company;
    const jobTitle = asString(args.job_title);
    if (jobTitle !== undefined) contact.JobTitle = jobTitle;
    const email = asString(args.email);
    if (email !== undefined) {
      // eslint-disable-next-line no-underscore-dangle -- EWS dictionary accessor
      contact.EmailAddresses._setItem(
        EmailAddressKey.EmailAddress1,
        new EmailAddress(email),
      );
    }
    const mobile = asString(args.mobile_phone);
    if (mobile !== undefined) {
      // eslint-disable-next-line no-underscore-dangle -- EWS dictionary accessor
      contact.PhoneNumbers._setItem(PhoneNumberKey.MobilePhone, mobile);
    }
    await contact.Save(WellKnownFolderName.Contacts);
    return toContact(contact);
  });
};

// ── Exported handler registry ─────────────────────────────────────────

export const exchangeHandlers: ProviderHandlers = {
  listMessages,
  getMessage,
  searchMessages,
  listMessagesInFolder,
  listFolders,
  listMessageAttachments,
  downloadMessageAttachment,
  listCalendarEvents,
  getCalendarEvent,
  listContacts,
  listInboxRules,
  sendEmail,
  replyEmail,
  replyAllEmail,
  forwardEmail,
  createDraft,
  updateDraft,
  deleteMessage,
  moveMessage,
  copyMessage,
  deleteMessages,
  moveMessages,
  markMessagesRead,
  markMessagesUnread,
  markRead,
  markUnread,
  flagMessage,
  createFolder,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  respondToEvent,
  createContact,
};
