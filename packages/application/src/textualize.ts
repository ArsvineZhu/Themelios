import {
  appError,
  decodeUtf8,
  openCall,
  parseJson,
  type Completed,
  type Json,
} from "@themelios/core";
import type { Materials } from "@themelios/content";
import { type Models, type ModelCapabilities } from "@themelios/models";
import type { Prompts } from "@themelios/models/prompts";
import type { PreparedInput } from "@themelios/models/tasks";
import type {
  Preparation,
  Textualize,
  Textualized,
} from "./input-contracts.js";
import { type InternalPreparationOptions } from "./preparation.js";
import { resolveMedia } from "./resolve-media.js";
import { type TaskRoute } from "./task-route.js";
import { createTasks, mediaDescription } from "./tasks.js";

const textOnly: ModelCapabilities = {
  operations: ["generate"],
  inputMimeTypes: ["text/plain"],
  needs: ["text"],
  structuredOutput: false,
  streaming: false,
};

function asText<T extends Textualized>(
  value: T,
  parts: Pick<Completed, "inputs" | "producer">,
): Completed<T> {
  return {
    ...parts,
    value,
    files: [
      {
        name: "text.txt",
        material: {
          bytes: new TextEncoder().encode(value.text),
          mediaType: "text/plain",
          name: "text.txt",
        },
        sourceIndices: parts.inputs.length ? [0] : [],
      },
    ],
  };
}

function pageCoverage(
  prepared: PreparedInput,
): Extract<Textualized, { mode: "extract" }> {
  const delivered = prepared.uses[0]?.delivered[0];
  const data =
    delivered && "result" in delivered ? delivered.result.value : undefined;
  const body = prepared.parts
    .slice(1)
    .map((part) => (part.kind === "text" ? part.text : decodeUtf8(part.bytes)))
    .join("");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { mode: "extract", text: body, pages: [], emptyPages: [] };
  }
  return {
    mode: "extract",
    text: body,
    pages: Array.isArray(data.pages)
      ? (data.pages as Extract<Textualized, { mode: "extract" }>["pages"])
      : [],
    emptyPages: Array.isArray(data.emptyPages)
      ? (data.emptyPages as number[])
      : [],
  };
}

type Request = Parameters<Textualize["run"]>[0];

export function createTextualize(options: {
  readonly models: Models;
  readonly preparation: Preparation;
  readonly prompts: Prompts;
  readonly materials?: Materials;
  readonly routes?: Readonly<Record<string, TaskRoute>>;
}): Textualize {
  async function extract(request: Request, call: InternalPreparationOptions) {
    const prepared = await options.preparation.forModel(
      [{ source: request.material }],
      {
        minMaterials: 1,
        maxMaterials: 1,
        inputs: [
          { mediaType: "text/*", needs: ["text"] },
          { mediaType: "application/pdf", needs: ["text"] },
          { mediaType: "application/json", needs: ["text"] },
        ],
      },
      textOnly,
      call,
    );
    return asText(pageCoverage(prepared), {
      inputs: prepared.uses,
      producer: { kind: "transform", name: "textualize.extract" },
    });
  }
  async function describe(request: Request, call: InternalPreparationOptions) {
    const tasks = createTasks({ ...options, routes: options.routes ?? {} });
    const result = await tasks.run(
      mediaDescription,
      {
        variables: { instructions: request.instructions ?? null },
        materials: [{ source: request.material }],
        ...(request.model === undefined ? {} : { model: request.model }),
      },
      call,
    );
    return asText({ mode: "describe", text: result.value }, result);
  }
  async function transcribe(
    request: Request,
    call: InternalPreparationOptions,
  ) {
    const input = resolveMedia(request.material, options.materials);
    const model = request.model ?? options.routes?.["speech.transcribe"]?.model;
    if (!model)
      throw appError("model.binding_not_found", {
        details: { binding: "speech.transcribe" },
      });
    const { capabilities } = options.models.describe(model);
    const prepared = await options.preparation.forModel(
      [{ source: request.material }],
      {
        minMaterials: 1,
        maxMaterials: 1,
        inputs: [{ mediaType: input.info.mediaType, needs: ["speech"] }],
      },
      capabilities,
      call,
    );
    const audio = prepared.parts.find(
      (part) => part.kind === "media" && part.mediaType.startsWith("audio/"),
    );
    if (!audio || audio.kind !== "media") {
      throw appError("input.capability_missing", {
        details: {
          mediaType: input.info.mediaType,
          required: "audio for transcription",
        },
      });
    }
    const available = capabilities.transcriptionTimestamps ?? [];
    const timestamps = available.includes("segment")
      ? "segment"
      : available.includes("word")
        ? "word"
        : "none";
    const transcript = await options.models.transcribe(
      { model, audio, timestamps },
      call,
    );
    const details: Json = parseJson({
      ...transcript.model,
      ...(transcript.usage ? { usage: transcript.usage } : {}),
    });
    return asText(
      {
        mode: "transcribe",
        text: transcript.text,
        language: transcript.language ?? null,
        durationMs: transcript.durationMs ?? null,
        segments: transcript.segments?.map((segment) => ({ ...segment })) ?? [],
      },
      {
        inputs: prepared.uses,
        producer: { kind: "model", name: "speech.transcribe", details },
      },
    );
  }

  return {
    async run(request, callOptions) {
      const call = openCall("textualize." + request.mode, callOptions);
      const options = { signal: call.signal, allowEmptyPdfPages: true };
      try {
        switch (request.mode) {
          case "extract":
            return await extract(request, options);
          case "describe":
            return await describe(request, options);
          case "transcribe":
            return await transcribe(request, options);
        }
        throw appError("input.invalid", {
          details: {
            issues: [
              {
                path: ["mode"],
                reason: "Expected extract, describe or transcribe",
              },
            ],
          },
        });
      } finally {
        call.close();
      }
    },
  };
}
