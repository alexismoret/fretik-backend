import { defaultBuildLogger, Template } from "e2b";
import { readFileSync } from "node:fs";

/**
 * Build script for the `fretik-sandbox` E2B template. Run with:
 *   bun run e2b:build              # cached build (fast on no-op)
 *   bun run e2b:build --no-cache   # force a full rebuild from scratch
 *
 * The `:latest` tag is reassigned automatically so
 * `Sandbox.create('fretik-sandbox')` always picks up the freshest build.
 */

/**
 * `--no-cache` (or `--skip-cache`) forces E2B to rebuild every layer
 * from scratch — useful when an apt mirror, a pip resolver, or a
 * transient network blip cached a broken intermediate state.
 */
const skipCache =
  process.argv.includes("--no-cache") || process.argv.includes("--skip-cache");

const requirements = readFileSync(
  new URL("./requirements.txt", import.meta.url),
  "utf-8",
)
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

/**
 * Fretik skill loader — pre-installed at /opt/fretik/skill_loader.py
 * and exposed to every Python invocation in the sandbox via a
 * site-packages `.pth` file. Stable across all conversations;
 * bundled skills themselves are pushed per-conversation by
 * `lib/conversation-storage.ts` to /workspace/skills/.
 *
 * Read at build time and embedded in the install runCmd via a
 * shell heredoc so any changes only require a template rebuild.
 */
const skillLoaderSource = readFileSync(
  new URL("./skill_loader.py", import.meta.url),
  "utf-8",
);

const tmpl = Template()
  // Extend `code-interpreter-v1`, E2B's official base for the
  // `@e2b/code-interpreter` SDK. It ships:
  //   - Python + the Jupyter kernel daemon listening on port 49999
  //     (mandatory — `Sandbox.runCode()` POSTs to that port; without it
  //     you get the "sandbox is running but port is not open" 502),
  //   - the `user` (uid:gid 1000:1000) non-root account E2B uses,
  //   - the common scientific libs (pandas, numpy, …) already
  //     pip-installed.
  // We layer our extra pinned deps on top via pipInstall — pip is a
  // no-op for already-installed matching versions.
  .fromTemplate("code-interpreter-v1")
  // System packages needed by the bundled Office / PDF skills:
  //   - pandoc            → docx skill: free-form text/markdown conversion
  //   - libreoffice-core  → docx / pptx / xlsx skills: visual conversion to
  //                         PDF/PNG + xlsx formula recalculation (recalc.py)
  //   - poppler-utils     → pdf / pptx skills: PDF→PNG (pdftoppm) for thumbnails
  //                         and visual verification of generated outputs
  //   - xxd, file         → byte/type inspection of generated outputs (BOM,
  //                         encoding, magic bytes) in ONE bash call, instead of
  //                         a hand-rolled Python hex loop that is easy to get
  //                         wrong — `xxd` is not in the base image.
  //   - tesseract-ocr     → pdf skill: the OCR path prescribes `pytesseract`,
  //                         which is only a wrapper — without this binary it
  //                         imports fine and then fails at the first call.
  // `--no-install-recommends` keeps the layer small (libreoffice's
  // suggested deps add ~400MB of unused packages).
  .runCmd(
    [
      "apt-get update",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends pandoc libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils xxd file tesseract-ocr",
      "apt-get clean",
      "rm -rf /var/lib/apt/lists/*",
    ].join(" && "),
    { user: "root" },
  )
  .pipInstall(requirements)
  // Node libraries the bundled Office skills prescribe BY NAME. The base
  // image already ships node + npm (v20 / v10, measured), so only the
  // packages are missing.
  //   - pptxgenjs                         → pptx skill, "create from scratch"
  //   - docx                              → docx skill, JS generation path
  //   - react / react-dom / react-icons / sharp → pptx skill, icon rendering
  // Installed under a FIXED prefix instead of npm's default, which differs
  // between base images, so `NODE_PATH` can point at it deterministically
  // (set in `acquire-sandbox.ts`). That env var is load-bearing: a global
  // install is otherwise INVISIBLE to `require("pptxgenjs")` from /workspace,
  // because Node only walks `node_modules` upward from the script's own
  // directory. Pre-baking these keeps the documented path working with zero
  // network; the npm registry is allowlisted only for what goes beyond them.
  .runCmd(
    "npm install -g --prefix /opt/fretik/node pptxgenjs docx react react-dom react-icons sharp",
    { user: "root" },
  )
  // The base image already provides the `user` account; we just need
  // /workspace owned by it. Privileged steps require `user: "root"`
  // because runCmd defaults to the unprivileged user.
  .runCmd(
    "mkdir -p /workspace && chown 1000:1000 /workspace && chmod 755 /workspace",
    { user: "root" },
  )
  // Install the Fretik skill loader at a system location and put it
  // on every Python interpreter's sys.path via a `.pth` file in the
  // first site-packages directory. Heredoc uses single-quoted
  // delimiter so $ in the Python source isn't expanded by the shell.
  .runCmd(
    [
      "mkdir -p /opt/fretik",
      `cat > /opt/fretik/skill_loader.py << 'FRETIK_LOADER_EOF'`,
      skillLoaderSource,
      `FRETIK_LOADER_EOF`,
      "chmod 644 /opt/fretik/skill_loader.py",
      `echo /opt/fretik > "$(python3 -c 'import site; print(site.getsitepackages()[0])')/fretik-skills.pth"`,
    ].join("\n"),
    { user: "root" },
  )
  .setUser("user")
  .setWorkdir("/workspace");

const buildLogger = defaultBuildLogger({ minLevel: "info" });

if (skipCache) {
  console.log("[e2b:build] --no-cache flag set, forcing full rebuild");
}

// Tag with both `default` (the tag E2B resolves to when `Sandbox.create`
// is called with a tag-less name like `fretik-sandbox`) AND `latest`
// (familiar Docker convention, useful for explicit `fretik-sandbox:latest`
// references). Both point at the same build.
const info = await Template.build(tmpl, "fretik-sandbox", {
  cpuCount: 1,
  memoryMB: 1536,
  skipCache,
  tags: ["default", "latest"],
  onBuildLogs: buildLogger,
});

console.log(
  `[e2b:build] template ready — name=${info.name} templateId=${info.templateId} buildId=${info.buildId} tags=${info.tags.join(",")}`,
);
