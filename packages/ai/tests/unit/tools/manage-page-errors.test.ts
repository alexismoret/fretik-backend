import { badRequest, notFound } from "@fretik/shared/lib/errors";
import "@hono/zod-openapi";
import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { TOOL_ERROR_CODES } from "../../../src/lib/tool-error-codes";
import {
  createManagePageTool,
  liftPageError,
} from "../../../src/tools/manage-page";

// `schemas/pages` reaches `common/params`, which calls `.openapi()` — a method
// that exists only once `@hono/zod-openapi` has patched Zod. A service gets
// that at boot; here the import has to resolve AFTER the patch above, and the
// formatter sorts `@fretik/*` before `@hono/*` — so this one stays dynamic.
const { pagePublishError } = await import("@fretik/shared/schemas/pages");

/**
 * What the agent READS when a page service refuses.
 *
 * Before this translation existed, every one of these reached the model as
 * `guardToolExecute`'s generic "unexpected internal error. Retry once" — which
 * told it to repeat the exact call that could not succeed, and threw away the
 * publish gate's messages, the most actionable strings in the feature.
 *
 * Two invariants are load-bearing and tested here rather than assumed:
 * the gate's own wording travels VERBATIM, and anything unrecognised returns
 * null so the caller rethrows into the backstop.
 */

const httpError = (status: 400 | 404 | 500, body: object): HTTPException =>
  new HTTPException(status, { message: JSON.stringify(body) });

describe("liftPageError — 404", () => {
  test("names the page that was not found and the call that finds it", () => {
    const lifted = liftPageError(httpError(404, notFound("Page")), {
      action: "update",
      pageId: "page-42",
    });

    expect(lifted?.code).toBe(TOOL_ERROR_CODES.NOT_FOUND);
    expect(lifted?.error).toContain("page-42");
    expect(lifted?.hint).toContain('{ action: "list" }');
    expect(lifted?.hint).toContain("update");
  });

  test("is NOT an input-shape code — no argument fixes a missing page", () => {
    const lifted = liftPageError(httpError(404, notFound("Page")), {
      action: "get",
      pageId: "page-42",
    });
    // The loop guard steers INVALID_ARGS with "retry the SAME call using the
    // shape from the hint", which is precisely wrong here.
    expect(lifted?.code).not.toBe(TOOL_ERROR_CODES.INVALID_ARGS);
  });

  test("survives a pageId the caller never supplied", () => {
    const lifted = liftPageError(httpError(404, notFound("Page")), {
      action: "get",
    });
    expect(lifted?.code).toBe(TOOL_ERROR_CODES.NOT_FOUND);
    expect(lifted?.error).not.toContain("undefined");
  });
});

describe("liftPageError — the publish gate", () => {
  test("carries the gate's own message through, word for word", () => {
    // The real message, produced by the real gate: an operation on a page
    // someone is trying to expose anonymously.
    const blocker = pagePublishError({
      version: 3,
      variables: [],
      datasets: [],
      operations: [{ id: "send_update", action: "send_message" }],
      code: {
        source: "<template><div>x</div></template>",
        compiled: {
          js: "export default {}",
          css: "",
          runtimeVersion: "v1",
          sourceHash: "a".repeat(64),
          compiledAt: "2026-08-14T00:00:00.000Z",
        },
      },
    });
    expect(blocker).not.toBeNull();

    const lifted = liftPageError(httpError(400, badRequest(blocker ?? "")), {
      action: "publish",
      pageId: "page-42",
    });

    expect(lifted?.code).toBe(TOOL_ERROR_CODES.PAGE_NOT_PUBLISHABLE);
    expect(lifted?.error).toBe(blocker);
    // It names the offending operation — that is the whole value of passing it
    // through instead of substituting a generic sentence.
    expect(lifted?.error).toContain('"send_update"');
    expect(lifted?.hint).toContain("update the page");
  });

  test("points at editing the page, never at re-sending publish", () => {
    const lifted = liftPageError(
      httpError(
        400,
        badRequest(
          "The page has never compiled successfully — save it (create/update) until compile errors are gone, then publish.",
        ),
      ),
      { action: "publish", pageId: "page-42" },
    );
    expect(lifted?.error).toContain("never compiled");
    expect(lifted?.hint).toContain("update the page");
  });
});

