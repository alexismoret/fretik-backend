/**
 * Unit tests for the `presentFiles` tool. Covers path sandboxing, the
 * read-only blocklist (skills/, drive/, context/, memories/), missing
 * files, MIME inference, and the S3 mirror call that makes a
 * generated file downloadable to the user.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
import { installSandboxMocks, sandboxFs } from "../../lib/sandbox-fixture";

installSandboxMocks();

const { createPresentFilesTool } =
  await import("../../../src/tools/present-files");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");

interface PresentFilesOutput {
  files: { path: string; filename: string; mimeType: string; size: number }[];
  message?: string;
  errors?: { path: string; code: string; message: string }[];
}

const buildOptions = (conversationId: string) => {
  const ctx = {
    organizationId: "org-1",
    teamId: "team-1",
    conversationId,
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  };
  return {
    toolCallId: `tc-${Date.now().toString()}`,
    messages: [] as never[],
    context: wrapRuntimeContext(ctx),
  };
};

const execPresent = async (
  conversationId: string,
  paths: string[],
  message?: string,
): Promise<PresentFilesOutput> => {
  const tool = createPresentFilesTool();
  if (typeof tool.execute !== "function") {
    throw new Error("presentFiles tool missing execute");
  }
  const result = await tool.execute(
    message === undefined ? { paths } : { paths, message },
    buildOptions(conversationId),
  );
  return result as PresentFilesOutput;
};

beforeEach(() => {
  sandboxFs.reset();
});

describe("presentFiles — happy path", () => {
  test("surfaces a generated file with correct metadata + S3 mirror", async () => {
    sandboxFs.write(
      "conv-1",
      "outputs/chart.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );

    const out = await execPresent("conv-1", ["outputs/chart.png"]);
    expect(out.errors).toBeUndefined();
    expect(out.files).toEqual([
      {
        path: "outputs/chart.png",
        filename: "chart.png",
        mimeType: "image/png",
        size: 4,
      },
    ]);

    // S3 mirror must have happened (sync inside execute).
    expect(sandboxFs.existsS3("conv-1", "outputs/chart.png")).toBe(true);
  });

  test("infers Office MIME types for xlsx / docx / pptx", async () => {
    sandboxFs.write("conv-2", "outputs/report.xlsx", new Uint8Array([0]));
    sandboxFs.write("conv-2", "outputs/notice.docx", new Uint8Array([0]));
    sandboxFs.write("conv-2", "outputs/deck.pptx", new Uint8Array([0]));

    const out = await execPresent("conv-2", [
      "outputs/report.xlsx",
      "outputs/notice.docx",
      "outputs/deck.pptx",
    ]);
    expect(out.files.map((f) => f.mimeType)).toEqual([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]);
  });

  test("forwards an optional message verbatim", async () => {
    sandboxFs.write("conv-3", "outputs/chart.png", new Uint8Array([0]));
    const out = await execPresent(
      "conv-3",
      ["outputs/chart.png"],
      "Voici votre graphique",
    );
    expect(out.message).toBe("Voici votre graphique");
  });
});

describe("presentFiles — read-only blocklist", () => {
  const cases: {
    label: string;
    path: string;
    head: string;
  }[] = [
    {
      label: "rejects skills/",
      path: "skills/pdf/SKILL.md",
      head: "skills",
    },
    {
      label: "rejects drive/",
      path: "drive/uuid-doc.pdf",
      head: "drive",
    },
    {
      label: "rejects context/",
      path: "context/handbook.md",
      head: "context",
    },
    {
      label: "rejects memories/",
      path: "memories/team/pricing.md",
      head: "memories",
    },
  ];

  for (const c of cases) {
    test(c.label, async () => {
      // Seed the file so the failure isn't FILE_NOT_FOUND.
      sandboxFs.write("conv-x", c.path, "x");
      const out = await execPresent("conv-x", [c.path]);
      expect(out.files.length).toBe(0);
      expect(out.errors?.length).toBe(1);
      expect(out.errors?.[0]?.code).toBe("READ_ONLY_PATH");
      expect(out.errors?.[0]?.message).toContain(`${c.head}/`);
    });
  }
});

describe("presentFiles — sandboxing", () => {
  test("rejects /etc/passwd-style absolute paths", async () => {
    const out = await execPresent("conv-y", ["/etc/passwd"]);
    expect(out.errors?.[0]?.code).toBe("PATH_OUT_OF_SANDBOX");
  });

  test("rejects ../ traversal", async () => {
    const out = await execPresent("conv-y", ["../other-conv/secret.txt"]);
    expect(out.errors?.[0]?.code).toBe("PATH_OUT_OF_SANDBOX");
  });

  test("returns FILE_NOT_FOUND when the path is valid but the file isn't there", async () => {
    const out = await execPresent("conv-z", ["outputs/ghost.png"]);
    expect(out.errors?.[0]?.code).toBe("FILE_NOT_FOUND");
  });
});

describe("presentFiles — partial success", () => {
  test("surfaces the working files and reports errors for the rest", async () => {
    sandboxFs.write("conv-mix", "outputs/chart.png", new Uint8Array([0x89]));

    const out = await execPresent("conv-mix", [
      "outputs/chart.png",
      "skills/pdf/SKILL.md",
      "outputs/ghost.png",
    ]);
    expect(out.files.length).toBe(1);
    expect(out.files[0]?.path).toBe("outputs/chart.png");
    expect(out.errors?.length).toBe(2);
    const codes = out.errors?.map((e) => e.code).sort() ?? [];
    expect(codes).toEqual(["FILE_NOT_FOUND", "READ_ONLY_PATH"]);
  });
});
