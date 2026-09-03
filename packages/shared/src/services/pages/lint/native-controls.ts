import type { PageLintFinding } from "./types";
import { hasProp, templateElements } from "./walk-template";

/**
 * A native control where a component belongs.
 *
 * Measured, not suspected: of two production pages read back in Langfuse, one
 * carried 5 `<select>` and no `USelect`, 16 `<button>` and 2 `UButton`; the
 * other 5 `<table>` and no `UTable` (2026-08-26/28). Nobody asked for those —
 * the model reached for HTML because HTML is what it writes most, and the
 * result ignores the design tokens, loses the focus and keyboard behaviour the
 * rest of the app has, and looks foreign next to every other screen.
 *
 * `blocking`, not `error`: the page WORKS, so refusing the build would trade a
 * working page for none. It fails the review instead, which is the channel that
 * already means "a person would hit this".
 *
 * A control the runtime cannot replace is not on this list. `<a href>` stays
 * (the host routes it), and so does every layout tag — this is about controls.
 */

const REPLACEMENT: Record<string, string> = {
  select: "USelect or USelectMenu",
  input: "UInput (UCheckbox, URadioGroup, USwitch, UInputDate for their types)",
  textarea: "UTextarea, or UEditor when the text is read formatted",
  button: "UButton",
  table: "UTable",
  dialog: "UModal, USlideover or UDrawer",
  progress: "UProgress",
  details: "UCollapsible or UAccordion",
};

/**
 * The exception that is not a violation: a bare `<input>` inside a Nuxt UI
 * component's own slot is sometimes the documented way to reach a native
 * behaviour (a file picker). One tag, one behaviour, and no component covers
 * it — so `type="file"` is allowed through.
 */
const isAllowedInput = (element: { props: unknown[] }): boolean => {
  for (const prop of element.props) {
    if (typeof prop !== "object" || prop === null) continue;
    if (Reflect.get(prop, "name") !== "type") continue;
    const value = Reflect.get(prop, "value");
    if (typeof value !== "object" || value === null) continue;
    if (Reflect.get(value, "content") === "file") return true;
  }
  return false;
};

export const lintNativeControls = (
  path: string,
  source: string,
): PageLintFinding[] => {
  const findings: PageLintFinding[] = [];
  for (const element of templateElements(source)) {
    const replacement = REPLACEMENT[element.tag];
    if (replacement === undefined) continue;
    if (element.tag === "input" && isAllowedInput(element)) continue;
    findings.push({
      path,
      line: element.line,
      rule: "native-controls",
      severity: "blocking",
      message: `<${element.tag}> is a native control — use ${replacement}. Native controls ignore the app's design system and its keyboard behaviour.`,
    });
  }
  return findings;
};

/**
 * A toggle whose state exists only in a colour.
 *
 * The review clicks what looks clickable and re-reads the DOM. A button that
 * carries its state in a class and nothing else therefore reads as a control
 * that changed nothing — measured twice as a blocking "clicking X changes
 * nothing" against pages whose toggles worked perfectly (2026-08-26/28). The
 * fix is one attribute, and it is also what a screen reader needs.
 *
 * A warning, and a narrow one: a toggle is a CLICKABLE control that draws two
 * states, so both signals are required. A `UBadge` whose colour comes from the
 * row's status is the shape this would otherwise flag by the hundred, and it is
 * not a toggle — it is a value wearing its colour, exactly as the doctrine asks.
 */
const TOGGLE_HINT_PROPS = ["variant", "color"];

const boundProp = (
  element: { props: unknown[] },
  names: readonly string[],
): boolean =>
  element.props.some((prop) => {
    if (typeof prop !== "object" || prop === null) return false;
    const arg = Reflect.get(prop, "arg");
    return (
      typeof arg === "object" &&
      arg !== null &&
      names.includes(String(Reflect.get(arg, "content")))
    );
  });

export const lintToggleState = (
  path: string,
  source: string,
): PageLintFinding[] => {
  const findings: PageLintFinding[] = [];
  for (const element of templateElements(source)) {
    if (element.tag !== "UButton") continue;
    // Clickable AND drawing two states: either alone is an ordinary button.
    if (!boundProp(element, ["click"])) continue;
    if (!boundProp(element, TOGGLE_HINT_PROPS)) continue;
    if (
      hasProp(element, "aria-pressed") ||
      hasProp(element, "aria-selected") ||
      hasProp(element, "aria-current")
    ) {
      continue;
    }
    findings.push({
      path,
      line: element.line,
      rule: "toggle-state",
      severity: "warning",
      message: `<${element.tag}> draws a state with a bound variant/color but declares none — add :aria-pressed (or :aria-current for the active item of a list). Without it the review reads a working toggle as a control that does nothing.`,
    });
  }
  return findings;
};
