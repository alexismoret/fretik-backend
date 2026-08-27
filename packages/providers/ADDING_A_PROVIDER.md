# Adding a new provider — step-by-step checklist

Authoritative for any new external-app provider (Gmail, Slack, Teams,
WhatsApp, Twilio, OneDrive, Google Drive, Dropbox, Notion, AirTable,
Trello, Stripe, Salesforce, Front, Docusign, Canva, Akanea, Shiptify, …).

Read `CLAUDE.md` in this package first for context; this document is the
detailed procedure that fills the gaps. Read
`.agent/agent-context-framework.md` before writing any text that ends up
in the SKILL — it gates `guidance.md` and every `summary:` / `description:`
in the manifest.

---

## 0. Decide three things before writing code

1. **Transport.**
   - `nango-proxy` — provider has an OAuth integration on Nango AND we will
     call its REST endpoints directly through `nango.proxy(...)`. Default
     when the API is HTTP+OAuth. Examples today: `outlook`.
   - `custom-handler` — protocol is not HTTP (IMAP/SMTP), the API is
     SDK-only, or we need credentials we collect ourselves (API key, Basic
     Auth). Examples today: `imap-smtp`.
2. **Root category** (exactly one). Picked from the list documented in
   `@fretik/shared/external-apps/manifest-schema.ts` (see the JSDoc on
   `categories`). NEVER invent a root — every provider must fit.
3. **Fine-grained capabilities** (zero or more). Used by the agent for
   disambiguation. Use existing slugs whenever the capability is the same
   thing under a different name — e.g. WhatsApp and Slack both speak
   `instant-messaging`, do not invent `whatsapp-messaging`.

## 1. Decide the data model

For each user-facing action you ship, decide:

- The `params` (what the agent sends).
- The `returns` (what the agent gets back). For read actions, define a
  named `type` in `manifest.types` so the SKILL.md "Data models" section
  documents the EXACT Pydantic field names — the agent stops guessing
  `m.sender` vs `m.from_address`.
- The `kind`:
  - `read` — auto-approved, executes immediately. Eager use.
  - `write` — gated behind `run_plan(...)` user approval. Requires a
    `summaries` entry.

**Ship the minimum that is useful, not every endpoint the provider exposes.**
Each action is ~10 lines of SKILL + 1 Python wrapper + 1 mapper/handler. A
manifest with 40 actions burns tokens in every prompt and dilutes the ones
that matter. Start with 5-10 that cover 80% of the use cases.

## 2. Create the provider folder

```
backend/packages/providers/src/<key>/
  manifest.ts            # required — provider declaration
  index.ts               # required — exports { manifest, mappers?, handlers?, testCredentials?, summaries }
  mappers.ts             # required if transport = nango-proxy
  handlers.ts            # required if transport = custom-handler
  test-connection.ts     # required if credentialsForm.testConnection.supported = true
  summaries.ts           # required if any action.kind = "write"
  guidance.md            # required — appended verbatim into the SKILL.md
  client.ts              # optional — protocol/SDK lib (e.g. imapflow setup)
  SETUP.md               # optional — operator docs (not agent-facing)
```

`<key>` is kebab-case and matches `manifest.key`.

## 3. Author the manifest

Authoritative shape: `@fretik/shared/external-apps/manifest-schema.ts`.

### Required fields

```ts
export const fooManifest: ProviderManifest = {
  key: "foo",                          // kebab-case
  displayName: "Foo",
  nangoProviderConfigKey: "foo",       // must match Nango dashboard slug
  icon: "i-simple-icons-foo",          // Iconify name OR "/app-icons/foo.svg"
  iconColor: "#0078D4",                // optional, only for monochrome Iconify
  transport: { kind: "nango-proxy" },  // or "custom-handler"
  scopes: ["foo.read", "foo.write"],   // OAuth scopes; [] if custom-handler/no OAuth
  categories: ["communication", "email"], // root first, fine slugs after
  connectionOptions: { ... },          // see §4
  credentialsForm: { ... },            // ONLY for custom-handler
  types: { ... },                      // named types referenced by returns
  actions: [ ... ],                    // see §5
}
```

### Category mapping for the providers we plan to ship

