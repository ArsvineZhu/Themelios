import { fileURLToPath } from "node:url";
import { createPreparation } from "@themelios/application/inputs";
import { createTasks } from "@themelios/application/tasks";
import { createModels } from "@themelios/models";
import { createPrompts } from "@themelios/models/prompts";
import { defineTask } from "@themelios/models/tasks";
import { z } from "zod";

const task = defineTask({
  id: "sample.summary",
  titleKey: "sample.summary.title",
  purposeKey: "sample.summary.purpose",
  input: z.strictObject({ language: z.enum(["en", "zh-CN"]).default("en") }),
  output: z.strictObject({
    title: z.string().min(1),
    sections: z
      .array(
        z.strictObject({
          markdown: z.string().min(1),
          sourceKeys: z.array(z.literal("S1")).length(1),
        }),
      )
      .min(1)
      .max(3),
    notes: z.string(),
  }),
  requirements: {
    minMaterials: 1,
    maxMaterials: 1,
    inputs: [{ mediaType: "text/plain", needs: ["text"] }],
  },
  templates: { system: "system.md.liquid", user: "user.md.liquid" },
  examples: [],
  outputRuleKeys: ["sample.summary.sourceRequired"],
  validateOutput(value, sources) {
    return value.sections.every((section) =>
      section.sourceKeys.every((key) => sources.has(key)),
    )
      ? []
      : [
          {
            path: ["sections"],
            code: "unknown_source",
            messageKey: "sample.summary.sourceRequired",
          },
        ];
  },
});

const baseURL = process.env.THEMELIOS_MODEL_URL;
const providerModel = process.env.THEMELIOS_MODEL_ID;
if (!baseURL || !providerModel) {
  throw new Error(
    "Provide THEMELIOS_MODEL_URL and THEMELIOS_MODEL_ID for a structured-output model.",
  );
}
const models = createModels({
  connections: {
    local: {
      protocol: "openai-compatible",
      baseURL,
      ...(process.env.THEMELIOS_MODEL_KEY
        ? { credential: "env:THEMELIOS_MODEL_KEY" }
        : {}),
    },
  },
  bindings: {
    summary: {
      connection: "local",
      providerModel,
      capabilities: {
        operations: ["generate"],
        inputMimeTypes: ["text/plain"],
        needs: ["text"],
        structuredOutput: true,
        streaming: true,
      },
      parameters: { temperature: 0, maxOutputTokens: 768 },
    },
  },
});

try {
  const prompts = createPrompts({
    resourceRoot: fileURLToPath(new URL("./resources/", import.meta.url)),
  });
  const tasks = createTasks({
    models,
    prompts,
    preparation: createPreparation(),
    routes: { [task.id]: { model: "summary" } },
  });
  const bytes = await Bun.file(
    new URL("./summary-material.txt", import.meta.url),
  ).bytes();
  const result = await tasks.run(task, {
    variables: {},
    materials: [
      {
        source: {
          bytes,
          mediaType: "text/plain",
          name: "summary-material.txt",
        },
      },
    ],
  });
  console.log(
    JSON.stringify({ value: result.value, producer: result.producer }, null, 2),
  );
} finally {
  await models.close();
}
