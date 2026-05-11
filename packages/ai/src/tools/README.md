# Tools

Every tool file in this directory follows the same convention so that any
agent defined under `src/agents/` can pick it up without boilerplate.

## Shape

```ts
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";

export const createFooTool = () =>
  tool({
    description: "Clear, instructive description the LLM reads.",
    inputSchema: z.object({
      // Describe every arg — the LLM uses these to understand how to call.
      query: z.string().describe("..."),
    }),
    execute: async ({ query }, options) => {
      // Read per-request state from experimental_context. NEVER close over
      // ctx at construction — the ToolLoopAgent is a singleton shared
      // across every request.
      const ctx = getRuntimeContext(options);
      // Access teamId / organizationId / userId via the runtime ctx.
      // Return a serializable object — it's rendered by <UChatTool>.
      return { ok: true };
    },
  });
```

## Rules

1. **One tool per file.** File name matches the feature (`rag-search.ts`,
   `sql-query.ts`, `web-search.ts`). Reusable helpers go in `src/lib/`.
2. **Context comes from `experimental_context`, not from closures.** The
   LLM must never be able to pass `teamId` / `organizationId` / `userId`
   itself — those live on the `AgentRuntimeContext` that `prepareCall`
   attaches to every agent invocation. Tools read it at call time via
   `getRuntimeContext(options)`. Closing over ctx at construction would
   leak per-request state across concurrent requests on the singleton
   agent instance.
3. **Return JSON-serializable data.** Frontend renders tool parts inside
   `<UChatTool>`, and anything non-serializable breaks the stream.
4. **Never throw for expected failures.** Return a structured
   `{ error, code }` object so the agent can see the failure and react.
   Throw only for unexpected bugs — those become 500s on the client.
5. **Keep descriptions actionable.** The description is the primary way
   the LLM decides when to pick this tool. Be specific about when to
   reach for it, what input it expects, and what it returns.
