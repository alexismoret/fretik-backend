# @fretik/api

Hono HTTP REST API with OpenAPI. Thin wrappers around `@fretik/shared` services — no business logic lives here.

## Positioning

Fretik is a **generic B2B AI workspace** (see root `CLAUDE.md`). Keep handlers, OpenAPI descriptions, and error messages industry-agnostic. Industry specialisation lives in `@fretik/shared/templates/document-fields/` — never in route descriptions or handler logic.

## Conventions

- **One `OpenAPIHono<HonoLoggedAppType>` instance per handler file.** Define routes, apply middlewares locally, export. Mount in `src/index.ts` via `app.route('/path', routes)`. Do NOT share a single global Hono instance.
- **Every route validates with Zod via `createRoute()`.** No route without a schema. The OpenAPI signature must match the actual handler signature exactly — TS will complain otherwise.
- **Business logic belongs in `@fretik/shared/services/*`.** Handlers fetch inputs, call a service, format the response. If you find yourself writing branching logic or DB queries in a handler, stop and move it to shared.
- **Error envelope is `{ code: 'ERROR_CODE', message?: string }`.** Use `throwHttpError()` — it returns `never`, which lets TS narrow types after the call.
- **Long-running ops stream via `streamSSE` + Redis pub/sub.** Don't hold HTTP connections open without backpressure; don't invent alternative streaming formats.
- **Tests: read `backend/docs/OPERATIONS.md` §7 first.** This package has unit tests only — its handlers are thin, so what is worth asserting is the SESSION BOUNDARY, and `tests/unit/auth-boundary.test.ts` is the pattern: it probes the routers actually mounted in `src/index.ts` and lists the 5 public ones explicitly. It replaced a `health.test.ts` that re-implemented the route inside the test and then checked it returned what the test had just told it to — **a test that builds its own subject measures nothing.** Business logic being in `@fretik/shared` means its tests belong there too.

## Pattern reference

Mirror `src/handlers/documents.ts` — handler instance + `authMiddleware` + `createRoute()` with Zod + service call + SSE where needed.

## Gotchas

- Credentials must be encrypted/decrypted via the `@fretik/shared/lib` helpers — never store or return them in plaintext from an endpoint.
- Routes mounted under `/auth/*` are owned by Better Auth — don't add routes that conflict (consult MCP `better-auth` before touching anything auth-shaped).
- Response types inferred from the Zod schema, not the returned object. If they diverge silently, TS won't catch it — always assert with `c.json({...})` directly matching the schema.
- The legacy `api/` directory at the repo root is being migrated from. Do not add new code there.
