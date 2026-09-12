import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mockModule } from "../../lib/mock-module";

/**
 * What `assembleContextFragments` reads, and — the part nothing else pins —
 * what it must NOT read.
 *
 * **A workflow turn >= 2 reads nothing.** Its memory rode turn 1's steering
 * message and replays from history; before P2 both surfaces were built on
 * every turn of every run and discarded. That claim is asserted on CALL
 * COUNTS, deliberately: an assertion on the returned block passes just as well
 * against a version that does the work and throws the answer away, which is
 * exactly the bug this replaced. The positive control next to it is what stops
 * a function that never reads them at all from satisfying the test.
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

describe("the standing block", () => {
  test("`episodes` renders it, ending in a provenance id", async () => {
    const fragments = await assemble({ mode: "episodes" });
    expect(fragments.standingMemoryBlock).toContain("(episode:");
  });

  test("`none` serves nothing — the rollback", async () => {
    const fragments = await assemble({ mode: "none" });
    expect(fragments.standingMemoryBlock).toBeUndefined();
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
