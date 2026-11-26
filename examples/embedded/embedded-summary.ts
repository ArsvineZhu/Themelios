import { fileURLToPath } from "node:url";
import { createModels, defineTask, z } from "@themelios/models";

const filePrompt = process.argv.includes("--file-prompt");

const task = defineTask({
  id: "sample.summary",
  title: "Sample Summary",
  purpose: "Summarize text materials into structured markdown sections.",
  input: z.strictObject({ language: z.enum(["en", "zh-CN"]).default("en") }),
  output: {
    kind: "json",
    schema: z.strictObject({
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
  },
  requirements: {
    minMaterials: 1,
    maxMaterials: 1,
    inputs: [{ mediaType: "text/plain", accepts: [["text"]] }],
  },
  templates: filePrompt
    ? { system: "system.md.liquid", user: "user.md.liquid" }
    : {
        inline: true,
        system:
          "Summarize the material concisely and cite source keys such as S1.",
        user: "Language: {{ language }}\n{% for s in sources %}Source {{ s.key }} ({{ s.name }}): {{ s.originalExtent | extent }}\n{% endfor %}",
      },
  validateOutput: (value, sources) =>
    value.sections.every((s) => s.sourceKeys.every((k) => sources.has(k)))
      ? []
      : [
          {
            path: ["sections"],
            code: "unknown_source",
            messageKey: "unknown_source",
          },
        ],
});

const baseURL = process.env.THEMELIOS_MODEL_URL;
const providerModel = process.env.THEMELIOS_MODEL_ID;
if (!baseURL || !providerModel) {
  throw new Error(
    "Provide THEMELIOS_MODEL_URL and THEMELIOS_MODEL_ID for a structured-output model.",
  );
}

const models = createModels(
  {
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
  },
  {
    resourceRoot: fileURLToPath(new URL("./resources", import.meta.url)),
  },
);

try {
  const result = await models.tasks.run(task, {
    variables: {},
    materials: [
      {
        source: {
          file: fileURLToPath(
            new URL("./summary-material.txt", import.meta.url),
          ),
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
