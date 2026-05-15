import { execSync } from "node:child_process";

if (process.env.HUSKY === "0" || process.env.CI === "true") process.exit(0);

let path = "";
try {
  path = execSync("git config --get core.hooksPath", { encoding: "utf8" }).trim();
} catch {
  // not a git repo (e.g. install inside a tarball) — skip
  process.exit(0);
}

if (path !== ".husky/_") {
  console.error(
    `\n❌ Husky hooks are not installed (core.hooksPath="${path}").` +
      `\n   Pre-commit and pre-push checks will NOT run.` +
      `\n   Fix: bunx husky\n`,
  );
  process.exit(1);
}
