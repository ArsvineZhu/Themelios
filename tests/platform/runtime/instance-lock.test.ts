import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rename } from "node:fs/promises";
import { join, relative } from "node:path";
import { Installation, runtimeSettings } from "@themelios/runtime";

const app = {
  id: "test.platform",
  formatId: "test.platform",
  settings: runtimeSettings,
  async provision() {},
  async open() {},
};

async function initializedInstance() {
  const work = join("temp", "work");
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(join(work, "runtime-native-"));
  const instance = Installation.at(root, app).instance("default");
  const initialized = await instance.init();
  return { root, instance, initialized };
}

test("an OS-held instance conflicts across processes and opens after the holder dies and the directory moves", async () => {
  const { root, instance, initialized } = await initializedInstance();
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
  const relocated = Installation.at(moved, app).external(
    join(moved, relative(root, initialized.paths.root)),
  );
  const reopened = await relocated.open({ mode: "read-only" });
  try {
    expect(reopened.instance.id).toBe(initialized.id);
    await expect(
      reopened.configuration.set("locale", "en"),
    ).rejects.toMatchObject({ code: "runtime.read_only" });
  } finally {
    await reopened.close();
  }
});

test("an instance publishes only the currently owned endpoints", async () => {
  const { instance } = await initializedInstance();
  const opened = await instance.open();
  try {
    await opened.setEndpoints({ status: "in-process" });
    const address = "http://127.0.0.1:9010";
    const original = await opened.publishEndpoints({ http: address });
    const replacement = await opened.publishEndpoints({ http: address });
    await original.close();
    await expect(instance.open()).rejects.toMatchObject({
      code: "runtime.instance_busy",
      details: { endpoints: { status: "in-process", http: address } },
    });
    await replacement.close();
    await expect(instance.open()).rejects.toHaveProperty("details.endpoints", {
      status: "in-process",
    });
  } finally {
    await opened.close();
  }
});