| Provider        | Root            | Fine                                          |
| --------------- | --------------- | --------------------------------------------- |
| outlook         | `communication` | `email`, `calendar`, `contacts`               |
| imap-smtp       | `communication` | `email`                                       |
| gmail           | `communication` | `email`                                       |
| teams           | `communication` | `instant-messaging`, `video-call`, `calendar` |
| slack           | `communication` | `instant-messaging`                           |
| whatsapp        | `communication` | `instant-messaging`                           |
| twilio          | `communication` | `sms`, `voice`                                |
| front           | `communication` | `shared-inbox`, `email`                       |
| google-drive    | `storage`       | `file-storage`                                |
| onedrive        | `storage`       | `file-storage`                                |
| dropbox         | `storage`       | `file-storage`                                |
| google-calendar | `productivity`  | `calendar`                                    |
| notion          | `productivity`  | `notes`, `database`, `tasks`                  |
| airtable        | `productivity`  | `database`                                    |
| trello          | `productivity`  | `tasks`                                       |
| salesforce      | `crm`           |                                               |
| stripe          | `payments`      |                                               |
| docusign        | `documents`     | `e-signature`                                 |
| canva           | `design`        |                                               |
| akanea          | `industry`      | `tms`, `customs`                              |
| akanea-wms      | `industry`      | `wms`                                         |
| shiptify        | `industry`      | `tms`                                         |

If a provider you are adding is not in this table, pick the root that
matches the user's job-to-be-done with that provider, not the company that
makes it. A "Stripe Tax" integration would still be `payments`.

## 4. `connectionOptions` — per-connection runtime options

Stored as `external_app_connections.options jsonb`, validated dynamically.
Add a field whenever the user must make a per-connection choice that
changes how Fretik (or the chatbot) uses that connection.

### Mandatory: `persona` on EVERY `communication` provider

Communication providers carry exactly one obligatory option:

```ts
connectionOptions: {
  fields: [
    {
      key: "persona",
      labelKey: "settings.externalApps.options.persona.label",
      helpKey: "settings.externalApps.options.persona.help",
      kind: "select",
      required: true,
      default: "personal",
      options: [
        {
          value: "personal",
          labelKey: "settings.externalApps.options.persona.personal",
          descriptionKey: "settings.externalApps.options.persona.personalHelp",
        },
        {
          value: "bot",
          labelKey: "settings.externalApps.options.persona.bot",
          descriptionKey: "settings.externalApps.options.persona.botHelp",
        },
      ],
      exposeToAgent: true,
    },
  ],
},
```

The i18n keys already exist in `app/i18n/locales/en.ts`. The
`AddConnectionModal` pre-selects `persona: "bot"` when scope is `team`
and `persona: "personal"` when scope is `user` — you do not need extra
frontend code.

### Optional: provider-specific options

Anything else the user toggles per connection (`auto_reply`, `signature`,
`default_folder`, …). Mirror the persona shape; pick `kind` from
`boolean | text | textarea | number | select`. Set
`exposeToAgent: true` only when the value materially changes how the
chatbot writes. Default to `false` — agent context is precious.

### NOT in `connectionOptions`

- Credentials (host, port, password, API key) → `credentialsForm`.
- Provider catalogue facts (display name, icon, scopes) → manifest top
  level.
- Per-action knobs the agent picks per call → action `params`.

## 5. Author actions

For each action:

```ts
{
  name: "send_email",            // snake_case, unique per provider
  kind: "write",                 // or "read"
  summary: "Send a new email",   // 1 line, ≤ 80 chars, present-tense — see prose rules
  endpoint: { method: "POST", path: "/me/sendMail" }, // nango-proxy only
  handler: "sendEmail",          // custom-handler only — matches handlers.ts export
  params: {
    to: { type: "array", items: { type: "email" }, in: "body" },
    subject: { type: "string", in: "body" },
    body_html: { type: "string", in: "body", excludeFromHash: true },
    cc: { type: "array", items: { type: "email" }, optional: true, in: "body" },
  },
  returns: { ref: "WriteResult" },
}
```

### Action `summary` — apply the prose rules

- ✅ "Send a new email"
- ✅ "List unread messages in a folder"
- ❌ "This action allows you to send a new email to one or more recipients."
- ❌ "Send" (too vague)

### Param shapes

- Use `type: "email"` for email addresses (renders typed in the Python SDK,
  documented in the SKILL).
- Use `type: "datetime"` for ISO 8601 strings.
- Use `type: "enum"` with `values: [...]` for closed sets.
- Set `optional: true` for non-required params. Pair with `default: ...`
  when there is a natural default; without a default, the SDK passes
  `None`.
- Set `excludeFromHash: true` on free-text body fields the agent may
  legitimately rewrite verbatim between turns (message bodies, comments).
  Without it, a re-run after approval forces a new approval prompt.

### Param `description?`

Add it ONLY when the name is not self-explanatory. `to: list[email]` does
not need a description. `from_address: str` does need "Sender email
address" because field names vary across providers.

## 6. Write `guidance.md`

Appended verbatim to the generated SKILL.md. Read
`.agent/agent-context-framework.md` before opening the file.

### Required sections

- **`## Patterns`** — 2-4 short subsections covering the dominant flows.
  Examples: "Read an email then reply", "Send multiple messages in one
  approval", "Pagination", "Attachments". One canonical code example per
  subsection.
