import type { UIMessage } from "ai";
import { describe, expect, test } from "bun:test";
import { MODEL_PROFILES } from "../../../../src/lib/model-registry/profiles";
import type {
  InputModality,
  ModelProfile,
  NativeInputPolicy,
} from "../../../../src/lib/model-registry/types";
import {
  type PrepareModelMessagesDeps,
  prepareModelMessages,
  stripFilePartsForModel,
  stripReasoningPartsForModel,
} from "../../../../src/services/native-input/prepare-model-messages";

const profileWith = (
  inputModalities: readonly InputModality[],
  nativeInput: Partial<NativeInputPolicy>,
): ModelProfile => ({
  key: "test",
  family: "other",
  tiers: ["flagship"],
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
    evalGate: { status: "passed" },
  },
});

const mediaMsg = (
  id: string,
  mediaType: string,
  filename: string,
): UIMessage => ({
  id,
  role: "user",
  parts: [
    { type: "text", text: "look at this" },
    { type: "file", mediaType, filename, url: "https://s3/old-presigned" },
  ],
});

interface StubDeps extends PrepareModelMessagesDeps {
  calls: { read: string[][]; presign: string[][] };
}

const makeDeps = (over: Partial<PrepareModelMessagesDeps> = {}): StubDeps => {
  const calls = { read: [] as string[][], presign: [] as string[][] };
  return {
    calls,
    conversationId: "conv-1",
    readSessionFile: async (cid, rel) => {
      calls.read.push([cid, rel]);
      return new Uint8Array([1, 2, 3]);
    },
    presignSessionFile: async (cid, rel) => {
      calls.presign.push([cid, rel]);
      return `https://s3/fresh/${rel}`;
    },
    ...over,
  };
};

describe("prepareModelMessages — inert byte-identity (the central guard)", () => {
  test("a non-multimodal/inert profile is byte-identical to stripFilePartsForModel and does no I/O", async () => {
    const history = [mediaMsg("1", "image/png", "a.png")];
    const profile = profileWith(["text", "image"], {}); // all flags off
    const deps = makeDeps();
    const result = await prepareModelMessages(history, profile, deps);
    expect(result).toEqual(stripFilePartsForModel(history));
    expect(deps.calls.read).toHaveLength(0);
    expect(deps.calls.presign).toHaveLength(0);
  });

  test("every INERT registry profile is byte-identical end-to-end (no I/O)", async () => {
    // M3 has native input activated (C5 step 12); every other profile is
    // still inert and must be a pure pass-through.
    const history = [
      mediaMsg("1", "image/png", "a.png"),
      mediaMsg("2", "video/mp4", "b.mp4"),
    ];
    const inert = Object.values(MODEL_PROFILES).filter((p) => {
      const n = p.assessment.nativeInput;
      return !n.image && !n.video && !n.audio && n.fileMimeTypes.length === 0;
    });
    expect(inert.length).toBeGreaterThan(0);
    for (const profile of inert) {
      const deps = makeDeps();
      const result = await prepareModelMessages(history, profile, deps);
      expect(result).toEqual(stripFilePartsForModel(history));
      expect(deps.calls.read).toHaveLength(0);
      expect(deps.calls.presign).toHaveLength(0);
    }
  });

  test("the activated flagship (M3) ingests image + video natively", async () => {
    const m3 = MODEL_PROFILES["minimax-m3"];
    expect(m3).toBeDefined();
    if (!m3) return;
    const history = [
      mediaMsg("1", "image/png", "a.png"),
      mediaMsg("2", "video/mp4", "b.mp4"),
    ];
    const deps = makeDeps();
    const result = await prepareModelMessages(history, m3, deps);
    // image → base64 data URL, video → presigned URL
    expect(result[0]?.parts[1]).toMatchObject({
      type: "file",
      url: "data:image/png;base64,AQID",
    });
    expect(result[1]?.parts[1]).toMatchObject({
      type: "file",
      url: "https://s3/fresh/attachments/b.mp4",
    });
    expect(deps.calls.read).toEqual([["conv-1", "attachments/a.png"]]);
    expect(deps.calls.presign).toEqual([["conv-1", "attachments/b.mp4"]]);
  });
});

