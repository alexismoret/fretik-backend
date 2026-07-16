import { Mistral } from "@mistralai/mistralai";

const apiKey = process.env.MISTRAL_API_KEY;
if (!apiKey) {
  throw "Missing MISTRAL_API_KEY env";
}

/**
 * Mistral SDK singleton. Hosted in `@fretik/shared` so every backend
 * package (api, ai, worker) that needs Mistral OCR or any other
 * Mistral capability goes through a single client instance.
 */
export const mistralClient = new Mistral({ apiKey });

/**
 * Mistral OCR model, deliberately pinned (NOT the `mistral-ocr-latest`
 * alias — the alias silently flipped to OCR 4 on 2026-06-23, doubling
 * the per-page price). Re-pin explicitly when adopting a new version,
 * and keep the traced price in `@fretik/ai` lib/mistral-ocr.ts in sync.
 */
export const MISTRAL_OCR_MODEL = "mistral-ocr-4-0";
