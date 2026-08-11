import { describe, expect, test } from "bun:test";
import { runSandboxedJs } from "../../src/lib/js-sandbox";

/**
 * The sandbox's boundary, asserted rather than assumed.
 *
 * This is the file that has to fail loudly if the engine, its version, or the
 * way a context is built ever changes: everything below is what makes it safe
 * to run model-written code on a route an anonymous visitor can reach.
 *
 * Three properties, in order of how badly a regression would hurt:
 *
 *  1. NO ESCAPE — a context has the language and nothing of the host. Not a
 *     denylist: there is no host object to reach, because none is handed in.
 *  2. NO RUNAWAY — an infinite loop and an allocation bomb both end, bounded
 *     by wall-clock and by heap, so one bad transform cannot hold a server.
 *  3. NO SURPRISE — a failure comes back as a readable message the agent can
 *     act on, never as a throw, and never as an empty result that reads like
 *     "the query found nothing".
 */

const run = (code: string, data: Record<string, unknown> = {}) =>
  runSandboxedJs({ code, data, state: {} });

describe("no escape — the context holds the language and nothing else", () => {
  const hostGlobals = [
    "fetch",
    "require",
    "process",
    "setTimeout",
    "setInterval",
    "Bun",
    "WebAssembly",
    "importScripts",
    "XMLHttpRequest",
  ];

  test.each(hostGlobals)("%s is undefined", async (name) => {
    const result = await run(`return typeof ${name};`);
    expect(result).toEqual({ ok: true, value: "undefined" });
  });

  test("the whole global surface is plain ECMAScript", async () => {
    // The strongest form of the claim: not "these names are missing" but "these
    // are ALL the names there are". If a future engine or build ever injects a
    // host binding, this is the line that fails.
    const result = await run(
      "return Object.getOwnPropertyNames(globalThis).sort();",
    );
    expect(result.ok).toBe(true);
    const globals = result.ok ? (result.value as string[]) : [];
    // Written out rather than derived from the HOST's own globals — deriving it
    // would quietly bless `Bun` and `WebAssembly`, since the host has them too.
    // This is the measured contents of a fresh context, and nothing else.
    expect(globals).toEqual([
      "AggregateError",
      "Array",
      "ArrayBuffer",
      "BigInt",
      "BigInt64Array",
      "BigUint64Array",
      "Boolean",
      "DataView",
      "Date",
      "Error",
      "EvalError",
      "FinalizationRegistry",
      "Float16Array",
      "Float32Array",
      "Float64Array",
      "Function",
      "Infinity",
      "Int16Array",
      "Int32Array",
      "Int8Array",
      "InternalError",
      "Iterator",
      "JSON",
      "Map",
      "Math",
      "NaN",
      "Number",
      "Object",
      "Promise",
      "Proxy",
      "RangeError",
      "ReferenceError",
      "Reflect",
      "RegExp",
      "Set",
      "SharedArrayBuffer",
      "String",
      "Symbol",
      "SyntaxError",
      "TypeError",
      "URIError",
      "Uint16Array",
      "Uint32Array",
      "Uint8Array",
      "Uint8ClampedArray",
      "WeakMap",
      "WeakRef",
      "WeakSet",
      "decodeURI",
      "decodeURIComponent",
      "encodeURI",
      "encodeURIComponent",
      "escape",
      "eval",
      "globalThis",
      "isFinite",
      "isNaN",
      "parseFloat",
      "parseInt",
      "undefined",
      "unescape",
    ]);
  });

  test("an async escape never runs — the job queue is never pumped", async () => {
    // `import()` returns a promise that stays pending forever: nothing drains
    // the microtask queue between the call and the dispose. So even a mechanism
    // that COULD reach a module never gets its continuation run — which is the
    // real reason the synchronous contract is a feature and not a limitation.
    const result = await run(
      "var reached = 'no'; import('node:fs').then(function () { reached = 'yes'; }, function () { reached = 'rejected'; }); return { reached: reached };",
    );
    expect(result).toEqual({ ok: true, value: { reached: "no" } });
  });

  test("the Function constructor builds a function scoped to the guest", async () => {
    // `(function(){}).constructor` IS `Function` inside the guest — the classic
    // sandbox escape. It works, and it reaches the guest's own global scope,
    // which holds nothing.
    const result = await run(
      "return (function(){}).constructor('return typeof fetch')();",
    );
    expect(result).toEqual({ ok: true, value: "undefined" });
  });

  test("eval reaches the same empty scope", async () => {
    expect(await run("return eval('typeof process');")).toEqual({
      ok: true,
      value: "undefined",
    });
  });

  test("the language itself still works — this is a sandbox, not a cage", async () => {
    const result = await run(
      "return data.rows.filter(r => r.n > 1).map(r => ({ n: r.n * 2, at: new Date(0).toISOString() }));",
      { rows: [{ n: 1 }, { n: 2 }, { n: 3 }] },
    );
    expect(result).toEqual({
      ok: true,
      value: [
        { n: 4, at: "1970-01-01T00:00:00.000Z" },
        { n: 6, at: "1970-01-01T00:00:00.000Z" },
      ],
    });
  });
});