describe("liftPageError — the compile refusal", () => {
  test("travels VERBATIM as INVALID_ARGS — the error list IS the fix list", () => {
    const message = [
      "Page code failed to compile — nothing was saved. Fix the source and resend it:",
      "- [script] Unexpected token (line 12)",
    ].join("\n");
    const lifted = liftPageError(httpError(400, badRequest(message)), {
      action: "update",
      pageId: "page-42",
    });
    expect(lifted?.code).toBe(TOOL_ERROR_CODES.INVALID_ARGS);
    expect(lifted?.error).toBe(message);
    expect(lifted?.hint).toContain("Nothing was saved");
  });
});

describe("liftPageError — ownership", () => {
  test("a scope refusal is FORBIDDEN and states the only two legal scopes", () => {
    const lifted = liftPageError(
      httpError(
        400,
        badRequest(
          "page.userId can only be null (team-shared) or your own id (private to you) — a page can't be scoped to another user.",
        ),
      ),
      { action: "update", pageId: "page-42" },
    );

    expect(lifted?.code).toBe(TOOL_ERROR_CODES.FORBIDDEN);
    expect(lifted?.error).toContain("team-shared");
    expect(lifted?.hint).toContain('scope: "team"');
  });
});

describe("liftPageError — what it deliberately does NOT translate", () => {
  test("a 500 is left to the backstop", () => {
    expect(
      liftPageError(httpError(500, { code: "INTERNAL", message: "boom" }), {
        action: "create",
      }),
    ).toBeNull();
  });

  test("a plain Error is left to the backstop", () => {
    expect(
      liftPageError(new Error("undefined is not a function"), {
        action: "create",
      }),
    ).toBeNull();
  });

  test("a non-Error throw is left to the backstop", () => {
    expect(liftPageError("nope", { action: "create" })).toBeNull();
  });

  test("an unparseable body still yields an actionable envelope", () => {
    const lifted = liftPageError(
      new HTTPException(400, { message: "not json at all" }),
      { action: "publish", pageId: "page-42" },
    );
    expect(lifted?.code).toBe(TOOL_ERROR_CODES.PAGE_NOT_PUBLISHABLE);
    expect(lifted?.error.length).toBeGreaterThan(0);
    expect(lifted?.hint).toBeDefined();
  });
});

/**
 * A nested argument that arrived JSON-ENCODED.
 *
 * A page definition is the deepest thing this agent ever sends, and stringifying
 * it is the classic weak-model slip — observed on deepseek-v4-flash, whose own
 * next-step reasoning read "je corrige le format (objet au lieu de chaîne)". It
 * cost a discarded step plus a repair-model call to recover an argument nothing
 * was missing from.
 *
 * Asserted through the tool's REAL input schema, caption and all, because that
 * is the object the model actually sends; a test over a hand-built preprocess
 * would prove nothing about the call.
 */
describe("managePage accepts a stringified definition", () => {
  const inputSchema = (): z.ZodType => {
    // The authoring instance: `dry_run` and `definition` are the builder's
    // surface, and the builder is the model that sends the deep argument.
    const schema: unknown = createManagePageTool({
      authoring: true,
    }).inputSchema;
    if (!(schema instanceof z.ZodType)) {
      throw new Error("managePage has no Zod input schema");
    }
    return schema;
  };

  const definition = {
    variables: [],
    datasets: [],
    code: { source: "<template><h1>Q3</h1></template>" },
  };

  const call = (value: unknown) =>
    inputSchema().safeParse({
      caption: "Testing the page",
      action: "dry_run",
      definition: value,
    });

  test("the encoded form parses to the same definition as the object", () => {
    const encoded = call(JSON.stringify(definition));
    const direct = call(definition);
    expect(encoded.success).toBe(true);
    expect(direct.success).toBe(true);
    expect(encoded.data).toEqual(direct.data);
  });

  test("a string that is not JSON is still refused", () => {
    // And refused by the DEFINITION schema, which says what a definition is —
    // not by a JSON parser complaining about a field the model does not know
    // it sent as text.
    expect(call("the Q3 pipeline page").success).toBe(false);
  });
});

