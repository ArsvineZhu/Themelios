import { join } from "node:path";
import { collectContent, verifyContent } from "@themelios/content";
import { appError, throwIfAborted } from "@themelios/core";
import { Installation, withOfflineInstance } from "@themelios/runtime";
import {
  backupStorage,
  Cas,
  Database,
  restoreStorage,
  verifyStorage,
} from "@themelios/storage";
import type { OfflineRequest } from "@themelios/transports";
import type { createApplicationModule } from "@themelios/application";

export function maintain(
  installationRoot: string,
  request: OfflineRequest,
  application: ReturnType<typeof createApplicationModule>,
) {
  const root = request.installation ?? installationRoot;
  const installation = Installation.at(root, application);
  const instance = installation.instance(request.instance);
  const formatId = application.formatId;
  const applicationId = application.id;
  const installationConfigPath = join(root, "config", "installation.toml");
  const signalOptions = request.signal ? { signal: request.signal } : {};
  throwIfAborted(request.signal);
  if (request.action === "restore") {
    const backup = request.path;
    if (backup === undefined)
      throw appError("transport.invalid_request", {
        details: { reason: "A backup directory is required" },
      });
    return restoreStorage({
      backup,
      destination: join(root, "instances", request.instance),
      applicationId,
      formatId,
      installationConfigPath,
      ...signalOptions,
    });
  }
  return withOfflineInstance(
    instance,
    async (info) => {
      throwIfAborted(request.signal);
      const database = Database.open({
        path: join(info.paths.state, "main.sqlite"),
        formatId,
        readonly: request.action !== "collect",
      });
      try {
        const cas = await Cas.open(info.paths.objects);
        try {
          if (request.action === "backup") {
            const destination = request.path;
            if (destination === undefined)
              throw appError("transport.invalid_request", {
                details: { reason: "A destination directory is required" },
              });
            return await backupStorage({
              database,
              cas,
              destination,
              applicationId,
              formatId,
              instanceId: info.id,
              instanceRoot: info.paths.root,
              installationConfigPath,
              ...signalOptions,
            });
          }
          if (request.action === "collect")
            return await collectContent(database, cas, {
              ...signalOptions,
              ...(request.retainSince === undefined
                ? {}
                : { retainSince: request.retainSince }),
            });
          const storage = await verifyStorage(database, cas, signalOptions);
          await verifyContent(database, cas, signalOptions);
          return storage;
        } finally {
          await cas.close();
        }
      } finally {
        database.close();
      }
    },
    signalOptions,
  );
}
