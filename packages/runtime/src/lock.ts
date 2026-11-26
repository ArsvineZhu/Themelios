import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import writeAtomic from "write-file-atomic";
import { appError, throwIfAborted, type Json } from "@themelios/core";
import { tryExclusiveFileLock } from "@themelios/core/files";
import { z } from "zod";
import type { InstancePaths } from "./paths.js";

const endpointsSchema = z.record(z.string(), z.string());
export type Endpoints = Readonly<z.output<typeof endpointsSchema>>;
export interface EndpointPublication {
  close(): Promise<void>;
}

interface Advertisement {
  readonly address: string;
  readonly publication?: symbol;
}
const ownerSchema = z.object({
  ownerPid: z.int().positive(),
  startedAt: z.iso.datetime(),
  endpoints: endpointsSchema.optional(),
});

export interface OwnedLock {
  setEndpoints(endpoints: Endpoints): Promise<void>;
  publishEndpoints(endpoints: Endpoints): Promise<EndpointPublication>;
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
  let advertised: ReadonlyMap<string, Advertisement> = new Map();
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
  function updateEndpoints(
    update: (
      current: ReadonlyMap<string, Advertisement>,
    ) => ReadonlyMap<string, Advertisement>,
  ): Promise<void> {
    if (closing)
      return Promise.reject(
        appError("runtime.closed", { details: { state: "closing" } }),
      );
    const result = writes.then(async () => {
      const next = update(advertised);
      if (next === advertised) return;
      const endpoints = Object.fromEntries(
        Array.from(next, ([name, { address }]) => [name, address]),
      );
      await writeOwner(next.size ? endpoints : undefined);
      advertised = next;
    });
    writes = result.catch(() => undefined);
    return result;
  }
  return {
    setEndpoints(endpoints) {
      const entries = Object.entries(endpoints);
      return updateEndpoints(
        () => new Map(entries.map(([name, address]) => [name, { address }])),
      );
    },
    async publishEndpoints(endpoints) {
      const entries = Object.entries(endpoints);
      const publication = Symbol();
      await updateEndpoints((current) => {
        const next = new Map(current);
        for (const [name, address] of entries)
          next.set(name, { address, publication });
        return next;
      });
      return {
        close() {
          if (closing) return closing;
          return updateEndpoints((current) => {
            const next = new Map(current);
            for (const [name, entry] of current) {
              if (entry.publication === publication) next.delete(name);
            }
            return next.size === current.size ? current : next;
          });
        },
      };
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
