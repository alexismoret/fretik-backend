# @fretik/ai

Hono LLM service: chatbot (SSE resumable), vectorize, pre-extract, chat-files. The chatbot agent is a **singleton** built once at boot and reused across every request.

## Conventions

- **Tools: read `src/tools/README.md` first.** The tool convention (one file per tool, `tool()` factory, `getRuntimeContext(options)` inside `execute`, structured `{ error, code }` returns) is non-negotiable and fully documented there.
- **NEVER close over `ctx` at construction.** The agent is a singleton. Per-request state (`organizationId`, `conversationId`, `dynamicToolManager`, `taskManager`) is read via `getRuntimeContext(options)` inside `execute`. A closure leak silently crosses requests.
- **Mutations on `AgentRuntimeContext` must be idempotent + commutative.** Parallel tool calls can race. `dynamicToolManager.activate(names)` and `taskManager.setTasks(tasks)` already are. Any new mutable field must be too — or move state to Redis keyed by `conversationId`.
- **`prepareStep` returns explicit `{ activeTools }` every step.** Progressive Disclosure depends on recomputing the list each turn; omitting it falls back to the initial tool set and the model stops seeing newly activated tools.
- **OpenRouter models need `provider: { require_parameters: true }`.** Without it, providers that don't support `tools` silently drop the parameter and the model emits XML-looking plaintext through SSE, breaking stream parsing. Load-bearing — do not remove.
- **Two auth layers.** User-facing routes use the Better Auth cookie. Internal routes (`/internal/*`, called by API/worker) require `X-Internal-Key` + `X-Context-{Team,Organization,User,Timezone}-Id` headers via `middlewares/internal.ts`. Never mix them.
- **`E2B_API_KEY` required for the chatbot.** The `python` / `bash` tools call `@fretik/shared/services/e2b/*` which fails fast at boot if the env var is missing in production. Never log the key.
- **Bun native I/O only.** `Bun.file` / `Bun.write` / `Bun.spawn` — never `node:fs` or `child_process`. This is enforced across the codebase.

## Pattern reference

- New chatbot tool → mirror `src/tools/sql-query.ts` (factory + `getRuntimeContext` + structured error return + optional `maybePersistLargeOutput` for big results).
- New HTTP endpoint → mirror `src/handlers/chatbot.ts` (middleware + fallback model try/catch + SSE resumable buffering).
- Sandbox-backed tool → mirror `src/tools/python.ts` and `src/tools/bash.ts`. Code execution is delegated to E2B via `@fretik/shared/services/e2b/run-in-sandbox` (`acquireSandbox` lazily resumes a per-conversation sandbox; `releaseSandbox` is called from the chatbot handler's `onFinish` to pause it). The conversation→sandbox mapping lives in Redis (`e2b:sandbox:{conversationId}`); no DB column. Egress is restricted by `services/e2b/network-policy.ts` (Fretik / PyPI / GitHub / carrier APIs only). The Python kernel is stateful for the lifetime of a conversation — context is cached in Redis (`e2b:python-ctx:{conversationId}`) and reused across `runCode` calls. Two restart granularities: `python` tool's `restart: true` → `restartPythonKernel` (kernel-only, preserves filesystem); `bash` tool's `restart: true` → `runInSandbox({ restart: true })` → `killSandbox` (nukes the whole sandbox including `/workspace`). Rich Jupyter outputs (DataFrame HTML, matplotlib plots) are captured into `RunResult.richResults` and binary representations are written under `outputs/results/{toolCallId}-{idx}.{ext}`.

## Gotchas

- Tool errors must be returned as `{ error, code }` objects, not thrown. A thrown error hides the failure from the model and surfaces as a 500 on the client. Throw only for unexpected bugs.
- Large tool outputs (>30k chars) need `maybePersistLargeOutput()` — it writes the result to a temp file and returns a `<persisted-output>` marker. Without it, the stream truncates and the model sees garbage.
- File parts in messages must be stripped (`stripFilePartsForModel()`) before `convertToModelMessages()`. The model reaches files only through the `read`/`vision` tools — it never sees raw bytes or URLs.
- Resumable streams spin up two ioredis connections per context. Use `maxRetriesPerRequest: null` or the subscriber gets stuck after the first failure.
