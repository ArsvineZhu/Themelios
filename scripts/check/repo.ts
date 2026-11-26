import { existsSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { buildPackages } from "../build-packages.js";
import { orderedWorkspaces, repoRoot, run, workspaces } from "../workspaces.js";
import { checkBoundaries } from "./boundaries.js";

const names = process.argv.slice(2).filter((arg) => arg !== "--");
const bun = process.execPath;
const quiet = { quiet: true };
const labels = names.join(" ");

try {
  const all = await workspaces();
  const selected = orderedWorkspaces(all, names);
  const targeted = new Set(
    selected.filter(
      (pkg) =>
        !names.length ||
        names.includes(pkg.manifest.name) ||
        names.includes(basename(pkg.root)),
    ),
  );
  const git = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repoRoot },
  );
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  const files = git.stdout
    .toString()
    .split("\0")
    .filter(
      (path) =>
        path &&
        !path.includes("/generated/") &&
        !path.startsWith("docs/plans/") &&
        existsSync(join(repoRoot, path)),
    );
  const roots = [...targeted].map((pkg) =>
    relative(repoRoot, pkg.root).replaceAll("\\", "/"),
  );
  const scope = files.filter(
    (path) =>
      !names.length ||
      roots.some((root) => path.startsWith(root + "/")) ||
      (path.startsWith("tests/") &&
        names.some((name) =>
          path.includes("/" + name.split("/").at(-1) + "/"),
        )),
  );
  const code = scope.filter((path) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(path));
  const tests = scope.filter(
    (path) => path.startsWith("tests/") && path.endsWith(".test.ts"),
  );
  await buildPackages(names, true);
  // The package build checks workspaces. The root project checks scripts,
  // tests, and examples against the emitted declarations.
  if (!names.length)
    await run(
      [bun, "check", "--no-script", "--no-pretty", "-p", repoRoot],
      quiet,
    );
  if (code.length) {
    await run([bun, "fmt", "--check", ...code], { ...quiet, label: "bun fmt" });
    await run([bun, "x", "--no-install", "oxlint", "--format=agent", ...code], {
      ...quiet,
      label: "oxlint",
    });
  }
  const python = process.platform === "win32" ? "python" : "python3";
  const lengthFiles = names.length
    ? scope.filter((path) => /\.(?:rs|py|tsx?|[mc]?js)$/.test(path))
    : [];
  if (!names.length || lengthFiles.length)
    await run(
      [python, "-B", "scripts/check/manage.py", "length", ...lengthFiles],
      { ...quiet, label: "Source length check" },
    );
  await checkBoundaries([...targeted]);
  if (tests.length)
    await run([bun, "test", "--agent", ...tests], {
      ...quiet,
      label: "bun test",
    });
  console.log(
    "Themelios checks passed" + (labels ? " for " + labels : "") + ".",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Rerun: bun run check:repo" + (labels ? " -- " + labels : ""));
  process.exitCode = 1;
}
