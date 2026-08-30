import { describe, expect, test } from "bun:test";
import type {
  InputModality,
  ModelProfile,
  NativeInputPolicy,
} from "../../../../src/lib/model-registry/types";
import {
  mediaModality,
  resolveAttachmentIngestion,
} from "../../../../src/services/native-input/resolve-attachment-ingestion";

const profileWith = (
  inputModalities: readonly InputModality[],
  nativeInput: Partial<NativeInputPolicy>,
): ModelProfile => ({
  key: "test",
  family: "other",
  catalog: {
    id: "test/test",
    contextLength: 100_000,
    inputModalities,
    outputModalities: ["text"],
    supportedParameters: ["tools"],
  },
  assessment: {
    costClass: "budget",
    pricing: { inputPerMTok: 1, outputPerMTok: 1 },
    nativeInput: {
      image: false,
      video: false,
      fileMimeTypes: [],
      audio: false,
      ...nativeInput,
    },
    cache: { strategy: "none" },
    reasoning: { style: "none", defaultLevel: "none" },
    provider: { requireParameters: true },
    enabled: true,
  },
});

const filePart = (mediaType?: string) => ({
  type: "file" as const,
  mediaType,
});

describe("mediaModality", () => {
  test("maps MIME families to modality buckets", () => {
    expect(mediaModality("image/png")).toBe("image");
    expect(mediaModality("video/mp4")).toBe("video");
    expect(mediaModality("audio/mpeg")).toBe("audio");
    expect(mediaModality("application/pdf")).toBe("file");
    expect(mediaModality(undefined)).toBe(null);
  });
});

describe("resolveAttachmentIngestion", () => {
  test("inert profile (all flags off) → everything tool-mediated", () => {
    const profile = profileWith(
      ["text", "image", "video", "audio", "file"],
      {},
    );
    for (const mime of [
      "image/png",
      "video/mp4",
      "audio/mpeg",
      "application/pdf",
    ]) {
      expect(resolveAttachmentIngestion(filePart(mime), profile)).toBe(
        "tool-mediated",
      );
    }
  });

  test("image native only when flag on AND catalog lists image", () => {
    expect(
      resolveAttachmentIngestion(
        filePart("image/png"),
        profileWith(["text", "image"], { image: true }),
      ),
    ).toBe("native");
    // flag on but catalog has no image → defense in depth → tool-mediated
    expect(
      resolveAttachmentIngestion(
        filePart("image/png"),
        profileWith(["text"], { image: true }),
      ),
    ).toBe("tool-mediated");
    // catalog has image but flag off
    expect(
      resolveAttachmentIngestion(
        filePart("image/png"),
        profileWith(["text", "image"], { image: false }),
      ),
    ).toBe("tool-mediated");
  });

  test("video native only when flag on AND catalog lists video", () => {
    expect(
      resolveAttachmentIngestion(
        filePart("video/mp4"),
        profileWith(["text", "video"], { video: true }),
      ),
    ).toBe("native");
    expect(
      resolveAttachmentIngestion(
        filePart("video/mp4"),
        profileWith(["text"], { video: true }),
      ),
    ).toBe("tool-mediated");
  });

  test("audio native only when flag on AND catalog lists audio", () => {
    expect(
      resolveAttachmentIngestion(
        filePart("audio/mpeg"),
        profileWith(["text", "audio"], { audio: true }),
      ),
    ).toBe("native");
  });

  test("file (PDF) native only when MIME is listed AND catalog lists file", () => {
    expect(
      resolveAttachmentIngestion(
        filePart("application/pdf"),
        profileWith(["text", "file"], { fileMimeTypes: ["application/pdf"] }),
      ),
    ).toBe("native");
    // listed MIME but no file modality in catalog
    expect(
      resolveAttachmentIngestion(
        filePart("application/pdf"),
        profileWith(["text"], { fileMimeTypes: ["application/pdf"] }),
      ),
    ).toBe("tool-mediated");
    // catalog file but MIME not listed
    expect(
      resolveAttachmentIngestion(
        filePart("application/pdf"),
        profileWith(["text", "file"], { fileMimeTypes: [] }),
      ),
    ).toBe("tool-mediated");
  });

  test("non-file parts and parts without a mediaType are tool-mediated", () => {
    const profile = profileWith(["text", "image"], { image: true });
    expect(
      resolveAttachmentIngestion(
        { type: "text", mediaType: "image/png" },
        profile,
      ),
    ).toBe("tool-mediated");
    expect(resolveAttachmentIngestion(filePart(undefined), profile)).toBe(
      "tool-mediated",
    );
  });
});
