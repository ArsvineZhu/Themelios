import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import writeAtomic from "write-file-atomic";
import { appError, throwIfAborted, type Json } from "@themelios/core";
import { tryExclusiveFileLock } from "@themelios/core/files";
import { z } from "zod";
import type { InstancePaths } from "./paths.js";

export type Endpoints = Readonly<Record<string, string>>;
export type EndpointUpdate = Endpoints | ((current: Endpoints) => Endpoints);
const ownerSchema = z.object({
  ownerPid: z.int().positive(),
  startedAt: z.iso.datetime(),
  endpoints: z.record(z.string(), z.string()).optional(),
});

export interface OwnedLock {
  endpoints(value: EndpointUpdate): Promise<void>;
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
  let releaseHandle: (() => void) | undefined;
  try {
    releaseHandle = tryExclusiveFileLock(path);
  } catch (cause) {
    throw appError("runtime.lock_failed", { details: { path }, cause });
  }
  if (!releaseHandle) {
    let owner: z.infer<typeof ownerSchema> | undefined;
    try {
      owner = ownerSchema.safeParse(
        JSON.parse(await readFile(ownerPath, "utf8")),
      ).data;
    } catch {
      /* The OS lock is authoritative even before owner.json is written. */
    }
    throw appError("runtime.instance_busy", {
      details: {
        ...(instanceId ? { instanceId } : {}),
        ...owner,
      } as Json,
      retryable: true,
    });
  }
  const owner = { ownerPid: process.pid, startedAt: new Date().toISOString() };
  let writes = Promise.resolve();
  let advertised: Endpoints = Object.freeze({});
  let closing: Promise<void> | undefined;
  const writeOwner = async (endpoints?: Endpoints) => {
    try {
      await writeAtomic(
        ownerPath,
        JSON.stringify({ ...owner, ...(endpoints ? { endpoints } : {}) }) +
          "\n",
      );
    } catch (error) {
      throw appError("runtime.owner_failed", {
        details: { path: ownerPath },
        cause: error,
      });
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
      releaseHandle();
    }
    throw error;
  }
  return {
    endpoints(value) {
      if (closing)
        return Promise.reject(
          appError("runtime.closed", { details: { state: "closing" } }),
        );
      const update = writes.then(async () => {
        const next = Object.freeze({
          ...(typeof value === "function" ? value(advertised) : value),
        });
        await writeOwner(Object.keys(next).length ? next : undefined);
        advertised = next;
      });
      writes = update.catch(() => undefined);
      return update;
    },
    close() {
      closing ??= writes.then(async () => {
        try {
          await rm(ownerPath, { force: true });
        } finally {
          releaseHandle();
        }
      });
      return closing;
    },
  };
}
