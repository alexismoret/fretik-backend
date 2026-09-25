import "@hono/zod-openapi";
import { describe, expect, test } from "bun:test";

/**
 * Every route of this service says who may call it
 * (`@fretik/shared/authz/http`), like the API's (`api/tests/unit/
 * route-access.test.ts`, which explains the why). A route whose chain holds no
 * `access.*` rule fails here, so an endpoint cannot ship without saying — and
 * enforcing — who it is for.
 *
 * This service has one kind of caller the API does not: other services of
 * ours, behind the internal key or the signed trigger callback. Their routes
 * carry the `internal` rule, and only theirs.
 *
 * The routers come from the same modules `src/index.ts` mounts; the entry
 * itself is not imported, because it boots the service (the skill catalog,
 * the server).
 */

const [
  { chatFilesRoutes },
  { chatSuggestionsRoutes },
  { chatbotInternalRoutes, chatbotRoutes },
  { decisionRoutes },
  { folderDescriptionRoutes },
  { linkPreviewRoutes },
  { memoryRoutes },
  { modelAdminRoutes },
  { modelProfilesRoutes },
  { preExtractRoutes },
  { vectorizeRoutes },
  { workflowTriggerRoutes },
  { workflowTranscriptRoutes },
  { accessRuleOf },
] = await Promise.all([
  import("../../src/handlers/chat-files"),
  import("../../src/handlers/chat-suggestions"),
  import("../../src/handlers/chatbot"),
  import("../../src/handlers/decisions"),
  import("../../src/handlers/folder-description"),
  import("../../src/handlers/link-preview"),
  import("../../src/handlers/memory"),
  import("../../src/handlers/model-admin"),
  import("../../src/handlers/model-profiles"),
  import("../../src/handlers/pre-extract"),
  import("../../src/handlers/vectorize"),
  import("../../src/handlers/workflow"),
  import("../../src/handlers/workflow-transcript"),
  import("@fretik/shared/authz/http"),
]);

interface RouteTable {
  routes: readonly { method: string; path: string; handler: unknown }[];
}

/** Every router `src/index.ts` mounts, keyed by its mount path. */
const MOUNTED: Record<string, RouteTable> = {
  "/chatbot/suggestions": chatSuggestionsRoutes,
  "/chatbot": chatbotRoutes,
  "/chatbot-files": chatFilesRoutes,
  "/model-profiles": modelProfilesRoutes,
  "/link-preview": linkPreviewRoutes,
  "/model-admin": modelAdminRoutes,
  "/workflow-runs": workflowTranscriptRoutes,
  "/internal/agents/chatbot": chatbotInternalRoutes,
  "/internal/vectorize": vectorizeRoutes,
  "/internal/pre-extract": preExtractRoutes,
  "/internal/decisions": decisionRoutes,
  "/internal/folder-description": folderDescriptionRoutes,
  "/internal/memory": memoryRoutes,
  "/internal/trigger": workflowTriggerRoutes,
};

type Rule = NonNullable<ReturnType<typeof accessRuleOf>>;

const everyRoute = (): { mount: string; route: string; rules: Rule[] }[] =>
  Object.entries(MOUNTED).flatMap(([mount, router]) => {
    const routes = new Map<string, Rule[]>();
    for (const entry of router.routes) {
      // `use("*", …)` middlewares apply to every route; they are not routes.
      if (entry.method === "ALL") continue;
      const key = `${entry.method} ${entry.path}`;
      const rules = routes.get(key) ?? [];
      const rule = accessRuleOf(entry.handler);
      if (rule) rules.push(rule);
      routes.set(key, rules);
    }
    return [...routes].map(([route, rules]) => ({ mount, route, rules }));
  });

describe("route access rules", () => {
  test("every route declares exactly one rule", () => {
    const wrong = everyRoute()
      .filter(({ rules }) => rules.length !== 1)
      .map(({ mount, route, rules }) => `${mount} ${route} (${rules.length})`);
    expect(wrong).toEqual([]);
  });

  test("the internal rule belongs to the internal routers, and they carry nothing else", () => {
    const misplaced = everyRoute()
      .filter(
        ({ mount, rules }) =>
          rules.some((rule) => rule.kind === "internal") !==
          mount.startsWith("/internal/"),
      )
      .map(({ mount, route }) => `${mount} ${route}`);
    expect(misplaced).toEqual([]);
  });

  test("nothing in this service is public", () => {
    const open = everyRoute()
      .filter(({ rules }) => rules.some((rule) => rule.kind === "public"))
      .map(({ mount, route }) => `${mount} ${route}`);
    expect(open).toEqual([]);
  });

  test("the reasons and notes are sentences, not placeholders", () => {
    const vague = everyRoute()
      .flatMap(({ mount, route, rules }) =>
        rules.map((rule) => ({ mount, route, rule })),
      )
      .filter(({ rule }) => {
        const text =
          rule.kind === "session"
            ? rule.note
            : rule.kind === "handler" ||
                rule.kind === "public" ||
                rule.kind === "internal"
              ? rule.reason
              : null;
        return text !== null && text.trim().length < 12;
      })
      .map(({ mount, route }) => `${mount} ${route}`);
    expect(vague).toEqual([]);
  });

  test("the table the checks read is the real one", () => {
    // A control: an empty table would let every assertion above pass.
    expect(everyRoute().length).toBeGreaterThan(40);
  });
});