- **`### Multiple connected <thing>`** — boilerplate that points back to
  the system prompt's `<external_apps>` disambiguation rule. Copy from
  `outlook/guidance.md` or `imap-smtp/guidance.md` and adapt the
  provider-specific example.

### Forbidden sections

- ❌ A duplicate of the persona / voice rules — the generator adds those
  automatically for `categories.includes("communication")`. Adding them
  again wastes tokens and risks divergence.
- ❌ A duplicate of `run_plan` / approval semantics — the generator
  appends the `skillBoilerplate` verbatim. Do not restate.
- ❌ Operator setup steps (how to create the Nango integration, OAuth
  console screenshots, …) — put those in `SETUP.md`, not `guidance.md`.

### Length budget

Aim for ≤ 150 lines. If you blow past that, you are padding. Move
overflow into one of: action-specific patterns the agent will read on
demand (separate `.md` files under a future `references/` dir if we need
one), the `summary` of the action itself, or just delete.

## 7. Mappers / handlers

### `nango-proxy` (mappers.ts)

```ts
export const mappers: ProviderMappers = {
  request: {
    sendEmailRequest: (args) => ({ message: { ... }, saveToSentItems: true }),
  },
  response: {
    listMessagesResponse: (raw) => raw.value.map((m: any) => ({ ... })),
  },
}
```

Wire them in by referencing `request: "sendEmailRequest"` /
`response: "listMessagesResponse"` on the action. The generic executor
handles param placement by `in: "path" | "query" | "body"` — only write a
mapper when you need to reshape.

### `custom-handler` (handlers.ts)

```ts
export const handlers: ProviderHandlers = {
  sendEmail: async (args, { credentials, connection_config }) => { ... },
}
```

Action references `handler: "sendEmail"`. Errors thrown from the handler
surface to the agent with `EXTERNAL_APP_HANDLER_FAILED` — make sure the
message is actionable ("SMTP auth failed: 535 5.7.8"), not a stack trace.

## 8. Summaries

Every write action must have a summary builder in `summaries.ts`:

```ts
export const summaries: ProviderSummaries = {
  send_email: (args) => ({
    providerKey: "foo",
    action: "send_email",
    titleKey: "chatbot.approvals.foo.send_email.title",
    fields: [
      { labelKey: "to", value: (args.to as string[]).join(", ") },
      { labelKey: "subject", value: String(args.subject) },
      { labelKey: "body", value: String(args.body_html), kind: "html" },
    ],
  }),
};
```

i18n keys live under `chatbot.approvals.<providerKey>.<action>.title` in
`@fretik/shared/src/external-apps/i18n/locales/en.ts`. Add them.

### User-friendly fields — avoid opaque IDs

The approval card is read by a non-technical end user. They cannot
verify a `chat_id`, `team_id`, `channel_id`, `message_id`, `folder_id`,
`event_id`, or any other provider-generated identifier — those strings
look like noise.

**Rule:** surface only fields the user can sanity-check on their own —
message body, subject, recipient emails / display names, attachment
names, dates, free-text titles. **Skip IDs entirely.** If every available
field on an action is an ID, the title alone is the card.

Do NOT fetch the ID's human name via an extra Graph call inside the
mapper — mappers are sync and a second round-trip per approval inflates
latency. If the agent already knows the friendly name (it just listed
chats by name before picking one), trust that the agent picked
correctly. The body of the message is the load-bearing review surface.

Acceptable when nothing else exists:

- Recipient emails — humans read them as identity, not as IDs.
- Counts ("Delete 12 emails") — a number is verifiable.
- File names — supplied by the agent, human-readable.

Avoid:

- `chat_id: "19:abc…@thread.tacv2"` — meaningless to the user.
- `event_id: "AAMkAGUz…"` — same.
- `message_id` rows on a reply card — the body says it all.

## 9. Test credentials (custom-handler only)

If `credentialsForm.testConnection.supported = true`, export
`testCredentials` from `index.ts`. Return
`{ ok: true }` or `{ ok: false, scope?, message }` — `scope` lets the UI
pin the error to a sub-system (`imap` vs `smtp`).

## 10. Wire the provider in `src/index.ts`

```ts
setProviders({
  foo: {
    manifest: fooManifest,
    handlers, // OR mappers
    testCredentials, // if applicable
    summaries,
  },
});
```

## 11. Regenerate the SDK + SKILL

```bash
cd backend/packages/providers && bun run gen:sdk
```

This rewrites `backend/packages/ai/sandbox-assets/fretik_apps/<key>.py`
and `.../skills/<key>/SKILL.md`. Both files are committed to git — CI
re-runs the generator and `git diff --exit-code`s the output. Commit
them with your manifest change.

