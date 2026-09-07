import { describe, expect, it } from "bun:test";
import type { ManifestAction } from "../../src/external-apps/manifest-schema";
import { validateActionArgs } from "../../src/services/external-apps/exec/validate-args";

/**
 * Two silent failures this validator used to cause, both found in
 * production traces against Shiptify:
 *
 *  1. A calendar-day filter declared `datetime` is impossible to satisfy —
 *     the only values the validator accepted were the ones the API
 *     rejected, and vice-versa. `date` is the type for a day.
 *  2. A nested `object` spec used to strip every key it did not declare,
 *     so an attachment `{fileName, documentType, base64Data}` reached the
 *     provider as `{}` — a file upload that answered 2xx and stored
 *     nothing.
 *
 * `qualifiedName` is the schema cache key, so every case uses its own.
 */

const action = (params: ManifestAction["params"]): ManifestAction => ({
  name: "do_thing",
  kind: "write",
  summary: "Do a thing",
  endpoint: { method: "POST", path: "/things" },
  params,
  returns: { ref: "WriteResult" },
});

describe("validateActionArgs — date vs datetime", () => {
  const dateAction = action({
    created_date_from: { type: "date", optional: true },
  });

  it("accepts a calendar day on a `date` param", () => {
    expect(
      validateActionArgs("t.date_ok", dateAction, {
        created_date_from: "2026-05-06",
      }),
    ).toEqual({ created_date_from: "2026-05-06" });
  });

  it("rejects an instant on a `date` param — the API wants a day", () => {
    expect(() =>
      validateActionArgs("t.date_instant", dateAction, {
        created_date_from: "2026-05-06T00:00:00Z",
      }),
    ).toThrow();
  });

  it("still rejects a bare day on a `datetime` param", () => {
    const dt = action({ starts_at: { type: "datetime", optional: true } });
    expect(() =>
      validateActionArgs("t.dt_day", dt, { starts_at: "2026-05-06" }),
    ).toThrow();
    expect(
      validateActionArgs("t.dt_ok", dt, { starts_at: "2026-05-06T09:00:00Z" }),
    ).toEqual({ starts_at: "2026-05-06T09:00:00Z" });
  });
});

describe("validateActionArgs — nested objects keep undeclared keys", () => {
  it("forwards keys a nested `fields` map does not declare", () => {
    const withItems = action({
      attachments: {
        type: "array",
        items: {
          type: "object",
          fields: { fileName: { type: "string" } },
        },
      },
    });

    const parsed = validateActionArgs("t.nested_extra", withItems, {
      attachments: [
        {
          fileName: "POD.pdf",
          documentType: "proof_of_delivery",
          base64Data: "SGk=",
        },
      ],
    });

    expect(parsed.attachments).toEqual([
      {
        fileName: "POD.pdf",
        documentType: "proof_of_delivery",
        base64Data: "SGk=",
      },
    ]);
  });

  it("still validates the keys a nested spec does declare", () => {
    const typed = action({
      stop: {
        type: "object",
        fields: { address_id: { type: "integer" } },
      },
    });

    expect(() =>
      validateActionArgs("t.nested_typed", typed, {
        stop: { address_id: "not-a-number" },
      }),
    ).toThrow();
  });

  it("keeps the top level strict — an unknown action param is still an error", () => {
    const flat = action({ name: { type: "string" } });
    expect(() =>
      validateActionArgs("t.top_strict", flat, { name: "x", nmae: "typo" }),
    ).toThrow();
  });
});
