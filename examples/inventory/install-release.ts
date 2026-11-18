import { resolve } from "node:path";

const release = Bun.argv[2];
if (!release)
  throw new Error(
    "Run bun install-release.ts <directory containing Themelios tarballs>",
  );

const consumer = process.cwd();
const manifestPath = resolve(consumer, "package.json");
const manifest = (await Bun.file(manifestPath).json()) as {
  dependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};
const dependencies = manifest.dependencies ?? {};
const overrides: Record<string, string> = {};
const releasePath = resolve(release);
for (const [dependency, declared] of Object.entries(dependencies)) {
  const name = /^@themelios\/([a-z0-9-]+)$/.exec(dependency)?.[1];
  if (!name) continue;
  const version = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(declared)
    ? declared
    : undefined;
  const pattern = `themelios-${name}-${version ?? "*"}.tgz`;
  const files = Array.from(
    new Bun.Glob(pattern).scanSync({ cwd: releasePath, onlyFiles: true }),
  );
  if (files.length !== 1)
    throw new Error(
      `Expected one archive matching ${pattern} in ${releasePath}, found ${files.length}`,
    );
  const path = resolve(releasePath, files[0]!);
  const tarball = `file:${path.replaceAll("\\", "/")}`;
  dependencies[dependency] = tarball;
  overrides[dependency] = tarball;
}
if (Object.keys(overrides).length === 0)
  throw new Error(`No @themelios dependencies in ${manifestPath}`);
// The packages also depend on each other by version. Resolve those references to the same local release.
manifest.overrides = { ...manifest.overrides, ...overrides };
await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const child = Bun.spawn([process.execPath, "install"], {
  cwd: consumer,
  stdout: "inherit",
  stderr: "inherit",
});
process.exitCode = await child.exited;
