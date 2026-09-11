import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mockModule } from "../../lib/mock-module";

/**
 * Two claims about `assembleContextFragments` that nothing else pins, both of
 * which are about a call NOT happening — so they are asserted on call counts.
 * An assertion on the returned block would pass just as well against a version
 * that did the work and threw the answer away, which is precisely the bug one
 * of them exists to prevent.
 *
 * 1. **An index never suppresses retrieval.** `teamDigestSources` is what
 *    recall uses to leave rows out of `<active_memory>`, and it must be
 *    populated in `digest` mode only. Measured 2026-09-11: the digest's
 *    one-line compression of a convention replaced the verbatim memory and
 *    cost `mr-memory-convention` a point, because the verbatim carried the
 *    literal columns the compression dropped. `<memory_index>` lists every
 *    memory path and suppresses nothing — same rule for the episode arm.
 *
 * 2. **A workflow turn >= 2 reads nothing.** Its memory rode turn 1's steering
 *    message and replays from history. Before P2 both surfaces were read on
 *    every turn of every run and discarded.
 */

const memoryIndexCalls = mock(
  () => "<memory_index>\n/memories/team/ a.md 1K\n</memory_index>",
);
const standingCalls = mock(() =>
  Promise.resolve({
    items: [
      {
        id: "019f0000-0000-7000-8000-000000000001",
        kind: "conversation" as const,
        title: "T",
        summary: "S",
        at: new Date("2026-09-10T00:00:00Z"),
      },
    ],
    visibleInWindow: 1,
  }),
);
const digestCalls = mock(() =>
  Promise.resolve({
    content: "## Current decisions\n- something (episode:x)",
    sources: {
      memoryPaths: ["team/processes/a.md"],
      episodeIds: ["e1"],
      recordIds: [],
    },
    staleAt: null,
  }),
);

beforeAll(async () => {
  // The three fragments this file is not about, silenced so the batch resolves
  // without touching a database.
  await mockModule("../../src/services/chatbot-context/build-manifest", {
    buildChatbotContextManifest: () =>
      Promise.resolve({
        manifest: "",
        totalChars: 0,
        fileCount: 0,
        inlinedFileCount: 0,
      }),
  });
  await mockModule("@fretik/shared/services/collections/describe-team-schema", {
    describeTeamSchema: () => Promise.resolve([]),
  });
  await mockModule("@fretik/shared/services/skills/list-enabled-for-team", {
    listEnabledSkillsForTeam: () => Promise.resolve([]),
  });
  await mockModule("@fretik/shared/services/ai-memory/list-index", {
    buildMemoryIndexManifest: () => Promise.resolve(memoryIndexCalls()),
  });
  await mockModule("@fretik/shared/services/episodes/list-standing", {
    listStandingEpisodes: standingCalls,
  });
  await mockModule("@fretik/shared/services/memory-digest/read", {
    readTeamDigest: digestCalls,
  });
});

const scope = {
  organizationId: "019f0000-0000-7000-8000-00000000000a",
  teamId: "019f0000-0000-7000-8000-00000000000b",
  userId: "019f0000-0000-7000-8000-00000000000c",
  logPrefix: "[test]",
};

const assemble = async (
  standing: Parameters<
    Awaited<
      typeof import("../../../src/agents/shared/fragments")
    >["assembleContextFragments"]
  >[1],
) => {
  const { assembleContextFragments } =
    await import("../../../src/agents/shared/fragments");
  return assembleContextFragments(scope, standing);
};

describe("an index never suppresses retrieval", () => {
  test("`episodes` renders the block and populates NO suppression sources", async () => {
    const fragments = await assemble({ mode: "episodes" });
    expect(fragments.standingMemoryBlock).toContain("(episode:");
    // The whole point: recall sees `undefined` and leaves nothing out.
    expect(fragments.teamDigestSources).toBeUndefined();
  });

  test("`digest` keeps its suppression, so it is measured as built", async () => {
    const fragments = await assemble({ mode: "digest" });
    expect(fragments.standingMemoryBlock).toContain("Current decisions");
    expect(fragments.teamDigestSources?.memoryPaths).toEqual([
      "team/processes/a.md",
    ]);
  });

  test("`none` serves neither the block nor the suppression", async () => {
    const fragments = await assemble({ mode: "none" });
    expect(fragments.standingMemoryBlock).toBeUndefined();
    // Both halves, or the rows the digest covers would be missing from the
    // standing block AND from `<active_memory>` at once.
    expect(fragments.teamDigestSources).toBeUndefined();
  });
});

describe("a workflow turn >= 2 reads nothing", () => {
  test("`memory: false` skips the index and the standing read", async () => {
    memoryIndexCalls.mockClear();
    standingCalls.mockClear();

    const fragments = await assemble({ mode: "episodes", memory: false });

    expect(memoryIndexCalls).not.toHaveBeenCalled();
    expect(standingCalls).not.toHaveBeenCalled();
    expect(fragments.memoryIndexBlock).toBeUndefined();
    expect(fragments.standingMemoryBlock).toBeUndefined();
  });

  test("…and turn 1 still reads both", async () => {
    // The positive control. Without it the test above is satisfied by a
    // function that never reads them at all.
    memoryIndexCalls.mockClear();
    standingCalls.mockClear();

    const fragments = await assemble({ mode: "episodes", memory: true });

    expect(memoryIndexCalls).toHaveBeenCalledTimes(1);
    expect(standingCalls).toHaveBeenCalledTimes(1);
    expect(fragments.memoryIndexBlock).toContain("/memories/team/");
    expect(fragments.standingMemoryBlock).toContain("(episode:");
  });
});