## 12. i18n keys

Add what your manifest references:

- `settings.externalApps.providers.<key>.*` — credentials form (if any).
- `chatbot.approvals.<key>.<action>.title` — summary card title per write
  action.
- `chatbot.approvals.fields.*` — only if you use a labelKey not already
  in the shared set.

Categories are pre-translated in `app/i18n/locales/en.ts` under
`settings.externalApps.category.*`. If your provider needs a new root
category, propose it before adding — the list is intentionally closed.

## 13. Configure Nango

Self-hosted dashboard at the Nango URL in your env. Create an integration
with the unique key matching `manifest.nangoProviderConfigKey`. For
OAuth providers, paste the client id / secret. For Basic Auth providers
(`private-api-basic`), no client credentials are needed.

## 14. Final checks

Before opening a PR:

```bash
cd backend/packages/providers && bun run check          # typecheck + lint
cd backend/packages/providers && bun run gen:sdk        # regen, then `git diff` should be empty unless you intended changes
cd backend/packages/shared    && bun run check
cd backend/packages/api       && bun run check
cd backend/packages/ai        && bun run check
cd app                        && bun run lint
```

Manual smoke test (via `./dev.sh`):

1. Open settings → external apps → add connection → pick the new
   provider.
2. For `communication` providers: verify the persona radio appears at
   the right step and pre-selects per scope (team → bot, user →
   personal).
3. Complete the OAuth / credentials flow. The connection card should
   show the right category badge + persona badge.
4. In the chatbot, ask the agent to do a read action — verify the SKILL
   loads and the action runs.
5. Ask for a write action — verify the approval card renders with the
   right title and fields.

## 15. What to commit

Single PR, in order:

- `backend/packages/providers/src/<key>/*` — manifest + handlers/mappers
  - summaries + guidance + (test-connection)
- `backend/packages/providers/src/index.ts` — `setProviders({...})` update
- `backend/packages/ai/sandbox-assets/fretik_apps/<key>.py` — regenerated
- `backend/packages/ai/sandbox-assets/skills/<key>/SKILL.md` — regenerated
- `backend/packages/shared/src/external-apps/i18n/locales/en.ts` — approval
  summary keys
- `app/i18n/locales/en.ts` — credentials form keys (if any)

NO frontend component changes are needed for the standard flow. The
`AddConnectionModal`, `ConnectionCard`, `EditConnectionOptionsModal`, and
the dynamic forms are all descriptor-driven — adding a provider should
not touch any `.vue` file.

## 16. Common mistakes (and how to avoid them)

- **Forgetting `categories`** → manifest validation throws at boot.
- **Forgetting `connectionOptions` on a communication provider** →
  passes validation but the agent has no `persona` signal in the system
  prompt, so the SKILL persona rules become unconditional. Always declare
  the `persona` option for any `categories.includes("communication")`
  manifest.
- **Duplicating persona/voice rules in `guidance.md`** → the generator
  injects them automatically for `communication` providers. Adding them
  manually creates two slightly-different copies; the agent gets
  confused. Strip them from `guidance.md` and let the generator do it.
- **Adding a transport-specific check inside `guidance.md`** that should
  be in the system prompt → if the rule fires BEFORE the agent reads the
  SKILL, it belongs upstream. Disambiguation, channel picking, "ask
  before sending" type rules are all upstream.
- **Forgetting to regen the SDK** → manifest changes do nothing at
  runtime until `gen:sdk` rewrites the Python wrapper and SKILL. CI
  catches this — but rerun locally and commit the result.
- **Writing tool-aware prose in `guidance.md`** ("call this then call
  that…") instead of leveraging the action catalogue at the top of the
  SKILL.md → trust the catalogue; the agent reads it.
- **Returning unstructured strings from a `read` action** → always
  return typed objects (`types: { Foo: { ... } }` + `returns: { ref:
"Foo" }` or `{ list: "Foo" }`). The SKILL's "Data models" section is
  the agent's lookup table.

## 17. Provider-agnostic invariants the agent assumes

These hold regardless of the provider — do not break them in a
provider-specific way:

- Every action accepts an implicit `connection_id="<uuid>"` arg
  (injected by the generated SDK). Custom mappers/handlers must look
  for it in `args` and select the right connection.
- Every write action ends up in `run_plan([...])`, built with `.op(...)`.
  Calling the generated write function directly raises — one spelling only,
  so an agent cannot submit a one-op plan by accident mid-expression. Never
  bypass the plan path in a handler.
- The system prompt's `<external_apps>` block handles disambiguation
  ACROSS providers. Per-provider `guidance.md` only handles SAME-provider
  disambiguation (multiple Outlook mailboxes), and even then by
  referencing the system prompt rather than restating it.
