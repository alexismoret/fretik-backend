import type { ModelMessage } from "ai";
import { describe, expect, test } from "bun:test";
import {
  EMITTED_SOURCE_SENTINEL,
  lastVueFence,
  resolveEmittedSource,
} from "../../../src/tools/page-emitted-source";

/**
 * The transport half of the page builder: source travels as streamed text and
 * is read back from the model's own transcript one step later.
 *
 * Every case here is a way the read-back can pick the WRONG bytes, and each
 * one saves a wrong page over a right one — a failure with no error message
 * anywhere, since a wrong SFC compiles exactly as well as the intended one.
 */

const fenced = (body: string): string => `\`\`\`vue\n${body}\n\`\`\``;
const PAGE =
  "<template>\n  <div>Deals</div>\n</template>\n<script setup></script>";

describe("lastVueFence", () => {
  test("returns the body of a closed vue fence", () => {
    expect(lastVueFence(`Here it is:\n${fenced(PAGE)}\nSaving now.`)).toBe(
      PAGE,
    );
  });

  test("the LAST complete page wins — a rewrite supersedes its draft", () => {
    const first = "<template><div>v1</div></template>";
    const text = `${fenced(first)}\n\nOn reflection:\n${fenced(PAGE)}`;
    expect(lastVueFence(text)).toBe(PAGE);
  });

  test("a fragment quoted while reasoning is not a page", () => {
    const quoted = fenced('<UButton label="Save" />');
    expect(lastVueFence(`The card renders ${quoted}, which is wrong.`)).toBe(
      null,
    );
  });

  test("a fragment after the page does not displace it", () => {
    const text = `${fenced(PAGE)}\n\nThe header is ${fenced("<UBadge />")}`;
    expect(lastVueFence(text)).toBe(PAGE);
  });

  test("an unterminated fence resolves to nothing", () => {
    // The shape of a generation cut mid-write. Half an SFC compiles to
    // nothing; saving it would turn a recoverable run into a broken page.
    expect(lastVueFence(`\`\`\`vue\n${PAGE}`)).toBe(null);
  });

  test("other languages are ignored", () => {
    expect(lastVueFence("```ts\nconst a = 1\n```")).toBe(null);
    expect(lastVueFence("```html\n<template><div/></template>\n```")).toBe(
      null,
    );
  });

  test("no fence at all", () => {
    expect(lastVueFence("I will write the dashboard now.")).toBe(null);
  });
});

describe("resolveEmittedSource", () => {
  const assistant = (content: string): ModelMessage => ({
    role: "assistant",
    content,
  });

  test("reads the fence from the most recent assistant message", () => {
    expect(
      resolveEmittedSource([
        assistant(fenced("<template><div>old</div></template>")),
        { role: "user", content: "now the real one" },
        assistant(fenced(PAGE)),
      ]),
    ).toBe(PAGE);
  });

  test("reads a fence carried in content PARTS, not just a string", () => {
    expect(
      resolveEmittedSource([
        {
          role: "assistant",
          content: [
            { type: "text", text: `Writing it now:\n${fenced(PAGE)}` },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "managePage",
              input: { action: "stage" },
            },
          ],
        },
      ]),
    ).toBe(PAGE);
  });

  test("NEVER resolves to a source that came back from a tool", () => {
    // `get` returns a whole page and `components` returns worked examples.
    // Resolving to one of those saves the wrong file with no error anywhere.
    expect(
      resolveEmittedSource([
        assistant(fenced(PAGE)),
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "managePage",
              output: {
                type: "text",
                value: fenced("<template><div>stored</div></template>"),
              },
            },
          ],
        },
      ]),
    ).toBe(PAGE);
  });

  test("a user pasting an SFC does not count as the builder emitting one", () => {
    expect(
      resolveEmittedSource([{ role: "user", content: fenced(PAGE) }]),
    ).toBe(null);
  });

  test("no fence anywhere, and no messages at all", () => {
    expect(resolveEmittedSource([assistant("Let me probe the data.")])).toBe(
      null,
    );
    expect(resolveEmittedSource([])).toBe(null);
    expect(resolveEmittedSource(undefined)).toBe(null);
  });

  test("the sentinel is a value no SFC can collide with", () => {
    expect(EMITTED_SOURCE_SENTINEL).toBe("@emitted");
  });
});
