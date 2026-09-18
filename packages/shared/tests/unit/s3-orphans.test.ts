import { describe, expect, test } from "bun:test";
import {
  classifyObject,
  documentOwner,
  firstSegmentOwner,
  publicImageOwner,
} from "../../src/lib/s3-orphans";

/**
 * The half of the orphan sweeper that decides what gets deleted.
 *
 * Every case here is really the same question asked twice: does this
 * parser recognise the key, and does it refuse to guess when it does not?
 * A false "orphan" here is somebody's file.
 */

const CONVERSATION = "b1b2c3d4-e5f6-7890-abcd-ef1234567890";
const DOCUMENT = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("firstSegmentOwner", () => {
  const owner = firstSegmentOwner("chatbot-sessions/");

  test("reads the conversation id out of every session key", () => {
    expect(owner(`chatbot-sessions/${CONVERSATION}/outputs/report.xlsx`)).toBe(
      CONVERSATION,
    );
    expect(owner(`chatbot-sessions/${CONVERSATION}/attachments/mail.eml`)).toBe(
      CONVERSATION,
    );
    // Nested deeper, and the previews tree this change introduced.
    expect(
      owner(`chatbot-sessions/${CONVERSATION}/outputs/persisted/call_1.json`),
    ).toBe(CONVERSATION);
    expect(owner(`chatbot-sessions/${CONVERSATION}/previews/abc123.pdf`)).toBe(
      CONVERSATION,
    );
  });

  test("a bare object where a folder belongs is NOT a folder", () => {
    // `chatbot-sessions/stray.txt` is not conversation `stray.txt`. Reading
    // it as one would delete it on the strength of a guess.
    expect(owner("chatbot-sessions/stray.txt")).toBeNull();
    expect(owner("chatbot-sessions/")).toBeNull();
  });

  test("a key from another prefix is never claimed", () => {
    expect(owner(`documents/${DOCUMENT}.pdf`)).toBeNull();
  });
});

describe("documentOwner", () => {
  test("recognises every artefact a document owns", () => {
    for (const suffix of [
      ".pdf",
      ".docx",
      "-thumbnail.webp",
      ".md",
      "-preextract.pdf",
      "-preview-0123456789abcdef.pdf",
      "/v3.docx",
    ]) {
      expect(documentOwner(`documents/${DOCUMENT}${suffix}`)).toBe(DOCUMENT);
    }
  });

  test("is case-insensitive, as uuids in keys are", () => {
    expect(documentOwner(`documents/${DOCUMENT.toUpperCase()}.pdf`)).toBe(
      DOCUMENT.toUpperCase(),
    );
  });

  test("refuses anything that is not a uuid", () => {
    expect(documentOwner("documents/not-a-uuid.pdf")).toBeNull();
    expect(documentOwner("documents/")).toBeNull();
    expect(documentOwner("documents/1234.pdf")).toBeNull();
  });

  test("a longer id is not mistaken for the 36 chars it starts with", () => {
    // The id must end at a delimiter. Without that check a hypothetical
    // longer identifier would resolve to a DIFFERENT, real document.
    expect(documentOwner(`documents/${DOCUMENT}beef.pdf`)).toBeNull();
  });
});

describe("publicImageOwner", () => {
  // Better Auth ids are opaque and may contain dashes, which is why this
  // family matches against the live set instead of parsing.
  const live = new Set(["user-with-dashes", "plainuser"]);
  const owner = publicImageOwner("public/avatars/", () => live);

  test("matches an id that contains dashes of its own", () => {
    expect(owner("public/avatars/user-with-dashes-a1b2c3d4e5f6.webp")).toBe(
      "user-with-dashes",
    );
    expect(owner("public/avatars/plainuser-a1b2c3d4e5f6.webp")).toBe(
      "plainuser",
    );
  });

  test("an id nobody recognises is KEPT, not guessed at", () => {
    // Here "unrecognised" and "orphaned" are the same observation, so the
    // safe reading of the ambiguity is to keep the file.
    expect(owner("public/avatars/someone-else-a1b2c3.webp")).toBeNull();
  });

  test("does not reach into a nested key", () => {
    expect(owner("public/avatars/nested/plainuser-a1b2.webp")).toBeNull();
  });
});

describe("classifyObject", () => {
  const liveIds = new Set([CONVERSATION]);
  const ownerOf = firstSegmentOwner("chatbot-sessions/");
  const cutoff = new Date("2026-09-14T00:00:00Z");
  const old = new Date("2026-09-01T00:00:00Z");
  const recent = new Date("2026-09-15T00:00:00Z");

  test("an owner that still exists is live, however old the object", () => {
    expect(
      classifyObject({
        key: `chatbot-sessions/${CONVERSATION}/outputs/a.csv`,
        lastModified: old,
        ownerOf,
        liveIds,
        cutoff,
      }),
    ).toEqual({ kind: "live", owner: CONVERSATION });
  });

  test("a gone owner past the grace window is an orphan", () => {
    expect(
      classifyObject({
        key: "chatbot-sessions/deleted-conversation/outputs/a.csv",
        lastModified: old,
        ownerOf,
        liveIds,
        cutoff,
      }),
    ).toEqual({ kind: "orphan", owner: "deleted-conversation" });
  });

  test("a gone owner INSIDE the grace window is spared", () => {
    // `uploadDocument` writes bytes before it inserts the row, so a write in
    // flight is indistinguishable from an orphan. The window is what keeps
    // the sweeper from racing it.
    expect(
      classifyObject({
        key: "chatbot-sessions/brand-new/outputs/a.csv",
        lastModified: recent,
        ownerOf,
        liveIds,
        cutoff,
      }).kind,
    ).toBe("too-young");
  });

  test("no modification time counts as young, never as old", () => {
    expect(
      classifyObject({
        key: "chatbot-sessions/unknown-age/outputs/a.csv",
        lastModified: null,
        ownerOf,
        liveIds,
        cutoff,
      }).kind,
    ).toBe("too-young");
  });

  test("an unreadable key is never an orphan, however old", () => {
    expect(
      classifyObject({
        key: "chatbot-sessions/stray.txt",
        lastModified: old,
        ownerOf,
        liveIds,
        cutoff,
      }),
    ).toEqual({ kind: "unrecognised" });
  });
});
