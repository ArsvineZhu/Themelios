import { resolve } from "node:path";

const release = Bun.argv[2];
if (!release) {
  throw new Error(
    "Run bun install-release.ts <directory containing Themelios tarballs>",
  );
}

const consumer = process.cwd();
const manifestPath = resolve(consumer, "package.json");
const manifest = (await Bun.file(manifestPath).json()) as {
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};
const dependencies = manifest.dependencies ?? {};
const overrides: Record<string, string> = {};
const releasePath = resolve(release);

for (const file of new Bun.Glob("themelios-*.tgz").scanSync({
  cwd: releasePath,
  onlyFiles: true,
})) {
  const match = /^themelios-([a-z0-9-]+)-\d+\.\d+\.\d+.*\.tgz$/.exec(file);
  if (!match) continue;
  const packageName = `@themelios/${match[1]!}`;
  const path = resolve(releasePath, file);
  overrides[packageName] = `file:${path.replaceAll("\\", "/")}`;
}

if (Object.keys(overrides).length === 0) {
  throw new Error(`No @themelios tarballs found in ${releasePath}`);
}

let matchedDependency = 0;
for (const dependency of Object.keys(dependencies)) {
  if (!dependency.startsWith("@themelios/")) continue;
  const tarball = overrides[dependency];
  if (!tarball) {
    throw new Error(
      `Missing release tarball for ${dependency} in ${releasePath}`,
    );
  }
  dependencies[dependency] = tarball;
  matchedDependency++;
}
if (matchedDependency === 0) {
  throw new Error(`No @themelios dependencies in ${manifestPath}`);
}

manifest.overrides = { ...manifest.overrides, ...overrides };
await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const child = Bun.spawn([process.execPath, "install"], {
  cwd: consumer,
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
