import { basename, dirname, join, resolve } from "node:path";

export const repoRoot = resolve(import.meta.dir, "..");

export interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  exports?: Record<string, { types: string; import: string }>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: { packages: string[] };
}

export interface Workspace {
  root: string;
  manifest: Manifest;
}

async function readManifest(root: string): Promise<Manifest> {
  return Bun.file(join(root, "package.json")).json() as Promise<Manifest>;
}

export async function workspaces(): Promise<Workspace[]> {
  const manifest = await readManifest(repoRoot);
  const found: Workspace[] = [];
  for (const pattern of manifest.workspaces?.packages ?? []) {
    const matches = new Bun.Glob(`${pattern}/package.json`);
    for await (const path of matches.scan({ cwd: repoRoot, onlyFiles: true })) {
      const root = join(repoRoot, dirname(path));
      found.push({ root, manifest: await readManifest(root) });
    }
  }
  return found;
}

export function orderedWorkspaces(
  all: readonly Workspace[],
  selection: readonly string[],
): Workspace[] {
  const names = new Map(all.map((pkg) => [pkg.manifest.name, pkg]));
  const visiting = new Set<Workspace>();
  const ordered = new Set<Workspace>();
  function visit(pkg: Workspace) {
    if (ordered.has(pkg)) return;
    if (visiting.has(pkg))
      throw new Error("Workspace dependency cycle: " + pkg.manifest.name);
    visiting.add(pkg);
    for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) {
      const other = names.get(dependency);
      if (other) visit(other);
    }
    visiting.delete(pkg);
    ordered.add(pkg);
  }
  for (const name of selection.length
    ? selection
    : all.map((pkg) => pkg.manifest.name)) {
    const pkg =
      names.get(name) ?? all.find((pkg) => basename(pkg.root) === name);
    if (!pkg) throw new Error("Unknown workspace package: " + name);
    visit(pkg);
  }
  return [...ordered];
}

export function exportSources(pkg: Workspace): string[] {
  return [
    ...new Set(
      Object.values(pkg.manifest.exports ?? {}).map((entry) => {
        const match = /^\.\/dist\/(.+)\.js$/.exec(entry.import);
        if (
          !match?.[1] ||
          entry.types !== "./dist/types/" + match[1] + ".d.ts"
        ) {
          throw new Error(
            pkg.manifest.name +
              " has mismatched runtime and declaration exports: " +
              entry.import,
          );
        }
        return join(pkg.root, "src", match[1] + ".ts");
      }),
    ),
  ];
}

export async function run(
  args: string[],
  options: {
    cwd?: string;
    quiet?: boolean;
    capture?: boolean;
    label?: string;
  } = {},
): Promise<string> {
  const child = Bun.spawn(args, {
    cwd: options.cwd ?? repoRoot,
    stdin: "ignore",
    stdout: options.quiet || options.capture ? "pipe" : "inherit",
    stderr: options.quiet ? "pipe" : "inherit",
  });
  const [exit, output, diagnostics] = await Promise.all([
    child.exited,
    child.stdout ? new Response(child.stdout).text() : undefined,
    child.stderr ? new Response(child.stderr).text() : undefined,
  ]);
  if (exit !== 0) {
    if (output) process.stderr.write(output);
    if (diagnostics) process.stderr.write(diagnostics);
    const command = options.label ?? args.slice(1).join(" ");
    throw new Error(`${command} exited with code ${exit}`);
  }
  return output ?? "";
}
