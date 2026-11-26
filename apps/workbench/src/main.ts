#!/usr/bin/env bun
import { mountStandardCli } from "./commands.js";
import { resolve } from "node:path";
import { Installation } from "@themelios/runtime";
import { standardOperations } from "@themelios/application";
import { runApplicationCli } from "@themelios/transports";
import { createWorkbench } from "./definition.js";
import { maintain } from "./maintenance.js";
import { localPrincipal, serve } from "./serve.js";

export {
  releaseRecipes,
  workbenchId,
  workbenchTaskDescriptions,
} from "./definition.js";

export async function runWorkbench(options: {
  installationRoot: string;
  cwd: string;
  argv: readonly string[];
}): Promise<number> {
  const signal = new AbortController();
  const stop = () => signal.abort("interrupted");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const application = await createWorkbench(options.cwd);
    const useInstallation = (root: string) =>
      Installation.at(root, application);
    return await runApplicationCli(
      useInstallation(options.installationRoot),
      options.argv,
      {
        name: "themelios",
        operations: standardOperations(),
        mountOperationCommands: false,
        configure: mountStandardCli,
        cwd: options.cwd,
        principal: localPrincipal,
        signal: signal.signal,
        useInstallation,
        offline: (request) =>
          maintain(options.installationRoot, request, application),
        serve,
        limits: (session) => session.configuration.snapshot().transports,
      },
    );
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (import.meta.main) {
  const cwd = process.cwd();
  process.exitCode = await runWorkbench({
    cwd,
    installationRoot: resolve(cwd, process.env.THEMELIOS_INSTALLATION ?? "."),
    argv: process.argv.slice(2),
  });
}
