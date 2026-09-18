import type { UIMessage } from "ai";
import { describe, expect, test } from "bun:test";
import { presentedFilesInMessages } from "../../src/services/chat-files/presented-files";

/**
 * The transcript is the record of what the agent MEANT to hand over:
 * calling `presentFiles` is the act of handing a file over, and writing
 * one to the sandbox shows the user nothing on its own. The file panel
 * reads that back to tell a deliverable from the working-out beside it.
 */

const presentPart = (files: unknown): UIMessage["parts"][number] =>
  ({
    type: "tool-presentFiles",
    output: { files },
  }) as unknown as UIMessage["parts"][number];

const message = (parts: UIMessage["parts"]): UIMessage => ({
  id: "m",
  role: "assistant",
  parts,
});

describe("presentedFilesInMessages", () => {
  test("collects each presented file by its workspace path", () => {
    const found = presentedFilesInMessages([
      message([
        presentPart([
          {
            path: "outputs/report.xlsx",
            filename: "report.xlsx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            size: 4096,
          },
        ]),
      ]),
    ]);

    expect([...found.keys()]).toEqual(["outputs/report.xlsx"]);
    expect(found.get("outputs/report.xlsx")).toEqual({
      path: "outputs/report.xlsx",
      filename: "report.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 4096,
    });
  });

  test("a re-presented file is the same deliverable, in its latest state", () => {
    const found = presentedFilesInMessages([
      message([
        presentPart([{ path: "outputs/a.csv", filename: "a.csv", size: 10 }]),
      ]),
      message([
        presentPart([{ path: "outputs/a.csv", filename: "a.csv", size: 999 }]),
      ]),
    ]);

    expect(found.size).toBe(1);
    expect(found.get("outputs/a.csv")?.size).toBe(999);
  });

  test("a file outside outputs/ still counts — presentFiles accepts any workspace path", () => {
    // The panel used to list `outputs/` alone, so a file presented from the
    // workspace root was uploaded, announced, and then shown nowhere.
    const found = presentedFilesInMessages([
      message([
        presentPart([{ path: "manifest.f4k", filename: "manifest.f4k" }]),
      ]),
    ]);

    expect(found.has("manifest.f4k")).toBe(true);
  });

  test("other tool calls and malformed outputs contribute nothing", () => {
    const found = presentedFilesInMessages([
      message([
        { type: "text", text: "here you go" },
        {
          type: "tool-python",
          output: { files: [{ path: "x", filename: "x" }] },
        } as unknown as UIMessage["parts"][number],
        presentPart("not-an-array"),
        presentPart([{ filename: "no-path.txt" }]),
        presentPart([{ path: "no-filename.txt" }]),
        presentPart([null, 42, "nope"]),
      ]),
    ]);

    expect(found.size).toBe(0);
  });

  test("a turn that presented nothing yields an empty map", () => {
    // Load-bearing: the caller treats an empty map as "no evidence to split
    // on" and marks every file a deliverable rather than demoting them all.
    expect(presentedFilesInMessages([]).size).toBe(0);
  });
});
