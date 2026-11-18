import { appError, parseJson, type CallOptions } from "@themelios/core";
import { z } from "zod";
import type {
  MediaInput,
  ModelPart,
  Models,
  Preparation,
  PreparedRepresentation,
  Prompts,
  TaskDefinition,
} from "./types.js";

const mediaDescribeVariablesSchema = z.object({
  language: z.enum(["zh-CN", "en"]).default("zh-CN"),
  instructions: z.string().max(4000).nullable().default(null),
});

export function createMediaDescriptionInlineTask(): TaskDefinition<
  z.output<typeof mediaDescribeVariablesSchema>,
  string,
  z.input<typeof mediaDescribeVariablesSchema>
> {
  return {
    id: "media.describe",
    title: "Describe media",
    purpose:
      "Produce a factual textual description of an image, audio, or document input.",
    titleKey: "tasks.mediaDescription.title",
    purposeKey: "tasks.mediaDescription.purpose",
    input: mediaDescribeVariablesSchema,
    output: "text",
    requirements: {
      minMaterials: 1,
      maxMaterials: 1,
      inputs: [
        { mediaType: "text/plain", needs: ["text"] },
        { mediaType: "text/markdown", needs: ["text"] },
        { mediaType: "image/*", needs: ["visual"] },
        { mediaType: "application/pdf", needs: ["text", "visual"] },
        { mediaType: "audio/*", needs: ["speech"] },
        { mediaType: "video/*", needs: ["visual", "speech", "motion"] },
      ],
    },
    templates: {
      inline: true,
      system:
        "Produce a concise, faithful textual representation of the provided input for downstream tasks.",
      user: "{% if instructions %}{{ instructions }}\n\n{% endif %}Respond in {{ language | default: 'zh-CN' }}.\nMaterial: {{ sources[0].mediaType }} ({{ sources[0].originalExtent }}).",
    },
    examples: [],
    outputRuleKeys: [],
  };
}

export async function prepareModelRepresentation(params: {
  recipe: "media.describe" | "speech.transcribe";
  model: string;
  input: MediaInput;
  call: CallOptions;
  models: Models;
  prompts?: Prompts;
  preparation: Preparation;
  maxMaterialBytes: number;
  readPart: (
    input: MediaInput,
    call: CallOptions,
    maxBytes: number,
  ) => Promise<ModelPart>;
}): Promise<PreparedRepresentation> {
  const {
    recipe,
    model,
    input,
    call,
    models,
    prompts,
    preparation,
    maxMaterialBytes,
    readPart,
  } = params;
  const material = input.source;
  if (recipe === "speech.transcribe") {
    const audio = await readPart(input, call, maxMaterialBytes);
    if (audio.kind !== "media" || !audio.mediaType.startsWith("audio/")) {
      throw appError("input.capability_missing", {
        details: { mediaType: input.info.mediaType, required: "audio/*" },
      });
    }
    const result = await models.transcribe({ model, audio }, call);
    return {
      outputs: ["text.txt"],
      result: {
        value: parseJson({ text: result.text }),
        inputs: [{ source: material, delivered: [material], role: "primary" }],
        files: [
          {
            name: "text.txt",
            material: {
              bytes: new TextEncoder().encode(result.text),
              mediaType: "text/plain",
              name: "text.txt",
            },
            sourceIndices: [0],
          },
        ],
        producer: {
          kind: "model",
          name: "speech.transcribe",
          details: parseJson(result.model),
        },
      },
    };
  }
  const describeTask = createMediaDescriptionInlineTask();
  const prepared = await preparation.forModel(
    [{ source: material }],
    describeTask.requirements,
    models.describe(model).capabilities,
    call,
  );
  const messages = prompts
    ? (
        await prompts.compile(
          describeTask,
          { language: "zh-CN", instructions: null },
          prepared.sources,
        )
      ).messages
    : [
        {
          role: "system" as const,
          parts: [
            {
              kind: "text" as const,
              text: (
                describeTask.templates as {
                  inline: true;
                  system?: string;
                  user: string;
                }
              ).system!,
            },
          ],
        },
        {
          role: "user" as const,
          parts: [
            {
              kind: "text" as const,
              text: "Describe the input media accurately.",
            },
          ],
        },
      ];
  const generated = await models.generate<string>(
    {
      model,
      output: "text",
      messages: messages.map((m) =>
        m.role === "user"
          ? { ...m, parts: [...m.parts, ...prepared.parts] }
          : m,
      ),
    },
    call,
  );
  return {
    outputs: ["text.txt"],
    result: {
      value: parseJson({ text: generated.value }),
      inputs: prepared.uses,
      files: [
        {
          name: "text.txt",
          material: {
            bytes: new TextEncoder().encode(generated.value),
            mediaType: "text/plain",
            name: "text.txt",
          },
          sourceIndices: [0],
        },
      ],
      producer: {
        kind: "model",
        name: "media.describe",
        details: parseJson(generated.model),
      },
    },
  };
}
