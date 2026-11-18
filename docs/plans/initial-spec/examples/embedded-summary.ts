import { fileURLToPath } from "node:url";
import { createModels } from "@themelios/models";
import { createPrompts } from "@themelios/models/prompts";
import { createTasks } from "@themelios/application/tasks";
import { createPreparation } from "@themelios/application/inputs";
import { documentSummary } from "./tasks/document-summary.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const models = createModels({
  connections: {
    primary: {
      protocol: "openai-compatible",
      baseURL: required("THEMELIOS_MODEL_URL"),
      credential: "env:THEMELIOS_MODEL_KEY",
    },
  },
  bindings: {
    summary: {
      connection: "primary",
      providerModel: required("THEMELIOS_MODEL_ID"),
      capabilities: {
        operations: ["generate"],
        inputMimeTypes: ["text/plain"],
        needs: ["text"],
        structuredOutput: true,
        streaming: true,
      },
    },
  },
});

try {
  const prompts = createPrompts({
    resourceRoot: fileURLToPath(new URL("./resources/", import.meta.url)),
  });
  const preparation = createPreparation();
  const tasks = createTasks({
    models, prompts, preparation,
    routes: { "document.summary": { model: "summary" } },
  });
  const bytes = new Uint8Array(await Bun.file(
    fileURLToPath(new URL("./summary-material.txt", import.meta.url)),
  ).arrayBuffer());
  const result = await tasks.run(documentSummary, {
    variables: { maxSections: 3 },
    materials: [{ source: { bytes, mediaType: "text/plain", name: "progress.txt" } }],
  });
  process.stdout.write(JSON.stringify(result.value, null, 2) + "\n");
} finally {
  await models.close();
}
