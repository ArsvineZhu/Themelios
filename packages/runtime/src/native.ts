import { createRequire } from "node:module";
import { join } from "node:path";
import { failure } from "./failure.js";

interface LockHandle {
  close(): void;
}

interface Native {
  InstanceLock: { acquire(path: string): LockHandle };
}

const require = createRequire(import.meta.url);
let addon: Native | undefined;

function load(): Native {
  if (addon) return addon;
  const { platform, arch } = process;
  const glibc =
    platform === "linux"
      ? Boolean(
          (
            process.report.getReport() as {
              header?: { glibcVersionRuntime?: string };
            }
          ).header?.glibcVersionRuntime,
        )
      : false;
  const target =
    platform === "win32" && arch === "x64"
      ? "windows-x64-msvc"
      : glibc && arch === "x64"
        ? "linux-x64-gnu"
        : `${platform}-${arch}`;
  const modulePath = join(
    import.meta.dir,
    "..",
    "native",
    target,
    "themelios_runtime.node",
  );
  try {
    addon = require(modulePath) as Native;
    return addon;
  } catch (error) {
    throw failure(
      "runtime.native_unavailable",
      { target, runtimeVersion: Bun.version, modulePath },
      error,
    );
  }
}

export function acquireLock(path: string): LockHandle | undefined {
  const native = load();
  try {
    return native.InstanceLock.acquire(path);
  } catch (error) {
    if (error instanceof Error && error.message === "instance_busy")
      return undefined;
    throw failure("runtime.lock_failed", { path }, error);
  }
}