/**
 * The authoring split, pinned on the two surfaces a model can actually reach.
 *
 * This is a capability boundary, not advice, and it exists because advice lost:
 * measured 2026-08-21, a parent holding `buildPage` and a description that said
 * "building one is buildPage's job, not yours" read 91k characters of the build
 * corpus and authored the page itself, on the wrong model, without the browser
 * pass. So the assertion is about what the JSON schema OFFERS, not about what a
 * sentence asks for.
 */
describe("managePage authoring is a capability, not an instruction", () => {
  const actionValues = (authoring: boolean): string[] => {
    const schema: unknown = createManagePageTool({ authoring }).inputSchema;
    if (!(schema instanceof z.ZodObject)) {
      throw new Error("managePage has no Zod object input schema");
    }
    const action: unknown = schema.shape.action;
    if (!(action instanceof z.ZodEnum)) {
      throw new Error("managePage action is not a Zod enum");
    }
    return Object.values(action.enum).map(String);
  };

  test("the parent's instance offers no action that authors a page", () => {
    const actions = actionValues(false);
    for (const authoring of ["create", "dry_run", "get_guide", "components"]) {
      expect(actions).not.toContain(authoring);
    }
    // …while everything you do to a page that already exists stays.
    for (const kept of ["get", "list", "update", "review", "publish"]) {
      expect(actions).toContain(kept);
    }
  });

  test("the builder's instance keeps all of them", () => {
    const actions = actionValues(true);
    for (const authoring of ["create", "dry_run", "get_guide", "components"]) {
      expect(actions).toContain(authoring);
    }
  });

  /**
   * The prose half, and it is the half that actually failed. The old
   * description opened with "not yours" and then taught `get_guide`, the
   * component API, `dry_run`, `create` and the review loop — a manual with a
   * disclaimer reads as permission. So the parent's text must not name an
   * action it does not have, and must not describe the whole-`definition`
   * write that `update`'s guard refuses.
   *
   * (The guard itself is not exercised here: reaching `execute` needs a fully
   * branded runtime context including a real `ModelProfile`. The enum above is
   * the boundary the model meets; the guard is depth behind it.)
   */
  test("the parent's description teaches nothing it cannot do", () => {
    const description = createManagePageTool({ authoring: false }).description;
    if (typeof description !== "string") {
      throw new Error("managePage has no string description");
    }
    for (const absent of ["get_guide", "dry_run", "`definition`"]) {
      expect(description).not.toContain(absent);
    }
    // And it names where the work goes instead, which is the whole point.
    expect(description).toContain("buildPage");
    expect(description).toContain("edits");
  });
});

/**
 * The rewrite door, pinned on the schema.
 *
 * Same logic as the authoring split above and the same reason: advice lost.
 * Measured across one real session (2026-08-22), the builder answered five
 * consecutive `update` calls with a whole-file `definition` — 10-14k output
 * tokens each — against a prompt that asked for `edits`, and the last of them
 * kept 370 of the previous 1272 lines while repairing three named bugs. A flag
 * the model must pass turns a rewrite into a decision; prose did not.
 */
describe("managePage — the rewrite flag", () => {
  const shapeOf = (authoring: boolean): Record<string, unknown> => {
    const schema: unknown = createManagePageTool({ authoring }).inputSchema;
    if (!(schema instanceof z.ZodObject)) {
      throw new Error("managePage has no Zod collection schema");
    }
    return schema.shape;
  };

  test("the builder can ask for a rewrite", () => {
    expect(Object.keys(shapeOf(true))).toContain("rewrite");
  });

  test("the editing instance is never offered one", () => {
    // It cannot send a `definition` at all, so a flag governing how definitions
    // are applied would be a parameter naming a capability it does not have.
    expect(Object.keys(shapeOf(false))).not.toContain("rewrite");
  });

  test("edits stay available to both", () => {
    for (const authoring of [true, false]) {
      expect(Object.keys(shapeOf(authoring))).toContain("edits");
    }
  });
});
