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

/** Mistral OCR model name, exported for traceability in logs. */
export const MISTRAL_OCR_MODEL = "mistral-ocr-latest";
