import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
  WorkflowFormConfigSchema,
  workflowFormActivationError,
  type WorkflowFormConfig,
} from "../../src/schemas/workflow-forms";
import { validateFormSubmission } from "../../src/services/workflows/validate-form-submission";

/**
 * The form trigger's two authoritative gates: the activation completeness
 * check (a draft may save incomplete, but can't go live) and the server-side
 * submission validator (the browser is never trusted).
 */

const form = (
  fields: z.input<typeof WorkflowFormConfigSchema>["fields"],
): WorkflowFormConfig =>
  WorkflowFormConfigSchema.parse({
    title: "Form",
    fields,
    visibility: "public",
  });

describe("workflowFormActivationError", () => {
  test("rejects an untitled or empty form", () => {
    expect(workflowFormActivationError(form([]))).toContain("field");
    const untitled = WorkflowFormConfigSchema.parse({
      title: "",
      fields: [{ key: "a", type: "short_text", label: "A" }],
      visibility: "public",
    });
    expect(workflowFormActivationError(untitled)).toContain("title");
  });

  test("requires a label on every field and options on choice fields", () => {
    expect(
      workflowFormActivationError(
        form([{ key: "a", type: "short_text", label: "" }]),
      ),
    ).toContain("label");
    expect(
      workflowFormActivationError(
        form([{ key: "c", type: "select", label: "Choice", options: [] }]),
      ),
    ).toContain("option");
  });

  test("passes a complete form", () => {
    expect(
      workflowFormActivationError(
        form([
          { key: "name", type: "short_text", label: "Name" },
          {
            key: "plan",
            type: "select",
            label: "Plan",
            options: [{ value: "pro", label: "Pro" }],
          },
        ]),
      ),
    ).toBeNull();
  });
});

describe("validateFormSubmission", () => {
  const noFiles = new Map<string, File[]>();

  test("flags a missing required field", async () => {
    const result = await validateFormSubmission({
      form: form([
        { key: "name", type: "short_text", label: "Name", required: true },
      ]),
      values: {},
      files: noFiles,
    });
    expect(result.ok).toBe(false);
  });

  test("coerces numbers and rejects out-of-range", async () => {
    const cfg = form([
      { key: "n", type: "number", label: "N", min: 1, max: 10 },
    ]);
    const ok = await validateFormSubmission({
      form: cfg,
      values: { n: "5" },
      files: noFiles,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.payload.n).toBe(5);

    const bad = await validateFormSubmission({
      form: cfg,
      values: { n: 99 },
      files: noFiles,
    });
    expect(bad.ok).toBe(false);
  });

  test("rejects a select value outside its options", async () => {
    const cfg = form([
      {
        key: "plan",
        type: "select",
        label: "Plan",
        options: [{ value: "pro", label: "Pro" }],
      },
    ]);
    expect(
      (
        await validateFormSubmission({
          form: cfg,
          values: { plan: "free" },
          files: noFiles,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await validateFormSubmission({
          form: cfg,
          values: { plan: "pro" },
          files: noFiles,
        })
      ).ok,
    ).toBe(true);
  });

  test("enforces file count + collects attachments", async () => {
    const cfg = form([{ key: "doc", type: "file", label: "Doc", maxFiles: 1 }]);
    const two = new Map<string, File[]>([
      [
        "doc",
        [
          new File(["a"], "a.txt", { type: "text/plain" }),
          new File(["b"], "b.txt", { type: "text/plain" }),
        ],
      ],
    ]);
    expect(
      (await validateFormSubmission({ form: cfg, values: {}, files: two })).ok,
    ).toBe(false);

    const one = new Map<string, File[]>([
      ["doc", [new File(["hello"], "a.txt", { type: "text/plain" })]],
    ]);
    const result = await validateFormSubmission({
      form: cfg,
      values: {},
      files: one,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments).toHaveLength(1);
      expect(result.payload.doc).toEqual(["a.txt"]);
    }
  });
});
