import type { ModelProfile } from "../../lib/model-registry/types";

/**
 * Native multimodal input (chantier C5) — the PURE decision at the heart
 * of the pipeline. Given one message part and the active model profile,
 * decide whether the attachment travels to the model as a NATIVE content
 * part or stays TOOL-MEDIATED (stripped, reachable only through
 * `read`/`vision`).
 *
 * No I/O — `prepareModelMessages` owns the S3/sandbox reads and the
 * recency cap. Modality-generic: image and video today, file (native PDF)
 * and audio forward-declared. While every profile ships with
 * `nativeInput` fully off, this always returns `"tool-mediated"`, so the
 * pipeline is byte-identical to `stripFilePartsForModel`.
 */
export type AttachmentIngestion = "native" | "tool-mediated";

/** The native input modality an attachment maps to, by MIME family. */
export type NativeModality = "image" | "video" | "file" | "audio";

/**
 * Map a MIME type to its native-input modality bucket. Anything that is
 * not image/video/audio falls in the `file` bucket (PDF today) — whether
 * that bucket is actually sent native is gated on `fileMimeTypes`
 * membership in `resolveAttachmentIngestion`, not here.
 */
export const mediaModality = (
  mediaType: string | undefined,
): NativeModality | null => {
  if (!mediaType) return null;
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return "file";
};

export const resolveAttachmentIngestion = (
  part: { type: string; mediaType?: string },
  profile: ModelProfile,
): AttachmentIngestion => {
  if (part.type !== "file") return "tool-mediated";
  const modality = mediaModality(part.mediaType);
  if (!modality || part.mediaType === undefined) return "tool-mediated";

  const { nativeInput } = profile.assessment;
  const catalog = profile.catalog.inputModalities;

  switch (modality) {
    case "image":
      return nativeInput.image && catalog.includes("image")
        ? "native"
        : "tool-mediated";
    case "video":
      return nativeInput.video && catalog.includes("video")
        ? "native"
        : "tool-mediated";
    case "audio":
      return nativeInput.audio && catalog.includes("audio")
        ? "native"
        : "tool-mediated";
    case "file":
      return nativeInput.fileMimeTypes.includes(part.mediaType) &&
        catalog.includes("file")
        ? "native"
        : "tool-mediated";
  }
};
