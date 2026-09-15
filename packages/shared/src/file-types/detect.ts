import { fileTypeFromBuffer } from "file-type";
import {
  extensionOf,
  isLikelyUtf8Text,
  resolveTypeForFile,
  TEXT_EXT_TO_MIME,
  typeForMime,
} from "./derive";
import type { FileTypeDef } from "./types";

// ============================================================================ //
// FILE-TYPE DETECTION (backend only)                                           //
// ----------------------------------------------------------------------------//
// The ONLY module in `file-types/` with a dependency, and deliberately NOT     //
// re-exported by `index.ts` — the frontend alias points at that index, so the  //
// shared surface stays isomorphic and dependency-free.                         //
//                                                                             //
// Every ingestion boundary (Drive upload, chat attachment, context file,       //
// workflow form, sandbox artefact) resolves its file HERE, once, and persists  //
// the returned MIME. Downstream code trusts the stored MIME and never          //
// re-derives a type from the filename.                                         //
// ============================================================================ //

export interface ResolvedFile {
  /** Canonical MIME to persist. `application/octet-stream` when unknown. */
  mimeType: string;
  /** Registry entry, or `null` when the file is of no type we support. */
  type: FileTypeDef | null;
}

/**
 * Re-exported for the callers that have always imported it from here.
 * It LIVES in `derive.ts` now: the frontend viewer needs the same sniff
 * to recognise a text file wearing an extension nobody has catalogued,
 * and `index.ts` — the browser's door into this directory — cannot reach
 * this module without dragging `file-type` into the bundle.
 */
export { isLikelyUtf8Text };

/**
 * `file-type` reports one generic MIME for every Microsoft Compound File
 * Binary container — legacy Office documents AND Outlook messages all
 * come back as `application/x-cfb`, with no sub-detection. The extension
 * is the only signal that separates them; without one the file stays
 * unidentified rather than being guessed at.
 */
const CFB_MIME = "application/x-cfb";
const CFB_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".msg": "application/vnd.ms-outlook",
};

/**
 * Resolve the REAL type of a file from its bytes.
 *
 *  1. Magic bytes (`file-type`) — authoritative for every binary format.
 *     A wrong extension or a lying browser `file.type` cannot override
 *     it, which is the whole point: a PDF renamed `.txt` is still a PDF,
 *     and a text file renamed `.pdf` is still text.
 *  2. No signature + UTF-8 bytes → a textual format. These carry no magic
 *     bytes, so the extension decides the flavour (`.md` → markdown,
 *     `.py` → text/plain refined to `code`), then the declared MIME, then
 *     `text/plain`.
 *  3. Otherwise: an unknown binary.
 */
export const resolveFileType = async (input: {
  bytes: Uint8Array;
  declaredMime?: string;
  filename?: string;
}): Promise<ResolvedFile> => {
  const finalise = (mimeType: string): ResolvedFile => ({
    mimeType,
    type:
      resolveTypeForFile({ mime: mimeType, filename: input.filename }) ?? null,
  });

  const detected = await fileTypeFromBuffer(input.bytes);
  if (detected) {
    if (detected.mime !== CFB_MIME) return finalise(detected.mime);
    const ext = input.filename ? extensionOf(input.filename) : "";
    const disambiguated = CFB_BY_EXTENSION[ext];
    return disambiguated
      ? finalise(disambiguated)
      : { mimeType: CFB_MIME, type: null };
  }

  if (isLikelyUtf8Text(input.bytes)) {
    const fromExtension = input.filename
      ? TEXT_EXT_TO_MIME[extensionOf(input.filename)]
      : undefined;
    if (fromExtension) return finalise(fromExtension);
    const declared = input.declaredMime
      ? typeForMime(input.declaredMime)
      : undefined;
    return finalise(declared?.textual ? declared.mime : "text/plain");
  }

  return { mimeType: "application/octet-stream", type: null };
};