describe("no runaway", () => {
  test("an infinite loop ends at the deadline", async () => {
    const startedAt = performance.now();
    const result = await runSandboxedJs({
      code: "while (true) {}",
      data: {},
      state: {},
      limits: { timeoutMs: 200 },
    });
    const elapsed = performance.now() - startedAt;
    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(2000);
  });

  test("an allocation bomb hits the heap ceiling", async () => {
    const result = await runSandboxedJs({
      code: "var a = []; for (;;) { a.push('x'.repeat(1000)); } ",
      data: {},
      state: {},
      limits: { memoryLimitBytes: 8 * 1024 * 1024, timeoutMs: 4000 },
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("memory");
  });

  test("an input past the ceiling is refused BEFORE the VM is built", async () => {
    // The cost is linear in payload — ~35 ms per MB of synchronous, event-loop
    // blocking work — so the input is where it has to be stopped.
    const rows = Array.from({ length: 20_000 }, (_, i) => ({
      id: `record_number_${i.toString()}`,
      label: "a label long enough to matter when multiplied by twenty thousand",
    }));
    const result = await runSandboxedJs({
      code: "return data.rows.length;",
      data: { rows },
      state: {},
      limits: { maxInputBytes: 64 * 1024 },
    });
    expect(result.ok).toBe(false);
    // The message has to say what to do instead — it is what the agent reads.
    expect(result.ok ? "" : result.error).toContain("Aggregate in the query");
  });

  test("an output past the ceiling is refused", async () => {
    const result = await runSandboxedJs({
      code: "var a = []; for (var i = 0; i < 20000; i++) a.push({ s: 'xxxxxxxxxxxxxxxxxxxx' }); return a;",
      data: {},
      state: {},
      limits: { maxOutputBytes: 32 * 1024 },
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("ceiling");
  });

  test("fifty concurrent runs all complete", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => run(`return ${i.toString()} * 2;`)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => (r.ok ? r.value : null))).toEqual(
      Array.from({ length: 50 }, (_, i) => i * 2),
    );
  });
});

describe("no surprise — every failure is a readable message, never a throw", () => {
  test("a thrown error keeps its own text", async () => {
    const result = await run("throw new Error('boom');");
    expect(result).toEqual({ ok: false, error: "Error: boom" });
  });

  test("a syntax error names the syntax", async () => {
    const result = await run("return (;");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("SyntaxError");
  });

  test("returning nothing is an error, not an empty result", async () => {
    // `JSON.stringify(undefined)` is the string "undefined". Passing that on
    // would produce a dataset that looks like a query with no matches.
    for (const code of ["return;", "return function () {};", "var x = 1;"]) {
      const result = await run(code);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error).toContain("nothing JSON can carry");
    }
  });

  test("null is a legitimate answer and comes back as null", async () => {
    expect(await run("return null;")).toEqual({ ok: true, value: null });
  });

  test("state is readable, and only what was passed in", async () => {
    const result = await runSandboxedJs({
      code: "return [{ month: state.month, other: typeof state.secret }];",
      data: {},
      state: { month: "2026-08" },
    });
    expect(result).toEqual({
      ok: true,
      value: [{ month: "2026-08", other: "undefined" }],
    });
  });

  test("nothing crosses by reference — mutating the input cannot reach the host", async () => {
    const rows = [{ n: 1 }];
    const result = await runSandboxedJs({
      code: "data.rows[0].n = 999; return data.rows;",
      data: { rows },
      state: {},
    });
    expect(result).toEqual({ ok: true, value: [{ n: 999 }] });
    // The host's own array is untouched: the guest mutated its own parse.
    expect(rows[0]?.n).toBe(1);
  });
});
