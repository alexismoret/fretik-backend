import type { ExternalAppDescriptor } from "@fretik/shared/schemas/external-app-descriptor";
import { describe, expect, test } from "bun:test";
import { compileMcpModule } from "../../src/codegen/mcp-python-sdk";

/**
 * MCP `inputSchema`s carry ECMAScript regexes that the compiler drops verbatim
 * into Pydantic `Field(pattern=...)`. Pydantic compiles the pattern eagerly at
 * class definition, so a JS-only construct (`\p{...}`, named-group spelling)
 * used to raise `re.error` and crash the WHOLE generated module's import —
 * taking every tool of that app offline. These tests pin the fix: patterns are
 * emitted through the `_safe_pattern` runtime guard (degrades to no constraint
 * instead of crashing), the two safely-translatable JS spellings are converted
 * to Python, and numeric constraints Pydantic rejects are dropped.
 */

/** Build a one-read-tool MCP descriptor whose single string prop carries `prop`. */
const compileWithProp = (prop: Record<string, unknown>): string => {
  const descriptor: ExternalAppDescriptor = {
    key: "acme-mcp",
    displayName: "Acme",
    source: "mcp",
    transport: "mcp",
    fingerprint: "test-fingerprint",
    categories: ["productivity"],
    types: {},
    triggers: [],
    actions: [
      {
        name: "do_thing",
        kind: "read",
        kindSource: "annotation",
        summary: "Do a thing.",
        approvalDefault: "auto",
        params: {},
        returns: { void: true },
        mcpToolName: "do-thing",
      },
    ],
  };
  const toolSchemas: Record<string, unknown> = {
    "do-thing": {
      type: "object",
      properties: { field: prop },
      required: ["field"],
    },
  };
  return compileMcpModule(descriptor, toolSchemas).sdkPy;
};

describe("compileMcpModule — regex patterns", () => {
  test("emits patterns through the _safe_pattern runtime guard, never bare", () => {
    const py = compileWithProp({ type: "string", pattern: "^[a-z0-9-]+$" });
    expect(py).toContain('pattern=_safe_pattern("^[a-z0-9-]+$")');
    // No bare `pattern="..."` that Pydantic would compile eagerly.
    expect(py).not.toContain('pattern="^[a-z0-9-]+$"');
  });

  test("imports _safe_pattern from the runtime", () => {
    const py = compileWithProp({ type: "string", pattern: "^x$" });
    expect(py).toContain(
      "from ._runtime import FretikActionError, Operation, _call_read, _safe_pattern",
    );
  });

  test("a Python-incompatible pattern (\\p{...}) still compiles to valid source", () => {
    // Invalid under Python's `re`; must NOT crash codegen and must be wrapped
    // so the crash is deferred to `_safe_pattern` (which returns None).
    const py = compileWithProp({ type: "string", pattern: "\\p{L}+" });
    expect(py).toContain("pattern=_safe_pattern(");
    // The backslash survives JSON string escaping so Python sees `\p{L}+`.
    expect(py).toContain('_safe_pattern("\\\\p{L}+")');
  });

  test("translates JS named groups to Python spelling in the enforced pattern", () => {
    // The Field carries the translated (compilable) form; the docstring's human
    // hint keeps the original ECMAScript spelling — that's informational only.
    const py = compileWithProp({ type: "string", pattern: "(?<year>\\d{4})" });
    expect(py).toContain('_safe_pattern("(?P<year>\\\\d{4})")');
  });

  test("translates JS named backreferences to Python spelling", () => {
    const py = compileWithProp({
      type: "string",
      pattern: "(?<a>x)\\k<a>",
    });
    expect(py).toContain("(?P<a>x)(?P=a)");
  });

  test("leaves lookbehind untouched (identical in both engines)", () => {
    const py = compileWithProp({ type: "string", pattern: "(?<=\\$)\\d+" });
    expect(py).toContain("(?<=");
    expect(py).not.toContain("(?P<=");
  });

  test("drops multiple_of <= 0 rather than crashing Pydantic", () => {
    const py = compileWithProp({ type: "number", multipleOf: 0 });
    expect(py).not.toContain("multiple_of=0");
  });

  test("keeps a valid multiple_of", () => {
    const py = compileWithProp({ type: "number", multipleOf: 5 });
    expect(py).toContain("multiple_of=5");
  });

  test("drops a negative min_length rather than crashing Pydantic", () => {
    const py = compileWithProp({ type: "string", minLength: -1 });
    expect(py).not.toContain("min_length=-1");
  });
});
