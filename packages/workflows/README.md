# @fretik/workflows

Durable, long-running, multi-step workflows on **Trigger.dev** (Bun runtime),
**self-hosted at `https://triggerdev.fretik.com`** (not cloud). Distinct from
`@fretik/jobs` (BullMQ short queue jobs) and from any future external-apps
event-`trigger` system.

- Tasks live in `src/tasks/` (`dirs` in `trigger.config.ts`).
- Tasks may import other workspaces (`@fretik/shared`, `@fretik/ai`) via `workspace:*`.
- Deploys to the self-hosted instance independently of the Dokploy backend image.

## Remaining setup (human-only, do once)

1. **Log in the CLI against the self-hosted instance** (opens a browser):
   ```bash
   cd backend/packages/workflows && npx trigger.dev@latest login --api-url https://triggerdev.fretik.com
   ```
   Verify with `npx trigger.dev@latest whoami` — it should show the
   `triggerdev.fretik.com` API URL, not `api.trigger.dev`.
2. **Project ref** — already set in `trigger.config.ts` (`proj_dczsvzhbmtgdsxrxhppx`).
   `trigger.config.ts` has no URL field; the CLI/SDK always resolve the target
   instance from the login profile or the `TRIGGER_API_URL` env var, never from
   this file.
3. **Secret key + API URL** — both already set in `.env` (see `.env.example`).
   **Every other service that calls the SDK (directly, or via
   `@fretik/shared/lib/trigger-client.ts`) needs the same two vars in its own
   env** — `TRIGGER_SECRET_KEY` and `TRIGGER_API_URL=https://triggerdev.fretik.com`.
   Without `TRIGGER_API_URL`, the SDK silently falls back to cloud and rejects
   a self-hosted key.

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
