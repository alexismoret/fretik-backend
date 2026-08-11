import { describe, expect, test } from "bun:test";
import { validatePageProps } from "../src/catalogs/pages";

describe("validatePageProps", () => {
  test("keeps a valid literal and drops an unknown prop", () => {
    const { props, issues } = validatePageProps("heading", {
      text: "Pipeline",
      level: 2,
      colour: "blue",
    });
    expect(props).toEqual({ text: "Pipeline", level: 2 });
    expect(issues).toEqual([
      { prop: "colour", message: 'dropped unknown prop "colour"' },
    ]);
  });

  test("an off-scale enum value is dropped and the scale is named", () => {
    const { props, issues } = validatePageProps("badge", {
      label: "Won",
      color: "cornflower",
    });
    expect(props).toEqual({ label: "Won" });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toStartWith(
      'dropped prop "color" — expected one of primary|secondary|',
    );
  });

  // The point of the format: a bound prop's type is unknowable until the data
  // arrives, so validation must not touch it.
  test("a binding passes through on any prop", () => {
    const binding = {
      $: "$sum(data.deals.amount) > 1000 ? 'error' : 'success'",
    };
    const { props, issues } = validatePageProps("stat", {
      label: "Revenue",
      value: { $: "$sum(data.deals.amount)" },
      deltaColor: binding,
    });
    expect(props.deltaColor).toBe(binding);
    expect(issues).toEqual([]);
  });

  test("json-render's own dynamic values pass through too", () => {
    const { props, issues } = validatePageProps("tabs", {
      value: { $bindState: "/tab" },
      variant: { $state: "/variant" },
    });
    expect(props).toEqual({
      value: { $bindState: "/tab" },
      variant: { $state: "/variant" },
    });
    expect(issues).toEqual([]);
  });

  test("a number is coerced into a numeric-string scale", () => {
    const { props, issues } = validatePageProps("grid", { cols: 3 });
    expect(props).toEqual({ cols: "3" });
    expect(issues).toEqual([]);
  });

  test("common props apply to a component that does not declare them", () => {
    const { props, issues } = validatePageProps("heading", {
      text: "Pipeline",
      span: 4,
      pad: "md",
      grow: true,
    });
    expect(props).toEqual({
      text: "Pipeline",
      span: "4",
      pad: "md",
      grow: true,
    });
    expect(issues).toEqual([]);
  });

  test("a responsive prop is checked branch by branch", () => {
    const { props, issues } = validatePageProps("grid", {
      cols: { base: "1", md: 3, lg: "4" },
    });
    expect(props).toEqual({ cols: { base: "1", md: "3", lg: "4" } });
    expect(issues).toEqual([]);
  });

  test("one bad breakpoint drops the whole prop", () => {
    const { props, issues } = validatePageProps("grid", {
      cols: { base: "1", md: "7" },
    });
    expect(props).toEqual({});
    expect(issues[0]?.message).toStartWith(
      'dropped prop "cols" — expected one of',
    );
  });

  test("a binding inside a breakpoint survives", () => {
    const { props } = validatePageProps("grid", {
      cols: { base: "1", md: { $: "state.dense ? '4' : '2'" } },
    });
    expect(props).toEqual({
      cols: { base: "1", md: { $: "state.dense ? '4' : '2'" } },
    });
  });

  test("a responsive object on a prop that is not responsive is refused", () => {
    const { props, issues } = validatePageProps("grid", {
      gap: { base: "sm", md: "lg" },
    });
    expect(props).toEqual({});
    expect(issues[0]?.message).toBe(
      'dropped prop "gap" — it takes one value, not a responsive object',
    );
  });

  test("a wrong type names both sides, so the fix needs no guessing", () => {
    const { props, issues } = validatePageProps("table", {
      dataset: "deals",
      pageSize: "twenty",
    });
    expect(props).toEqual({ dataset: "deals" });
    expect(issues[0]?.message).toBe(
      'dropped prop "pageSize" — expected number, received string',
    );
  });

  test("an unknown component type reports once and keeps nothing", () => {
    const { props, issues } = validatePageProps("carousel", { items: [] });
    expect(props).toEqual({});
    expect(issues).toEqual([{ message: 'unknown component type "carousel"' }]);
  });

  /**
   * The regression this pair exists for: a binding is legal wherever a value
   * is, and checking only the TOP of a prop silently deleted every list whose
   * items were computed — a detail panel, a timeline, a set of columns.
   */
  test("a binding nested inside an array item survives", () => {
    const items = [
      { label: "Stage", value: { $: "item.stage" } },
      { label: "Owner", value: "Ada" },
    ];
    const { props, issues } = validatePageProps("key_values", { items });
    expect(props.items).toBe(items);
    expect(issues).toEqual([]);
  });

  test("a nested binding does not wave the rest of the item through", () => {
    const { props, issues } = validatePageProps("key_values", {
      items: [{ label: "Stage", value: { $: "item.stage" } }, { value: "Ada" }],
    });
    expect(props).toEqual({});
    // Item 0 is legal — its binding must not be blamed for item 1's fault.
    expect(issues[0]?.message).toBe(
      'dropped prop "items" at 1/label — expected string, received undefined',
    );
  });

  test("nested object props are validated, not waved through", () => {
    const ok = validatePageProps("key_values", {
      items: [{ label: "Owner", value: "Ada" }],
      columns: 2,
    });
    expect(ok.issues).toEqual([]);

    const bad = validatePageProps("key_values", {
      items: [{ value: "Ada" }],
    });
    expect(bad.props).toEqual({});
    expect(bad.issues[0]?.message).toBe(
      'dropped prop "items" at 0/label — expected string, received undefined',
    );
  });
});
