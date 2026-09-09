import { afterEach, describe, expect, test } from "bun:test";
import { pbypEntry, pbypManifest } from "../../src/pbyp";
import { pbypDynamicOptions } from "../../src/pbyp/dynamic-options";
import { pbypOnConnected } from "../../src/pbyp/on-connected";
import { testPbypCredentials } from "../../src/pbyp/test-connection";

/**
 * The three calls a Pbyp connection makes before it is usable, and the one
 * failure that would otherwise be invisible.
 *
 * A Directus account can hold several profiles, and the effective scope
 * (`directus_users.current_entities`) is written ONLY by
 * `POST /auth-endpoints/profile/:id`. So storing the chosen profile proves
 * nothing: without `onConnected` actually calling that route, the
 * connection answers under whichever profile the person last clicked in
 * Pbyp's own UI, with no error anywhere — just other people's data, or
 * none. These tests pin that the call happens, at the right path, and that
 * a profile that is not the account's is refused before the connection is
 * stored rather than 404-ing on the first action days later.
 */

const realFetch = globalThis.fetch;

interface Call {
  url: string;
  method: string;
}

const calls: Call[] = [];

/** Route by path; a `null` body answers 403, `undefined` 404. */
const serve = (routes: Record<string, unknown>): void => {
  const stub = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, method: init?.method ?? "GET" });

    const match = Object.entries(routes).find(([path]) => url.includes(path));
    if (match === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    const [, body] = match;
    if (body === null) {
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    }
    return Promise.resolve(Response.json({ data: body }));
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: realFetch.preconnect.bind(realFetch),
  });
};

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

/**
 * Explicit try/catch, not `.rejects.toThrow()` — Bun types that matcher as
 * returning `void`, so awaiting it trips `await-thenable` and NOT awaiting
 * it lets a rejection escape the test. Same reason as
 * `shared/tests/unit/external-connection-slot.test.ts`.
 */
const expectRejection = async (
  run: () => Promise<unknown>,
  pattern?: RegExp,
): Promise<void> => {
  try {
    await run();
  } catch (error) {
    if (pattern !== undefined) {
      expect(error instanceof Error ? error.message : String(error)).toMatch(
        pattern,
      );
    }
    return;
  }
  throw new Error("expected a rejection, got a resolved promise");
};

const ME = { id: "u-1", email: "ops@example.com", current_entities: [3] };

describe("the profile selector", () => {
  test("lists the account's own profiles, labelled entity then role", async () => {
    serve({
      "/users/me": ME,
      "/items/profiles": [
        {
          id: 11,
          entity_id: { id: 3, name: "Fatton Nantes", is_client: false },
          role_id: { name: "Exploitation" },
        },
        {
          id: 12,
          entity_id: { id: 39, name: "Fibertex", is_client: true },
          role_id: { name: "Client" },
        },
      ],
    });

    const result = await pbypDynamicOptions.listProfiles?.({
      credentials: { api_key: "k" },
      connection_config: {},
    });

    expect(result?.options.map((o) => o.value)).toEqual(["11", "12"]);
    // The label is what the modal turns into the connection's display name,
    // so it has to name the entity — it is the only thing telling two Pbyp
    // connections on one account apart.
    expect(result?.options.map((o) => o.label)).toEqual([
      "Fatton Nantes — Exploitation",
      "Fibertex — Client",
    ]);
    // The list is scoped to the caller — never every profile in the tenant.
    expect(calls.some((c) => c.url.includes("filter[user_id][_eq]=u-1"))).toBe(
      true,
    );
  });

  test("no option carries `meta` — the provider declares no connectionOptions", () => {
    // A `meta` payload is projected into `connectionOptions` fields; with
    // none declared it would be silently dropped, and it existed only to
    // feed two editable fields nobody could answer.
    expect(pbypManifest.connectionOptions).toBeUndefined();
  });

  test("an account with no profile is told what is missing", async () => {
    serve({ "/users/me": ME, "/items/profiles": [] });
    await expectRejection(
      async () =>
        pbypDynamicOptions.listProfiles?.({
          credentials: { api_key: "k" },
          connection_config: {},
        }),
      /no profile/,
    );
  });

  test("a refused key names the page that issues a new one", async () => {
    serve({ "/users/me": null });
    await expectRejection(
      async () =>
        pbypDynamicOptions.listProfiles?.({
          credentials: { api_key: "k" },
          connection_config: {},
        }),
      /Profile management/,
    );
  });
});

describe("the credentials test", () => {
  test("passes when the key works and the profile is the account's", async () => {
    serve({ "/users/me": ME, "/items/profiles": [{ id: 11 }] });
    expect(
      await testPbypCredentials({
        credentials: { api_key: "k" },
        connection_config: { profile_id: 11 },
      }),
    ).toEqual({ ok: true });
  });

  test("a bad key is reported as an auth problem, not an outage", async () => {
    serve({ "/users/me": null });
    expect(
      await testPbypCredentials({
        credentials: { api_key: "k" },
        connection_config: { profile_id: 11 },
      }),
    ).toMatchObject({ ok: false, scope: "auth" });
  });

  test("a profile the account no longer holds is caught here, not on the first action", async () => {
    serve({ "/users/me": ME, "/items/profiles": [] });
    expect(
      await testPbypCredentials({
        credentials: { api_key: "k" },
        connection_config: { profile_id: 99 },
      }),
    ).toMatchObject({ ok: false, scope: "profile" });
  });

  test("an account with no scope is named as such — every read would be empty", async () => {
    serve({
      "/users/me": {
        id: "u-1",
        current_entities: [],
        current_profile_id: null,
      },
      "/items/profiles": [{ id: 11 }],
    });
    expect(
      await testPbypCredentials({
        credentials: { api_key: "k" },
        connection_config: { profile_id: 11 },
      }),
    ).toMatchObject({ ok: false, scope: "scope" });
  });
});

describe("activating the profile", () => {
  test("posts to the one route that writes current_entities", async () => {
    serve({ "/auth-endpoints/profile/": { id: 11 } });
    await pbypOnConnected({
      credentials: { api_key: "k" },
      connection_config: { profile_id: 11 },
      options: null,
    });
    expect(calls).toEqual([
      {
        url: "https://directus.preprod.pbyp.fr/auth-endpoints/profile/11",
        method: "POST",
      },
    ]);
  });

  test("a string profile id from the form still activates", async () => {
    serve({ "/auth-endpoints/profile/": { id: 11 } });
    await pbypOnConnected({
      credentials: { api_key: "k" },
      connection_config: { profile_id: "11" },
      options: null,
    });
    expect(calls[0]?.url).toEndWith("/auth-endpoints/profile/11");
  });

  test("a refusal throws, so the connection is stored in error", async () => {
    serve({ "/auth-endpoints/profile/": null });
    await expectRejection(async () =>
      pbypOnConnected({
        credentials: { api_key: "k" },
        connection_config: { profile_id: 11 },
        options: null,
      }),
    );
  });

  test("no profile at all is refused before any call", async () => {
    serve({});
    await expectRejection(
      async () =>
        pbypOnConnected({
          credentials: { api_key: "k" },
          connection_config: {},
          options: null,
        }),
      /profile/,
    );
    expect(calls).toEqual([]);
  });

  test("the provider entry actually registers the hook", () => {
    // Without this wiring every test above passes and nothing runs in prod.
    expect(pbypEntry.onConnected).toBe(pbypOnConnected);
    expect(pbypEntry.testCredentials).toBe(testPbypCredentials);
  });
});
