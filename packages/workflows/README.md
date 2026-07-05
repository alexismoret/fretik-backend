# @fretik/workflows

Durable, long-running, multi-step workflows on **Trigger.dev** (Bun runtime).
Distinct from `@fretik/jobs` (BullMQ short queue jobs) and from any future
external-apps event-`trigger` system.

- Tasks live in `src/tasks/` (`dirs` in `trigger.config.ts`).
- Tasks may import other workspaces (`@fretik/shared`, `@fretik/ai`) via `workspace:*`.
- Deploys to Trigger.dev cloud independently of the Dokploy backend image.

## Remaining setup (human-only, do once)

1. **Log in the CLI** (opens a browser):
   ```bash
   cd backend/packages/workflows && npx trigger.dev@latest login
   ```
2. **Project ref** — paste your `proj_...` (dashboard) into `trigger.config.ts`
   (replaces `"<project ref>"`).
3. **Secret key** — copy the **DEV** `TRIGGER_SECRET_KEY` from the dashboard
   (Project → API Keys) into a local `.env` (see `.env.example`). Only needed to
   trigger tasks from backend code; `trigger dev` itself only needs the login.

## Run

```bash
bun run dev      # trigger dev — registers tasks, hot-reloads, opens dashboard test page
bun run deploy   # trigger deploy — ships tasks to the cloud
```

## Trigger a task from backend code

Type-only import so task code is never bundled into the API/AI services:

```ts
import { tasks } from "@trigger.dev/sdk";
import type { helloWorld } from "@fretik/workflows/src/tasks/example";

await tasks.trigger<typeof helloWorld>("hello-world", { name: "Ada" });
```

Writing tasks: load the `trigger-authoring-tasks` skill. Realtime/frontend:
`trigger-realtime-and-frontend`.
