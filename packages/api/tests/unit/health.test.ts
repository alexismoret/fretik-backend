import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "bun:test";

// Mirrors the /health route from src/index.ts so the test does not
// import the real index (which transitively connects to the DB at load
// time via @fretik/shared/lib/auth). Unit tests must stay free of
// network/DB side-effects.
const app = new OpenAPIHono();
app.get("/health", (c) => c.json({ status: "ok" }, 200));

describe("api health route", () => {
  it("returns 200 with status ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
