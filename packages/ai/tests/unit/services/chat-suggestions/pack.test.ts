import { describe, expect, test } from "bun:test";
import { renderSuggestionPack } from "../../../../src/services/chat-suggestions/pack";
import type { SuggestionSources } from "../../../../src/services/chat-suggestions/sources";

/**
 * The context pack, which is pure and therefore the one part of this feature
 * that can be pinned exactly.
 *
 * Two properties carry the whole design:
 *
 *  1. **The hash decides whether a model runs.** It must be stable for an
 *     unchanged workspace on the same day (otherwise every page load is a
 *     bill), move when the work moves, and move once a day regardless
 *     (otherwise "prepare Monday's report" is still suggested on Thursday).
 *  2. **`sourceIds` is the allow-list the parser gates on.** Every id rendered
 *     into the text has to be in it, or a true suggestion gets dropped as if
 *     it were invented.
 */

const NOW = new Date("2026-09-13T09:00:00.000Z");

const empty: SuggestionSources = {
  episodes: [],
  conversations: [],
  memories: [],
  attention: [],
  activity: [],
  capabilities: [],
  resolvedLabels: [],
};

const episode = (id: string, title: string, summary = "Some summary") => ({
  id,
  kind: "conversation" as const,
  title,
  summary,
  at: new Date("2026-09-10T10:00:00.000Z"),
});

const populated = (): SuggestionSources => ({
  ...empty,
  episodes: [
    episode("11111111-1111-1111-1111-111111111111", "Contract review"),
  ],
  memories: [
    {
      scope: "team",
      path: "conventions/tone.md",
      content: "Always answer in French.",
      updatedAt: new Date("2026-09-01T10:00:00.000Z"),
    },
  ],
  capabilities: [
    {
      kind: "workflow",
      id: "22222222-2222-2222-2222-222222222222",
      name: "Weekly report",
      description: "Builds the weekly report",
    },
  ],
});

describe("renderSuggestionPack — the fingerprint", () => {
  test("is stable for the same workspace on the same day", () => {
    const a = renderSuggestionPack(populated(), { language: "fr", now: NOW });
    const b = renderSuggestionPack(populated(), { language: "fr", now: NOW });

    expect(a.inputHash).toBe(b.inputHash);
  });

  test("moves when the day moves, even with identical sources", () => {
    const today = renderSuggestionPack(populated(), {
      language: "fr",
      now: NOW,
    });
    const tomorrow = renderSuggestionPack(populated(), {
      language: "fr",
      now: new Date("2026-09-14T09:00:00.000Z"),
    });

    expect(tomorrow.inputHash).not.toBe(today.inputHash);
  });

  test("ignores the time of day — a morning and an evening visit agree", () => {
    const morning = renderSuggestionPack(populated(), {
      language: "fr",
      now: NOW,
    });
    const evening = renderSuggestionPack(populated(), {
      language: "fr",
      now: new Date("2026-09-13T21:30:00.000Z"),
    });

    expect(evening.inputHash).toBe(morning.inputHash);
  });

  test("moves when the work moves", () => {
    const before = renderSuggestionPack(populated(), {
      language: "fr",
      now: NOW,
    });
    const after = renderSuggestionPack(
      {
        ...populated(),
        episodes: [
          episode("11111111-1111-1111-1111-111111111111", "Contract review"),
          episode("33333333-3333-3333-3333-333333333333", "New deal"),
        ],
      },
      { language: "fr", now: NOW },
    );

    expect(after.inputHash).not.toBe(before.inputHash);
  });
});

describe("renderSuggestionPack — provenance", () => {
  test("every id it renders is offered to the parser", () => {
    const pack = renderSuggestionPack(populated(), {
      language: "fr",
      now: NOW,
    });

    for (const id of pack.sourceIds) {
      expect(pack.text).toContain(id);
    }
    expect(
      pack.sourceIds.has("episode:11111111-1111-1111-1111-111111111111"),
    ).toBe(true);
    expect(
      pack.sourceIds.has("workflow:22222222-2222-2222-2222-222222222222"),
    ).toBe(true);
  });

  test("carries the reader's language, which is what the answer is written in", () => {
    const pack = renderSuggestionPack(populated(), {
      language: "fr",
      now: NOW,
    });

    expect(pack.text).toContain("Write in this language: fr.");
  });

  test("omits a section it has nothing for, rather than heading an empty list", () => {
    const pack = renderSuggestionPack(populated(), {
      language: "en",
      now: NOW,
    });

    expect(pack.text).toContain("## Recent episodes");
    expect(pack.text).not.toContain("## Waiting on this person");
  });

  test("collapses a repetitive journal into one line per distinct thing", () => {
    const upload = (title: string) => ({
      id: crypto.randomUUID(),
      type: "document.uploaded",
      title,
      actorName: "Alex",
      status: null,
      documentId: null,
      collectionKey: null,
      workflowId: null,
      runId: null,
      at: new Date("2026-09-12T10:00:00.000Z"),
    });
    const pack = renderSuggestionPack(
      {
        ...empty,
        conversations: [],
        episodes: populated().episodes,
        activity: [
          upload("invoice.pdf"),
          upload("invoice.pdf"),
          upload("cmr.pdf"),
        ],
      },
      { language: "en", now: NOW },
    );

    const invoiceLines = pack.text
      .split("\n")
      .filter((line) => line.includes("invoice.pdf"));
    expect(invoiceLines).toHaveLength(1);
    expect(pack.text).toContain("cmr.pdf");
  });
});

describe("renderSuggestionPack — cold start", () => {
  test("an empty workspace is cold, so nothing is generated for it", () => {
    const pack = renderSuggestionPack(empty, { language: "en", now: NOW });

    expect(pack.isCold).toBe(true);
  });

  test("capabilities and activity alone are not personalisation", () => {
    // A team that has just been set up has a workflow and an upload, and
    // nothing about THIS person. Suggesting from that would be generic.
    const pack = renderSuggestionPack(
      {
        ...empty,
        capabilities: populated().capabilities,
        activity: [
          {
            id: crypto.randomUUID(),
            type: "document.uploaded",
            title: "invoice.pdf",
            actorName: null,
            status: null,
            documentId: null,
            collectionKey: null,
            workflowId: null,
            runId: null,
            at: NOW,
          },
        ],
      },
      { language: "en", now: NOW },
    );

    expect(pack.isCold).toBe(true);
  });

  test("one episode is enough to stop being cold", () => {
    const pack = renderSuggestionPack(
      { ...empty, episodes: populated().episodes },
      { language: "en", now: NOW },
    );

    expect(pack.isCold).toBe(false);
  });
});
