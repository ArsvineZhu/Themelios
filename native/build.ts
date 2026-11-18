import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const targets = {
  win32: {
    name: "windows-x64-msvc",
    triple: "x86_64-pc-windows-msvc",
    file: "themelios_runtime.dll",
  },
  linux: {
    name: "linux-x64-gnu",
    triple: "x86_64-unknown-linux-gnu",
    file: "libthemelios_runtime.so",
  },
};
const target = targets[process.platform as keyof typeof targets];
const args = Bun.argv.slice(2).filter((arg) => arg !== "--");
const targetOption = args.indexOf("--target");
const requested =
  targetOption < 0
    ? args.find((arg) => arg.startsWith("--target="))?.slice(9)
    : args[targetOption + 1];
if (
  !target ||
  process.arch !== "x64" ||
  (args.length && requested !== target.name)
) {
  throw new Error(
    "Build the runtime lock on its target Windows x64 or Linux x64 glibc host",
  );
}
const buildDir = resolve(
  root,
  process.env.CARGO_TARGET_DIR ?? "temp/build/native",
);
const cargo = Bun.spawn(
  [
    "cargo",
    "build",
    "--release",
    "--locked",
    "--target",
    target.triple,
    "--target-dir",
    buildDir,
    "-p",
    "themelios-runtime-native",
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (await cargo.exited) process.exit(cargo.exitCode ?? 1);

const destination = join(root, "packages/runtime/native", target.name);
await mkdir(destination, { recursive: true });
await copyFile(
  join(buildDir, target.triple, "release", target.file),
  join(destination, "themelios_runtime.node"),
);
