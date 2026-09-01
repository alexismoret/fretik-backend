import type { UIMessage } from "ai";
import { describe, expect, test } from "bun:test";
import {
  NATIVE_FILE_MAX_BYTES,
  type InputModality,
  type ModelProfile,
  type NativeInputPolicy,
} from "../../../../src/lib/model-registry/types";
import {
  hasNativeFileParts,
  planNativeIngestion,
  prepareModelMessages,
  stripFilePartsForModel,
  stripReasoningPartsForModel,
  type PrepareModelMessagesDeps,
} from "../../../../src/services/native-input/prepare-model-messages";
import { dynamic, profileOf } from "../../../lib/live-fleet";

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
    provider: {},
    enabled: true,
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

  test("a TEXT-ONLY model is byte-identical end-to-end (no I/O)", async () => {
    // The derivation activates a modality exactly where the catalogue lists
    // it, so a text-only model ingests nothing and must be a pure
    // pass-through — no read, no presign.
    const history = [
      mediaMsg("1", "image/png", "a.png"),
      mediaMsg("2", "video/mp4", "b.mp4"),
    ];
    const textOnly = profileOf({
      dynamicProfile: dynamic({ inputModalities: ["text"] }),
    });
    const n = textOnly.assessment.nativeInput;
    expect([n.image, n.video, n.audio, n.fileMimeTypes.length]).toEqual([
      false,
      false,
      false,
      0,
    ]);
    const deps = makeDeps();
    const result = await prepareModelMessages(history, textOnly, deps);
    expect(result).toEqual(stripFilePartsForModel(history));
    expect(deps.calls.read).toHaveLength(0);
    expect(deps.calls.presign).toHaveLength(0);
  });

  test("an image-capable model ingests images natively", async () => {
    // `video` stays off even where the catalogue lists it — no call site
    // produces video parts, which is a fact about us rather than the model.
    const visual = profileWith(["text", "image", "video"], {
      image: true,
      video: true,
    });
    const history = [
      mediaMsg("1", "image/png", "a.png"),
      mediaMsg("2", "video/mp4", "b.mp4"),
    ];
    const deps = makeDeps();
    const result = await prepareModelMessages(history, visual, deps);
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
  test("the video cap keeps the most-recent videos, strips older ones", async () => {
    // The cap is 2 — enough for "compare these two", which is the commonest
    // reason a person attaches more than one — so a THIRD video is what falls
    // back to tool-mediated. It is a policy about us, so it is one constant in
    // `prepare-model-messages.ts` rather than a per-model field: every curated
    // profile that ever declared these limits declared the same numbers.
    const history = [
      mediaMsg("1", "video/mp4", "oldest.mp4"),
      mediaMsg("2", "video/mp4", "middle.mp4"),
      mediaMsg("3", "video/mp4", "newest.mp4"),
    ];
    const profile = profileWith(["text", "video"], { video: true });
    const deps = makeDeps();
    const result = await prepareModelMessages(history, profile, deps);

    // oldest message keeps only its text part (video demoted to tool-mediated)
    expect(result[0]?.parts).toHaveLength(1);
    expect(result[0]?.parts[0]).toMatchObject({ type: "text" });
    // the two newest keep their native video
    expect(result[1]?.parts[1]).toMatchObject({
      type: "file",
      url: "https://s3/fresh/attachments/middle.mp4",
    });
    expect(result[2]?.parts[1]).toMatchObject({
      type: "file",
      url: "https://s3/fresh/attachments/newest.mp4",
    });
    expect(deps.calls.presign).toEqual([
      ["conv-1", "attachments/middle.mp4"],
      ["conv-1", "attachments/newest.mp4"],
    ]);
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

describe("prepareModelMessages — native file (C5v2, PDF)", () => {
  const pdfProfile = (): ModelProfile =>
    profileWith(["text", "file"], {
      fileMimeTypes: ["application/pdf"],
    });

  test("PDF native → base64 data URL with filename preserved", async () => {
    const history = [mediaMsg("1", "application/pdf", "doc.pdf")];
    const deps = makeDeps();
    const result = await prepareModelMessages(history, pdfProfile(), deps);
    expect(result[0]?.parts[1]).toMatchObject({
      type: "file",
      mediaType: "application/pdf",
      filename: "doc.pdf",
      url: "data:application/pdf;base64,AQID",
    });
    expect(deps.calls.read).toEqual([["conv-1", "attachments/doc.pdf"]]);
    expect(deps.calls.presign).toHaveLength(0);
  });

  // A PDF is native on the turn it arrives and not after: re-sending it on
  // every step was ~1.1M of a 2.18M-token thread (prod 2026-07-29).
  test("only the newest turn's PDF rides native; earlier ones demote", async () => {
    const history = [
      mediaMsg("1", "application/pdf", "old.pdf"),
      mediaMsg("2", "application/pdf", "mid.pdf"),
      mediaMsg("3", "application/pdf", "new.pdf"),
    ];
    const result = await prepareModelMessages(
      history,
      pdfProfile(),
      makeDeps(),
    );
    expect(result[0]?.parts).toHaveLength(1);
    expect(result[1]?.parts).toHaveLength(1);
    expect(result[2]?.parts[1]).toMatchObject({ filename: "new.pdf" });
  });

  test("maxFilesPerRequest still caps several PDFs sent in one turn", async () => {
    const history: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "three at once" },
          ...["a.pdf", "b.pdf", "c.pdf"].map((filename) => ({
            type: "file" as const,
            mediaType: "application/pdf",
            filename,
            url: `attachments/${filename}`,
          })),
        ],
      },
    ];
    const result = await prepareModelMessages(
      history,
      pdfProfile(),
      makeDeps(),
    );
    expect(
      result[0]?.parts.filter((p) => p.type === "file").map((p) => p.filename),
    ).toEqual(["a.pdf", "b.pdf"]);
  });

  test("an oversized PDF demotes to tool-mediated, never errors", async () => {
    const history = [mediaMsg("1", "application/pdf", "big.pdf")];
    const deps = makeDeps({
      readSessionFile: async () => new Uint8Array(NATIVE_FILE_MAX_BYTES + 1),
    });
    const result = await prepareModelMessages(history, pdfProfile(), deps);
    expect(result[0]?.parts).toHaveLength(1);
    expect(result[0]?.parts[0]).toMatchObject({ type: "text" });
  });

  test("catalog `file` alone is not enough — empty fileMimeTypes stays tool-mediated", async () => {
    const history = [mediaMsg("1", "application/pdf", "doc.pdf")];
    const profile = profileWith(["text", "file"], {}); // fileMimeTypes: []
    const deps = makeDeps();
    const result = await prepareModelMessages(history, profile, deps);
    expect(result).toEqual(stripFilePartsForModel(history));
    expect(deps.calls.read).toHaveLength(0);
  });

  test("native PDF follows the CATALOGUE's `file` modality, nothing else", async () => {
    // The activation used to be hand-written per profile, on the belief that
    // which MIME types an upstream really accepts is family knowledge no
    // catalogue publishes. Measured 2026-08-30 across the 22 curated profiles:
    // the `file` modality and the hand-written activation agreed on all 22, so
    // it was a published fact the whole time.
    const history = [mediaMsg("1", "application/pdf", "doc.pdf")];

    const fileCapable = profileOf({
      dynamicProfile: dynamic({ inputModalities: ["text", "image", "file"] }),
    });
    const out = await prepareModelMessages(history, fileCapable, makeDeps());
    expect(out[0]?.parts[1]).toMatchObject({
      mediaType: "application/pdf",
      url: "data:application/pdf;base64,AQID",
    });

    // A model whose catalogue lists no `file` → byte-identical strip, with no
    // I/O attempted. Not a product choice: a real upstream limitation.
    const noFile = profileOf({
      dynamicProfile: dynamic({ inputModalities: ["text", "image"] }),
    });
    const deps = makeDeps();
    expect(await prepareModelMessages(history, noFile, deps)).toEqual(
      stripFilePartsForModel(history),
    );
    expect(deps.calls.read).toHaveLength(0);
  });

  test("hasNativeFileParts: true only when a PDF rides natively", () => {
    const pdfHistory = [mediaMsg("1", "application/pdf", "doc.pdf")];
    const imageHistory = [mediaMsg("1", "image/png", "a.png")];
    expect(hasNativeFileParts(pdfHistory, pdfProfile())).toBe(true);
    expect(
      hasNativeFileParts(pdfHistory, profileWith(["text", "file"], {})),
    ).toBe(false);
    // A native IMAGE is not a file part — the file-parser plugin stays off.
    expect(
      hasNativeFileParts(
        imageHistory,
        profileWith(["text", "image"], { image: true }),
      ),
    ).toBe(false);
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

// The prompt used to promise "attached PDFs are directly visible" from the
// PROFILE's capability. Prod 2026-07-27: 4 files attached, 2 reached the
// model, nothing said so, and the agent invented an output column rather than
// opening the example file it never knew it could read.
describe("planNativeIngestion", () => {
  const pdfProfile = profileWith(["text", "file"], {
    fileMimeTypes: ["application/pdf"],
  });

  test("names what rides native and what needs a tool", () => {
    const history: UIMessage[] = [
      mediaMsg("u1", "application/pdf", "a.pdf"),
      {
        id: "u2",
        role: "user",
        parts: [
          { type: "text", text: "and these" },
          ...["b.pdf", "c.pdf"].map((filename) => ({
            type: "file" as const,
            mediaType: "application/pdf",
            filename,
            url: `attachments/${filename}`,
          })),
          {
            type: "file" as const,
            mediaType: "text/csv",
            filename: "example.csv",
            url: "attachments/example.csv",
          },
        ],
      },
    ];
    const plan = planNativeIngestion(history, pdfProfile);
    // This turn's two PDFs ride; an earlier turn's PDF and the non-native mime
    // are reachable only through a tool.
    expect(plan.native).toEqual(["b.pdf", "c.pdf"]);
    expect(plan.toolOnly).toEqual(["a.pdf", "example.csv"]);
  });

  test("a PDF from an earlier turn becomes tool-only", () => {
    const plan = planNativeIngestion(
      [
        mediaMsg("u1", "application/pdf", "invoice.pdf"),
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "ok" }] },
        { id: "u2", role: "user", parts: [{ type: "text", text: "and now?" }] },
      ],
      pdfProfile,
    );
    expect(plan.native).toEqual([]);
    expect(plan.toolOnly).toEqual(["invoice.pdf"]);
  });

  test("an image from an earlier turn still rides native", () => {
    const imageProfile = profileWith(["text", "image"], { image: true });
    const plan = planNativeIngestion(
      [
        mediaMsg("u1", "image/png", "chart.png"),
        { id: "u2", role: "user", parts: [{ type: "text", text: "and Q3?" }] },
      ],
      imageProfile,
    );
    expect(plan.native).toEqual(["chart.png"]);
    expect(plan.toolOnly).toEqual([]);
  });

  test("agrees with what prepareModelMessages actually sends", async () => {
    const history: UIMessage[] = [
      mediaMsg("u1", "application/pdf", "a.pdf"),
      mediaMsg("u2", "application/pdf", "b.pdf"),
      mediaMsg("u3", "application/pdf", "c.pdf"),
    ];
    const plan = planNativeIngestion(history, pdfProfile);
    const prepared = await prepareModelMessages(
      history,
      pdfProfile,
      makeDeps(),
    );
    const sent = prepared
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "file")
      .map((p) => (p.type === "file" ? p.filename : undefined));
    expect(sent).toEqual(plan.native);
  });

  test("a non-multimodal profile makes every file tool-only", () => {
    const inert = profileWith(["text"], {});
    const plan = planNativeIngestion(
      [mediaMsg("u1", "application/pdf", "a.pdf")],
      inert,
    );
    expect(plan.native).toEqual([]);
    expect(plan.toolOnly).toEqual(["a.pdf"]);
  });

  // A workflow run attaches every input file to ONE steering message, so the
  // cap had nothing chronological to rank and sliced the tail: a 2026-07-28
  // run sent 3 PDFs under a cap of 2 and dropped the first — the 29-page
  // primary document. Inside one message, order of delivery decides.
  test("within one message the cap keeps the FIRST files, not the last", () => {
    const history: UIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [
          { type: "text", text: "run" },
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "primary.pdf",
            url: "attachments/primary.pdf",
          },
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "second.pdf",
            url: "attachments/second.pdf",
          },
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "third.pdf",
            url: "attachments/third.pdf",
          },
        ],
      },
    ];
    const plan = planNativeIngestion(history, pdfProfile);
    expect(plan.native).toEqual(["primary.pdf", "second.pdf"]);
    expect(plan.toolOnly).toEqual(["third.pdf"]);
  });

  test("a newer message still outranks an older one", () => {
    const history: UIMessage[] = [
      mediaMsg("u1", "application/pdf", "old.pdf"),
      {
        id: "u2",
        role: "user",
        parts: [
          { type: "text", text: "and these" },
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "new-a.pdf",
            url: "attachments/new-a.pdf",
          },
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "new-b.pdf",
            url: "attachments/new-b.pdf",
          },
        ],
      },
    ];
    const plan = planNativeIngestion(history, pdfProfile);
    expect(plan.native).toEqual(["new-a.pdf", "new-b.pdf"]);
    expect(plan.toolOnly).toEqual(["old.pdf"]);
  });

  test("no files at all → both lists empty (the note renders empty)", () => {
    const plan = planNativeIngestion(
      [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      pdfProfile,
    );
    expect(plan).toEqual({ native: [], toolOnly: [] });
  });
});
