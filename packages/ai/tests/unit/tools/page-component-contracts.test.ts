import { describe, expect, test } from "bun:test";
import { listContractHeavy } from "../../../src/tools/page-component-docs";

/**
 * Which components a page may NOT place from intuition.
 *
 * The discriminator is "does it declare a slot beyond the obvious ones", and it
 * is pinned against the real corpus rather than a fixture: the whole point is
 * that it keeps tracking the library as `sync-nuxt-ui-docs` refreshes it. Both
 * halves matter — the components that must be flagged, and the everyday ones
 * that must not, because a warning channel that fires on `UButton` teaches the
 * agent to skim it.
 */

describe("contract-heavy components", () => {
  test("flags the two whose slots actually shipped a broken page", async () => {
    // UModal: content in the DEFAULT slot renders as the trigger, permanently
    // inline, and the panel opens empty. UTable: the row/expansion slots and
    // the event-first `onSelect` signature.
    expect(await listContractHeavy(["UModal", "UTable"])).toEqual(
      expect.arrayContaining(["UModal", "UTable"]),
    );
  });

  test("flags the rest of the named-slot family", async () => {
    const heavy = await listContractHeavy([
      "USlideover",
      "USelectMenu",
      "UTabs",
    ]);
    expect(heavy).toEqual(
      expect.arrayContaining(["USlideover", "USelectMenu", "UTabs"]),
    );
  });

  test("stays silent on the components everyone gets right", async () => {
    // `UCard` is the interesting one: it has header/title/description/footer
    // slots, but its DEFAULT slot is the content, which is what intuition
    // already expects. Flagging it would be the start of warning about
    // everything.
    expect(
      await listContractHeavy(["UButton", "UBadge", "UIcon", "UCard"]),
    ).toEqual([]);
  });

  test("flags a component whose default slot renders nothing", async () => {
    // `UProgress` exposes only `status`: `<UProgress>text</UProgress>` is
    // silently dropped, which is the same class of failure by another route.
    expect(await listContractHeavy(["UProgress"])).toEqual(["UProgress"]);
  });

  test("accepts the names as written in a template, and drops unknowns", async () => {
    expect(await listContractHeavy(["u-modal"])).toEqual(["UModal"]);
    expect(await listContractHeavy(["UNotAComponent"])).toEqual([]);
  });
});
