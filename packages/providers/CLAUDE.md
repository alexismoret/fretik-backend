# @fretik/providers

External-app providers (Outlook, IMAP/SMTP, future OpenAPI / SDK-based providers). Each provider declares a manifest, optional handlers/mappers, summaries, and an i18n-aware guidance.md.

## Positioning

This package owns **everything provider-specific**: manifests, request/response mappers (for `nango-proxy` transport), action handlers (for `custom-handler` transport), approval-card summaries, protocol libs (e.g. `imap-smtp/client.ts`), guidance markdown.

The **registry contract** (manifest schema, provider-types, registry indexing) lives in `@fretik/shared/external-apps/`. This package consumes that contract — it does not own it.

`@fretik/shared`, `@fretik/api`, and `@fretik/ai` **never import a provider directly**. They go through the registry. The only thing that imports `@fretik/providers` is the application entrypoint (`@fretik/api/src/index.ts`, `@fretik/ai/src/index.ts`), which triggers registration side-effects.

## Transport kinds

A provider declares one of two transports in its manifest:

- **`nango-proxy`** — actions are HTTP REST calls executed through `nango.proxy(...)`. Provider exposes `mappers.ts` (request/response transformers). Example: `outlook`.
- **`custom-handler`** — actions are arbitrary TypeScript functions. Provider exposes `handlers.ts` (`(args, { credentials, connection_config }) => Promise<unknown>`). Used when the protocol isn't HTTP (IMAP/SMTP), or when the provider isn't on Nango (private OpenAPI / SDK-only).

For `custom-handler` providers, credentials are fetched from Nango via `nango.getConnection(providerConfigKey, connectionId)` at dispatch time — Nango remains the single source of truth for credential storage.

## Adding a new provider

**Full procedure with checklist, category mapping, agent-prose rules, persona handling for communication providers, smoke-test plan, and common mistakes: `ADDING_A_PROVIDER.md` in this package.** Read it before you start — it covers the cases the quick list below glosses over.

Quick summary:

1. Create `src/<key>/` with at least `manifest.ts` + `index.ts` (exporting a `ProviderEntry`).
2. For `nango-proxy`: add `mappers.ts` (request + response transformers).
3. For `custom-handler`: add `handlers.ts` (one function per action) + `test-connection.ts` (validates user credentials).
4. Add `summaries.ts` if the provider has write actions (one summary builder per write action — required by the registry).
5. Add `guidance.md` — instructions the chatbot sees once it touches this provider. **Follows `.agent/agent-facing-prose.md` and explicitly does NOT duplicate the persona/voice section (which the generator injects automatically for `categories.includes("communication")`).**
6. Register the provider in `src/index.ts` via `setProviders({...})`.
7. Run `bun run gen:sdk` to regenerate the Python SDK + SKILL.md committed under `@fretik/ai/sandbox-assets/`.
8. Configure the corresponding Nango integration in the self-hosted dashboard (unique key must match `nangoProviderConfigKey` of the manifest).

## Conventions

- **No business logic outside the provider folder.** A provider folder is self-contained: manifest, handlers/mappers, summaries, guidance, client lib if needed.
- **Bun-compatible deps only.** Most npm packages work; verify on boot. Native bindings are best avoided.
- **Heavy deps stay in this package.** `imapflow`, `nodemailer`, future SDKs — never in `@fretik/shared`, `@fretik/api`, or `@fretik/ai`.
- **Action signatures (`params`, `returns`) are protocol-agnostic.** They drive the generated Python SDK regardless of whether the transport is `nango-proxy` or `custom-handler`. Same agent UX across providers.
- **`credentialsForm` descriptor** (custom-handler only) declares the fields the user fills in our own UI. The frontend renders it dynamically via `DynamicCredentialsForm.vue`. Adding a new credential field = no frontend change.

## Gotchas

- **Registration is side-effect on import.** `import "@fretik/providers";` calls `setProviders(...)` at module top-level. Make sure consuming apps import this exactly once, at boot, before any registry lookup.
- **`gen:sdk` writes outside this package** — into `@fretik/ai/sandbox-assets/{fretik_apps,skills}/...`. The generated files are committed (reproducibility, CI diff check).
- **For `custom-handler` providers with `testConnection.supported: true`**, the registry requires a `testCredentials` function on the provider entry. Omitting it = validation error at boot.
- **`guidance.md` is appended verbatim to the generated `SKILL.md`** the chatbot reads — keep it agent-facing only. Operator-facing setup (e.g. how to create a Nango integration in the dashboard) belongs in a `src/<provider>/SETUP.md` colocated with the provider's code.
