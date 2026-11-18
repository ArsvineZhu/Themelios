import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import writeAtomic from "write-file-atomic";
import { throwIfAborted, type Json } from "@themelios/core";
import { z } from "zod";
import type { InstancePaths } from "./contracts.js";
import { failure } from "./failure.js";
import { acquireLock } from "./native.js";

export type Endpoints = Readonly<Record<string, string>>;
const ownerSchema = z.object({
  ownerPid: z.int().positive(),
  startedAt: z.iso.datetime(),
  endpoints: z.record(z.string(), z.string()).optional(),
});

export interface OwnedLock {
  endpoints(value: Endpoints): Promise<void>;
  close(): Promise<void>;
}

export async function openInstanceLock(
  paths: InstancePaths,
  instanceId?: string,
  signal?: AbortSignal,
): Promise<OwnedLock> {
  throwIfAborted(signal);
  const path = join(paths.run, "instance.lock");
  const ownerPath = join(paths.run, "owner.json");
  const handle = acquireLock(path);
  if (!handle) {
    let owner: z.infer<typeof ownerSchema> | undefined;
    try {
      owner = ownerSchema.safeParse(
        JSON.parse(await readFile(ownerPath, "utf8")),
      ).data;
    } catch {
      /* The OS lock is authoritative even before owner.json is written. */
    }
    throw failure(
      "runtime.instance_busy",
      {
        ...(instanceId ? { instanceId } : {}),
        ...owner,
      } as Json,
      undefined,
      true,
    );
  }
  const owner = { ownerPid: process.pid, startedAt: new Date().toISOString() };
  let writes = Promise.resolve();
  let closing: Promise<void> | undefined;
  const writeOwner = async (endpoints?: Endpoints) => {
    try {
      await writeAtomic(
        ownerPath,
        JSON.stringify({ ...owner, ...(endpoints ? { endpoints } : {}) }) +
          "\n",
      );
    } catch (error) {
      throw failure("runtime.owner_failed", { path: ownerPath }, error);
    }
  };
  try {
    throwIfAborted(signal);
    await writeOwner();
    throwIfAborted(signal);
  } catch (error) {
    try {
      await rm(ownerPath, { force: true });
    } finally {
      handle.close();
    }
    throw error;
  }
  return {
    endpoints(value) {
      if (closing)
        return Promise.reject(failure("runtime.closed", { state: "closing" }));
      const update = writes.then(() => writeOwner(value));
      writes = update.catch(() => undefined);
      return update;
    },
    close() {
      closing ??= writes.then(async () => {
        try {
          await rm(ownerPath, { force: true });
        } finally {
          handle.close();
        }
      });
      return closing;
    },
  };
}