describe("prepareModelMessages — native transport", () => {
  test("image native → base64 data URL, read once, text untouched, input not mutated", async () => {
    const history = [mediaMsg("1", "image/png", "a.png")];
    const snapshot = JSON.stringify(history);
    const profile = profileWith(["text", "image"], { image: true });
    const deps = makeDeps();
    const result = await prepareModelMessages(history, profile, deps);

    const parts = result[0]?.parts ?? [];
    expect(parts[0]).toEqual({ type: "text", text: "look at this" });
    expect(parts[1]).toMatchObject({
      type: "file",
      mediaType: "image/png",
      filename: "a.png",
      url: "data:image/png;base64,AQID",
    });
    expect(deps.calls.read).toEqual([["conv-1", "attachments/a.png"]]);
    expect(deps.calls.presign).toHaveLength(0);
    // input array untouched (no base64 leaked back into the persisted history)
    expect(JSON.stringify(history)).toBe(snapshot);
  });

  test("video native → fresh presigned URL by reference, presign once, NO byte read", async () => {
    const history = [mediaMsg("1", "video/mp4", "b.mp4")];
    const profile = profileWith(["text", "video"], { video: true });
    const deps = makeDeps();
    const result = await prepareModelMessages(history, profile, deps);

    expect(result[0]?.parts[1]).toMatchObject({
      type: "file",
      mediaType: "video/mp4",
      url: "https://s3/fresh/attachments/b.mp4",
    });
    expect(deps.calls.presign).toEqual([["conv-1", "attachments/b.mp4"]]);
    expect(deps.calls.read).toHaveLength(0);
  });
});

describe("prepareModelMessages — recency cap + failure handling", () => {
  test("maxVideosPerRequest:1 keeps the most-recent video, strips the older one", async () => {
    const history = [
      mediaMsg("1", "video/mp4", "old.mp4"),
      mediaMsg("2", "video/mp4", "new.mp4"),
    ];
    const profile = profileWith(["text", "video"], {
      video: true,
      limits: { maxVideosPerRequest: 1 },
    });
    const deps = makeDeps();
    const result = await prepareModelMessages(history, profile, deps);

    // older message keeps only its text part (video demoted to tool-mediated)
    expect(result[0]?.parts).toHaveLength(1);
    expect(result[0]?.parts[0]).toMatchObject({ type: "text" });
    // newer message keeps the native video
    expect(result[1]?.parts[1]).toMatchObject({
      type: "file",
      url: "https://s3/fresh/attachments/new.mp4",
    });
    expect(deps.calls.presign).toEqual([["conv-1", "attachments/new.mp4"]]);
  });

  test("a read failure drops that part to tool-mediated, never throws", async () => {
    const history = [mediaMsg("1", "image/png", "a.png")];
    const profile = profileWith(["text", "image"], { image: true });
    const deps = makeDeps({
      readSessionFile: async () => {
        throw new Error("S3 down");
      },
    });
    const result = await prepareModelMessages(history, profile, deps);
    expect(result[0]?.parts).toHaveLength(1);
    expect(result[0]?.parts[0]).toMatchObject({ type: "text" });
  });

  test("missing conversationId drops native parts without attempting I/O", async () => {
    const history = [mediaMsg("1", "image/png", "a.png")];
    const profile = profileWith(["text", "image"], { image: true });
    const deps = makeDeps({ conversationId: undefined });
    const result = await prepareModelMessages(history, profile, deps);
    expect(result[0]?.parts).toHaveLength(1);
    expect(deps.calls.read).toHaveLength(0);
  });
});

// Reasoning is never re-sent: the OpenRouter provider drops Gemini/Claude
// reasoning whose signature was lost on a cut-off turn (bug #423), logging a
// per-turn warning and feeding an inconsistent context (a zombie trigger).
describe("prepareModelMessages — reasoning stripping (#423)", () => {
  const reasoningHistory = (): UIMessage[] => [
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "internal chain of thought" },
        { type: "text", text: "the visible answer" },
      ],
    },
  ];

  test("stripReasoningPartsForModel drops reasoning, keeps others, no mutation", () => {
    const history = reasoningHistory();
    const out = stripReasoningPartsForModel(history);
    expect(out[0]?.parts).toEqual([
      { type: "text", text: "the visible answer" },
    ]);
    // input untouched
    expect(history[0]?.parts).toHaveLength(2);
  });

  test("fast path (inert profile) strips prior-turn reasoning", async () => {
    const inert = profileWith(["text"], {});
    const result = await prepareModelMessages(
      reasoningHistory(),
      inert,
      makeDeps(),
    );
    expect(
      result.flatMap((m) => m.parts).some((p) => p.type === "reasoning"),
    ).toBe(false);
    expect(result[0]?.parts).toEqual([
      { type: "text", text: "the visible answer" },
    ]);
  });

  test("native path also strips reasoning (reasoning + native image in one history)", async () => {
    const nativeImage = profileWith(["text", "image"], { image: true });
    const history: UIMessage[] = [
      ...reasoningHistory(),
      mediaMsg("u1", "image/png", "shot.png"),
    ];
    const result = await prepareModelMessages(history, nativeImage, makeDeps());
    expect(
      result.flatMap((m) => m.parts).some((p) => p.type === "reasoning"),
    ).toBe(false);
  });
});
