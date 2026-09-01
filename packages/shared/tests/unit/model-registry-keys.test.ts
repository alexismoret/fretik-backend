import { describe, expect, test } from "bun:test";
import { modelKeyForId } from "../../src/model-registry/keys";

/**
 * The registry key, pinned.
 *
 * This function used to exist twice — `candidateKey` in the sync and
 * `slugForModelId` in the `model-admin` CLI — each documenting the other in a
 * comment. The two spellings had to stay byte-identical for a reason the tests
 * below state: a hand-added model and the same model found by discovery must
 * COLLIDE on one row, so the second insert is a no-op rather than a duplicate
 * the fleet routes to half the time.
 *
 * Nothing enforced that. These assertions do.
 */
describe("modelKeyForId", () => {
  test("turns a catalogue id into a flat slug", () => {
    expect(modelKeyForId("alibaba/qwen-3-235b")).toBe("alibaba-qwen-3-235b");
  });

  test("folds case, so two spellings of one id cannot split into two rows", () => {
    expect(modelKeyForId("Alibaba/Qwen-3-235B")).toBe(
      modelKeyForId("alibaba/qwen-3-235b"),
    );
  });

  test("collapses every run of punctuation to a single dash", () => {
    expect(modelKeyForId("acme//m1__v2.5")).toBe("acme-m1-v2-5");
  });

  test("never leaves a leading or trailing dash", () => {
    expect(modelKeyForId("/acme/m1/")).toBe("acme-m1");
  });

  test("fits the 64-char key column", () => {
    // The column is varchar(64): a longer id is truncated rather than rejected,
    // and truncation is what makes two very long ids able to collide.
    const key = modelKeyForId(`acme/${"m".repeat(100)}`);
    expect(key).toHaveLength(64);
    expect(key.startsWith("acme-mmm")).toBe(true);
  });
});
