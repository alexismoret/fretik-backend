import { describe, expect, test } from "bun:test";
import { sanitizeIcon } from "../../../src/tools/manage-workflow";

/**
 * Icon is a cosmetic field, so an unknown name (a real-but-uncurated Lucide
 * icon like `file-spreadsheet`, or a typo) must NOT fail the whole write —
 * it drops to the platform default with a warning, mirroring `sanitizeToolHints`.
 * The old hard-fail discarded a fully-generated create_draft payload.
 */
describe("sanitizeIcon", () => {
  test("keeps a valid catalog icon, no warning", () => {
    expect(sanitizeIcon("table")).toEqual({ icon: "table", warnings: [] });
  });

  test("passes through undefined untouched (icon left unchanged)", () => {
    expect(sanitizeIcon(undefined)).toEqual({
      icon: undefined,
      warnings: [],
    });
  });

  test("drops an unknown icon and warns instead of failing", () => {
    const result = sanitizeIcon("file-spreadsheet");
    expect(result.icon).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("file-spreadsheet");
    expect(result.warnings[0]).toContain("searchIcons");
  });
});
