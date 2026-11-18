import { delimiter, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const bin = join(import.meta.dir, "node_modules", ".bin");
const command = join(bin, process.platform === "win32" ? "buf.exe" : "buf");
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
);
const generator = Bun.spawn(
  [command, "generate", "--template", join(import.meta.dir, "buf.gen.yaml")],
  {
    cwd: root,
    env: { ...environment, PATH: bin + delimiter + (process.env.PATH ?? "") },
    stdout: "inherit",
    stderr: "inherit",
  },
);
const code = await generator.exited;
if (code) process.exit(code);
for await (const path of new Bun.Glob("src/grpc/generated/**/*_pb.ts").scan(
  import.meta.dir,
)) {
  const file = Bun.file(join(import.meta.dir, path));
  await Bun.write(file, (await file.text()).trimEnd() + "\n");
}
