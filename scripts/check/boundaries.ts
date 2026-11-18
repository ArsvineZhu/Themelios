import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  type Node,
  SyntaxKind,
  type StringLiteralLikeNode,
} from "typescript/unstable/ast";
import {
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isStringLiteralLikeNode,
} from "typescript/unstable/ast/is";
import { API, type Project } from "typescript/unstable/sync";
import { repoRoot, workspaces, type Workspace } from "../workspaces.js";

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}

function modules(file: Node): StringLiteralLikeNode[] {
  const names: StringLiteralLikeNode[] = [];
  function visit(node: Node) {
    let argument: Node | undefined;
    if (isImportDeclaration(node) || isExportDeclaration(node))
      argument = node.moduleSpecifier;
    else if (isImportTypeNode(node) && isLiteralTypeNode(node.argument))
      argument = node.argument.literal;
    else if (
      isCallExpression(node) &&
      (node.expression.kind === SyntaxKind.ImportKeyword ||
        (isIdentifier(node.expression) && node.expression.text === "require"))
    )
      argument = node.arguments[0];
    if (argument && isStringLiteralLikeNode(argument)) names.push(argument);
    node.forEachChild(visit);
  }
  visit(file);
  return names;
}

function dependencyName(specifier: string): string {
  return specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
}

function packageAt(path: string | undefined, workspaces: readonly Workspace[]) {
  if (!path) return;
  return workspaces.find(
    (pkg) =>
      inside(join(pkg.root, "src"), path) ||
      inside(join(pkg.root, "dist"), path),
  );
}

function relativeProblem(
  path: string,
  workspace: Workspace,
  owner?: Workspace,
): string | undefined {
  if (owner && owner.root !== workspace.root)
    return "Import " + owner.manifest.name + " through its public exports";
  if (!inside(workspace.root, path))
    return "Relative import leaves this package";
}

function dependencyProblem(
  name: string,
  workspace: Workspace,
  owner?: Workspace,
): string | undefined {
  if (owner?.root === workspace.root) return;
  const dependency = dependencyName(name);
  if (!Object.hasOwn(workspace.manifest.dependencies ?? {}, dependency)) {
    return "Declare " + dependency + " in dependencies";
  }
  if (!owner) return;
  const pkg = owner.manifest.name;
  const subpath = name === pkg ? "." : "." + name.slice(pkg.length);
  if (!Object.hasOwn(owner.manifest.exports ?? {}, subpath))
    return "Use an entry listed in " + pkg + " exports";
}

function importProblem(
  name: string,
  symbolPath: string | undefined,
  file: string,
  workspace: Workspace,
  all: readonly Workspace[],
): string | undefined {
  if (isBuiltin(name) || name.startsWith("bun:")) return;
  if (name.startsWith(".") || isAbsolute(name)) {
    const path = symbolPath ?? Bun.resolveSync(name, dirname(file));
    return relativeProblem(path, workspace, packageAt(path, all));
  }
  return dependencyProblem(name, workspace, packageAt(symbolPath, all));
}

function fileProblems(
  project: Project,
  file: string,
  workspace: Workspace,
  all: readonly Workspace[],
): string[] {
  const source = project.program.getSourceFile(file);
  if (!source) return [];
  const imports = modules(source);
  const symbols = project.checker.getSymbolAtLocation(imports);
  const issues: string[] = [];
  for (const [i, node] of imports.entries()) {
    const issue = importProblem(
      node.text,
      symbols[i]?.declarations[0]?.path,
      file,
      workspace,
      all,
    );
    if (!issue) continue;
    const line =
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    issues.push(
      relative(repoRoot, file) + ":" + line + " " + node.text + " — " + issue,
    );
  }
  return issues;
}

export async function checkBoundaries(
  selection: readonly Workspace[],
): Promise<void> {
  const all = await workspaces();
  const configs = selection.map((pkg) => join(pkg.root, "tsconfig.json"));
  const failures: string[] = [];
  const api = new API({ cwd: repoRoot });
  try {
    using snapshot = api.updateSnapshot({ openProjects: configs });
    for (const [index, config] of configs.entries()) {
      const workspace = selection[index]!;
      const project = snapshot.getProject(config);
      if (!project)
        throw new Error(
          "TypeScript did not load " + relative(repoRoot, config),
        );
      for (const file of project.rootFiles)
        failures.push(...fileProblems(project, file, workspace, all));
    }
  } finally {
    api.close();
  }
  if (failures.length) throw new Error(failures.join("\n"));
}
