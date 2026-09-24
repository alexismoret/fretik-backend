import "@hono/zod-openapi";
import { describe, expect, test } from "bun:test";

import { mockModule } from "../lib/mock-module";
import type { Probeable } from "../lib/mounted-routers";

/**
 * Every route says who may call it (`@fretik/shared/authz/http`).
 *
 * The session wall (`auth-boundary.test.ts`) proves a router demands a
 * signed-in caller; it cannot tell whether a route then checks that THIS
 * caller may touch THIS resource — which is where every access bug of the
 * audit lived (a record read by id, a folder deleted across teams). This test
 * closes that gap structurally: a route whose chain holds no `access.*` rule
 * fails here, so a new endpoint cannot ship without saying — and enforcing —
 * who it is for.
 *
 * It reads Hono's route table, where every handler of a route is its own
 * entry (middlewares, validators, the handler), so a rule placed anywhere in
 * the chain counts, whether the route is declared through `createRoute` or as
 * a plain `get`/`post`.
 */

await mockModule("@fretik/shared/lib/auth", {
  auth: {
    api: {
      getSession: (): Promise<null> => Promise.resolve(null),
    },
  },
});

const { MOUNTED_ROUTERS } = await import("../lib/mounted-routers");
const { accessRuleOf } = await import("@fretik/shared/authz/http");

/** The routers that are public by design (see `auth-boundary.test.ts`). */
const PUBLIC_ROUTERS = new Set([
  "/invitations",
  "/forms",
  "/p",
  "/desktop-releases",
  "/sandbox",
  "/webhooks",
]);

type Rule = NonNullable<ReturnType<typeof accessRuleOf>>;

/** Each route of a router, with the rules found in its chain. */
const routesOf = (router: Probeable): Map<string, Rule[]> => {
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
  return routes;
};

const everyRoute = (): { mount: string; route: string; rules: Rule[] }[] =>
  Object.entries(MOUNTED_ROUTERS).flatMap(([mount, router]) =>
    [...routesOf(router)].map(([route, rules]) => ({ mount, route, rules })),
  );

describe("route access rules", () => {
  test("every route declares exactly one rule", () => {
    const wrong = everyRoute()
      .filter(({ rules }) => rules.length !== 1)
      .map(({ mount, route, rules }) => `${mount} ${route} (${rules.length})`);
    expect(wrong).toEqual([]);
  });

  test("no route of this service is internal: the API serves browsers only", () => {
    const internal = everyRoute()
      .filter(({ rules }) => rules.some((rule) => rule.kind === "internal"))
      .map(({ mount, route }) => `${mount} ${route}`);
    expect(internal).toEqual([]);
  });

  test("a public rule appears only on the routers that are public by design", () => {
    const misplaced = everyRoute()
      .filter(
        ({ mount, rules }) =>
          rules.some((rule) => rule.kind === "public") !==
          PUBLIC_ROUTERS.has(mount),
      )
      .map(({ mount, route }) => `${mount} ${route}`);
    expect(misplaced).toEqual([]);
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
    // A control: if the route table came back empty (a doubled module gone
    // wrong), every assertion above would pass while proving nothing.
    expect(everyRoute().length).toBeGreaterThan(150);
  });
});
