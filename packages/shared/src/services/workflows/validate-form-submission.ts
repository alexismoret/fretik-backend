import { resolveFileType } from "../../file-types/detect";
import {
  WORKFLOW_FORM_FILE_MAX_MB,
  type WorkflowFormConfig,
  type WorkflowFormField,
} from "../../schemas/workflow-forms";
import { MAX_FILE_SIZE_BYTES } from "../../utils/chatbot-limits";
import type { RunAttachment } from "./attach-run-files";

/**
 * Server-authoritative validation of a public form submission against the
 * stored form config — the browser is never trusted. On success returns the
 * cleaned `triggerPayload` (field key → coerced value; file fields → the list
 * of filenames) plus the `RunAttachment[]` for `createWorkflowRun`.
 */
export type FormSubmissionResult =
  | { ok: true; payload: Record<string, unknown>; attachments: RunAttachment[] }
  | { ok: false; message: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isEmpty = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  v === "" ||
  (Array.isArray(v) && v.length === 0);

// Match a detected MIME against an `accept` allowlist of MIME types or
// wildcards (`application/pdf`, `image/*`, `*` / `*/*`).
//
// Line comments, not a JSDoc block: `*/*` closes a block comment, and the
// workaround was a ZERO WIDTH SPACE wedged between the star and the slash —
// invisible in every editor, and flagged by oxlint's no-irregular-whitespace.
const mimeMatchesAccept = (mime: string, accept: string[]): boolean => {
  const m = mime.toLowerCase();
  return accept.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (pattern === "*" || pattern === "*/*") return true;
    if (pattern.endsWith("/*")) return m.startsWith(pattern.slice(0, -1));
    return m === pattern;
  });
};

const validateScalar = (
  field: WorkflowFormField,
  raw: unknown,
): { value: unknown } | { error: string } => {
  const label = field.label || field.key;
  switch (field.type) {
    case "short_text":
    case "long_text": {
      if (typeof raw !== "string") return { error: `"${label}" must be text.` };
      if (field.minLength !== undefined && raw.length < field.minLength) {
        return {
          error: `"${label}" must be at least ${field.minLength.toString()} characters.`,
        };
      }
      if (field.maxLength !== undefined && raw.length > field.maxLength) {
        return {
          error: `"${label}" must be at most ${field.maxLength.toString()} characters.`,
        };
      }
      return { value: raw };
    }
    case "number": {
      const n =
        typeof raw === "number"
          ? raw
          : typeof raw === "string"
            ? Number(raw)
            : Number.NaN;
      if (!Number.isFinite(n)) return { error: `"${label}" must be a number.` };
      if (field.min !== undefined && n < field.min) {
        return {
          error: `"${label}" must be at least ${field.min.toString()}.`,
        };
      }
      if (field.max !== undefined && n > field.max) {
        return { error: `"${label}" must be at most ${field.max.toString()}.` };
      }
      return { value: n };
    }
    case "email": {
      if (typeof raw !== "string" || !EMAIL_RE.test(raw)) {
        return { error: `"${label}" must be a valid email.` };
      }
      return { value: raw };
    }
    case "url": {
      if (typeof raw !== "string")
        return { error: `"${label}" must be a URL.` };
      try {
        void new URL(raw);
      } catch {
        return { error: `"${label}" must be a valid URL.` };
      }
      return { value: raw };
    }
    case "phone": {
      if (typeof raw !== "string") return { error: `"${label}" must be text.` };
      return { value: raw };
    }
    case "date": {
      if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
        return { error: `"${label}" must be a valid date.` };
      }
      return { value: raw };
    }
    case "checkbox": {
      return { value: raw === true || raw === "true" };
    }
    case "select": {
      const allowed = new Set((field.options ?? []).map((o) => o.value));
      if (typeof raw !== "string" || !allowed.has(raw)) {
        return { error: `"${label}" has an invalid selection.` };
      }
      return { value: raw };
    }
    case "multi_select": {
      const allowed = new Set((field.options ?? []).map((o) => o.value));
      const arr = (Array.isArray(raw) ? raw : [raw]).filter(
        (v): v is string => typeof v === "string",
      );
      if (arr.some((v) => !allowed.has(v))) {
        return { error: `"${label}" has an invalid selection.` };
      }
      return { value: arr };
    }
    default:
      return { value: raw };
  }
};

export const validateFormSubmission = async (params: {
  form: WorkflowFormConfig;
  values: Record<string, unknown>;
  files: Map<string, File[]>;
}): Promise<FormSubmissionResult> => {
  const payload: Record<string, unknown> = {};
  const attachments: RunAttachment[] = [];

  for (const field of params.form.fields) {
    const label = field.label || field.key;

    if (field.type === "file") {
      const uploaded = params.files.get(field.key) ?? [];
      if (field.required && uploaded.length === 0) {
        return { ok: false, message: `"${label}" is required.` };
      }
      if (field.maxFiles !== undefined && uploaded.length > field.maxFiles) {
        return {
          ok: false,
          message: `"${label}" accepts at most ${field.maxFiles.toString()} file(s).`,
        };
      }
      const perFileCap = Math.min(
        (field.maxFileSizeMb ?? WORKFLOW_FORM_FILE_MAX_MB) * 1024 * 1024,
        MAX_FILE_SIZE_BYTES,
      );
      const names: string[] = [];
      for (const file of uploaded) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength > perFileCap) {
          return { ok: false, message: `"${file.name}" is too large.` };
        }
        const resolved = await resolveFileType({
          bytes,
          declaredMime: file.type,
          filename: file.name,
        });
        const mime = resolved.mimeType;
        if (!resolved.type?.surfaces.includes("workflow-form")) {
          return {
            ok: false,
            message: `"${file.name}" is an unsupported file type.`,
          };
        }
        if (
          field.accept &&
          field.accept.length > 0 &&
          !mimeMatchesAccept(mime, field.accept)
        ) {
          return {
            ok: false,
            message: `"${file.name}" is not an accepted file type.`,
          };
        }
        attachments.push({ filename: file.name, mimeType: mime, bytes });
        names.push(file.name);
      }
      if (names.length > 0) payload[field.key] = names;
      continue;
    }

    const raw = params.values[field.key];
    if (isEmpty(raw)) {
      if (field.required)
        return { ok: false, message: `"${label}" is required.` };
      continue;
    }
    const result = validateScalar(field, raw);
    if ("error" in result) return { ok: false, message: result.error };
    payload[field.key] = result.value;
  }

  return { ok: true, payload, attachments };
};
