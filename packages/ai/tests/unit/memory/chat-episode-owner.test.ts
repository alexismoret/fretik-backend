import { describe, expect, test } from "bun:test";
import { chatEpisodeOwner } from "../../../src/services/memory/distill-conversation";

/**
 * Whose memory a chat becomes. A chat is its participants': the rest of the
 * team could not read it, so its episode is never the team's (a NULL owner),
 * which is what a chat with two or more members used to distill to.
 */

const OWNER = "01a0d300-0000-7000-8000-000000000001";
const MEMBER = "01a0d300-0000-7000-8000-000000000002";
const CREATOR = "01a0d300-0000-7000-8000-000000000003";

describe("chatEpisodeOwner", () => {
  test("a chat of one is that person's", () => {
    expect(
      chatEpisodeOwner({
        members: [{ userId: MEMBER, role: "member" }],
        creatorUserId: CREATOR,
      }),
    ).toBe(MEMBER);
  });

  test("a chat of several is its owner's, never the team's", () => {
    expect(
      chatEpisodeOwner({
        members: [
          { userId: MEMBER, role: "member" },
          { userId: OWNER, role: "owner" },
        ],
        creatorUserId: CREATOR,
      }),
    ).toBe(OWNER);
  });

  test("with no owner seat, or no seats at all, it is its creator's", () => {
    expect(
      chatEpisodeOwner({
        members: [
          { userId: MEMBER, role: "member" },
          { userId: OWNER, role: "member" },
        ],
        creatorUserId: CREATOR,
      }),
    ).toBe(CREATOR);
    expect(chatEpisodeOwner({ members: [], creatorUserId: CREATOR })).toBe(
      CREATOR,
    );
  });
});
