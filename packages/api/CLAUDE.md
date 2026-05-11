# @fretik/api

Hono HTTP REST API with OpenAPI. Thin wrappers around `@fretik/shared` services — no business logic lives here.

## Conventions

- **One `OpenAPIHono<HonoLoggedAppType>` instance per handler file.** Define routes, apply middlewares locally, export. Mount in `src/index.ts` via `app.route('/path', routes)`. Do NOT share a single global Hono instance.
- **Every route validates with Zod via `createRoute()`.** No route without a schema. The OpenAPI signature must match the actual handler signature exactly — TS will complain otherwise.
- **Business logic belongs in `@fretik/shared/services/*`.** Handlers fetch inputs, call a service, format the response. If you find yourself writing branching logic or DB queries in a handler, stop and move it to shared.
- **Error envelope is `{ code: 'ERROR_CODE', message?: string }`.** Use `throwHttpError()` — it returns `never`, which lets TS narrow types after the call.
- **Long-running ops stream via `streamSSE` + Redis pub/sub.** Don't hold HTTP connections open without backpressure; don't invent alternative streaming formats.

## Pattern reference

Mirror `src/handlers/documents.ts` — handler instance + `authMiddleware` + `createRoute()` with Zod + service call + SSE where needed.

## Gotchas

- Credentials must be encrypted/decrypted via the `@fretik/shared/lib` helpers — never store or return them in plaintext from an endpoint.
- Routes mounted under `/auth/*` are owned by Better Auth — don't add routes that conflict (consult MCP `better-auth` before touching anything auth-shaped).
- Response types inferred from the Zod schema, not the returned object. If they diverge silently, TS won't catch it — always assert with `c.json({...})` directly matching the schema.
- The legacy `api/` directory at the repo root is being migrated from. Do not add new code there.
