import { createHash } from "node:crypto";
import {
  appError,
  parseJson,
  plainTextMediaType,
  type CallOptions,
  type MediaInput,
  type ModalityNeed,
  type PreparedRepresentation,
  type Producer,
  type RepresentationCoverage,
} from "@themelios/core";
import { mediaDescription } from "./task-definition.js";
import {
  taskGenerationOptions,
  taskGenerationInputs,
  taskGenerationRequest,
  taskProducer,
} from "./task-execution.js";
import {
  speechTranscriptionRecipe,
  type ModelRepresentationRecipe,
} from "./representation-route.js";
import type {
  ModelPart,
  Models,
  Preparation,
  PreparedInput,
  Prompts,
  TaskRoute,
} from "./types.js";

function audioPart(prepared: PreparedInput, input: MediaInput) {
  const parts = prepared.parts.filter((part) => part.kind === "media");
  const [audio] = parts;
  if (parts.length !== 1 || !audio?.mediaType.startsWith("audio/")) {
    throw appError("input.capability_missing", {
      details: {
        mediaType: input.info.mediaType,
        required: "one prepared audio attachment",
      },
    });
  }
  return audio;
}

function combinedRange(
  prepared: PreparedInput,
  input: MediaInput,
): RepresentationCoverage["sourceRange"] {
  const delivered = prepared.sources.entries[0]?.delivered ?? [];
  if (delivered.length === 1) return delivered[0]!.sourceRange;
  const ranges = delivered.map(({ sourceRange }) => sourceRange);
  const pages = ranges.filter((range) => range?.kind === "pages");
  const [first, ...remaining] = pages;
  if (first && pages.length === ranges.length) {
    let end = first.end;
    let continuous = true;
    for (const next of remaining) {
      if (next.start !== end) {
        continuous = false;
        break;
      }
      end = next.end;
    }
    if (continuous) return { kind: "pages", start: first.start, end };
  }
  throw appError("input.capability_missing", {
    details: {
      mediaType: input.info.mediaType,
      required: "one continuous range for a combined textual representation",
    },
  });
}

function partFingerprint(part: ModelPart) {
  if (part.kind === "text") return part;
  const { bytes, ...metadata } = part;
  return {
    ...metadata,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function textRepresentation(
  text: string,
  producer: Producer,
  input: PreparedInput,
  sourceRange: RepresentationCoverage["sourceRange"],
): PreparedRepresentation {
  const file = "text.txt";
  const bytes = new TextEncoder().encode(text);
  return {
    outputs: [file],
    result: {
      value: { text },
      inputs: input.uses,
      files: [
        {
          name: file,
          material: { name: file, bytes, mediaType: plainTextMediaType },
          sourceIndices: [0],
          coverage: {
            sourceRange,
            extent: { kind: "text", bytes: bytes.byteLength },
          },
        },
      ],
      producer,
    },
  };
}

export async function planModelRepresentation(params: {
  recipe: ModelRepresentationRecipe;
  model: string;
  input: MediaInput;
  call: CallOptions;
  models: Models;
  prompts: Prompts;
  taskRoute: (taskId: string) => TaskRoute | undefined;
  preparation: Preparation;
  alternatives: readonly (readonly ModalityNeed[])[];
}) {
  const {
    recipe,
    model,
    input,
    call,
    models,
    prompts,
    taskRoute,
    preparation,
    alternatives,
  } = params;
  const capabilities = models.describe(model).capabilities;
  const transcription = recipe === speechTranscriptionRecipe;
  const prepared = await preparation.prepare(
    [{ source: input.source }],
    {
      minMaterials: 1,
      maxMaterials: 1,
      inputs: [
        {
          mediaType: input.info.mediaType,
          accepts: transcription ? [["speech"]] : alternatives,
        },
      ],
    },
    capabilities,
    call,
  );
  const sourceRange = combinedRange(prepared, input);
  const originalExtent =
    prepared.sources.entries[0]?.originalExtent ?? input.info.extent;
  const modelFingerprint = models.fingerprint(model);
  if (transcription) {
    const audio = audioPart(prepared, input);
    const identity = {
      modelFingerprint,
      audio: partFingerprint(audio),
      sourceRange,
    };
    return {
      identity,
      originalExtent,
      async run(options: CallOptions) {
        const result = await models.transcribe({ model, audio }, options);
        return textRepresentation(
          result.text,
          { kind: "model", name: recipe, details: parseJson(result.model) },
          prepared,
          sourceRange,
        );
      },
    };
  }
  const route = taskRoute(mediaDescription.id);
  const work = taskGenerationInputs(mediaDescription, { variables: {} }, route);
  const prompt = await prompts.compile(
    mediaDescription,
    work.variables,
    prepared.sources,
  );
  const request = taskGenerationRequest<string>(
    model,
    mediaDescription.output,
    prompt,
    prepared.parts,
    work.parameters,
  );
  models.validateGeneration(request);
  const identity = {
    modelFingerprint,
    parameters: request.parameters ?? null,
    messages: request.messages.map(({ role, parts }) => ({
      role,
      parts: parts.map(partFingerprint),
    })),
    sourceRange,
  };
  return {
    identity,
    originalExtent,
    async run(options: CallOptions) {
      const generated = await models.generate(
        request,
        taskGenerationOptions(route, options),
      );
      return textRepresentation(
        generated.value,
        taskProducer(recipe, request.output, prompt, generated),
        prepared,
        sourceRange,
      );
    },
  };
}
