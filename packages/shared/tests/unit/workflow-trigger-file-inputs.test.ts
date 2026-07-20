import { describe, expect, test } from "bun:test";
import { requiredRunFileInputs } from "../../src/schemas/workflow-triggers";

describe("requiredRunFileInputs", () => {
  test("form trigger returns the keys of required file fields only", () => {
    const keys = requiredRunFileInputs("form", {
      form: {
        title: "Intake",
        visibility: "private",
        fields: [
          { key: "docs", type: "file", label: "Docs", required: true },
          { key: "extra", type: "file", label: "Extra", required: false },
          { key: "note", type: "short_text", label: "Note", required: true },
        ],
      },
    });
    expect(keys).toEqual(["docs"]);
  });

  test("form trigger without file fields requires nothing", () => {
    expect(
      requiredRunFileInputs("form", {
        form: {
          title: "Intake",
          visibility: "private",
          fields: [
            { key: "note", type: "short_text", label: "Note", required: true },
          ],
        },
      }),
    ).toEqual([]);
    expect(requiredRunFileInputs("form", {})).toEqual([]);
  });

  test("non-form triggers require nothing", () => {
    expect(requiredRunFileInputs("manual", {})).toEqual([]);
    expect(
      requiredRunFileInputs("cron", { cron: { pattern: "0 9 * * *" } }),
    ).toEqual([]);
    expect(
      requiredRunFileInputs("event", {
        event: { type: "document.uploaded" },
      }),
    ).toEqual([]);
  });
});
