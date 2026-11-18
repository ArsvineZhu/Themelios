import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { Installation, runtimeSettings } from "@themelios/runtime";

test("an OS-held instance conflicts across processes and opens after the holder dies", async () => {
  const work = join("temp", "work");
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(join(work, "runtime-native-"));
  const app = {
    id: "test.platform",
    formatId: "test.platform/1",
    settings: runtimeSettings,
    async provision() {},
    async open() {},
  };
  const instance = Installation.at(root, app).instance("default");
  const initialized = await instance.init();
  const script = join(import.meta.dir, "held-instance.ts");
  const holder = Bun.spawn([process.execPath, script, root], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const stdout = holder.stdout.getReader();
  try {
    const output = await stdout.read();
    expect(new TextDecoder().decode(output.value).trim()).toBe("holder ready");
    await expect(instance.open()).rejects.toMatchObject({
      code: "runtime.instance_busy",
    });
  } finally {
    stdout.releaseLock();
    holder.kill("SIGKILL");
    await holder.exited;
  }
  const moved = root + " moved 中文";
  await rename(root, moved);
  const reopened = await Installation.at(moved, app)
    .external(join(moved, "instances", "default"))
    .open({ mode: "read-only" });
  try {
    expect(reopened.instance.id).toBe(initialized.id);
    await expect(
      reopened.configuration.set("locale", "en"),
    ).rejects.toMatchObject({ code: "runtime.read_only" });
  } finally {
    await reopened.close();
  }
});
