import { createHash } from "node:crypto";
import {
  appError,
  parseJson,
  type CallOptions,
  type Json,
  type MediaInput,
  type PreparedRepresentation,
  type RepresentationCoverage,
} from "@themelios/core";
import {
  inputVariables,
  mediaDescription,
  messagesWithParts,
} from "./task-definition.js";
import type {
  ModelPart,
  Models,
  Preparation,
  PreparedInput,
  Prompts,
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
  name: string,
  text: string,
  details: Json,
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
          material: { name: file, bytes, mediaType: "text/plain" },
          sourceIndices: [0],
          coverage: {
            sourceRange,
            extent: { kind: "text", bytes: bytes.byteLength },
          },
        },
      ],
      producer: { kind: "model", name, details },
    },
  };
}

export async function planModelRepresentation(params: {
  recipe: "media.describe" | "speech.transcribe";
  model: string;
  input: MediaInput;
  call: CallOptions;
  models: Models;
  prompts: Prompts;
  preparation: Preparation;
  descriptionDefaults?: Readonly<Record<string, Json>>;
}) {
  const {
    recipe,
    model,
    input,
    call,
    models,
    prompts,
    preparation,
    descriptionDefaults,
  } = params;
  const capabilities = models.describe(model).capabilities;
  const transcription = recipe === "speech.transcribe";
  const prepared = await preparation.forModel(
    [{ source: input.source }],
    transcription
      ? {
          minMaterials: 1,
          maxMaterials: 1,
          inputs: [
            { mediaType: "audio/*", needs: ["speech"] },
            { mediaType: "video/*", needs: ["speech"] },
          ],
        }
      : mediaDescription.requirements,
    capabilities,
    call.signal ? { signal: call.signal } : {},
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
      async run() {
        const result = await models.transcribe({ model, audio }, call);
        return textRepresentation(
          recipe,
          result.text,
          parseJson(result.model),
          prepared,
          sourceRange,
        );
      },
    };
  }
  const variables = inputVariables(mediaDescription, {}, descriptionDefaults);
  const prompt = await prompts.compile(
    mediaDescription,
    variables,
    prepared.sources,
  );
  const messages = messagesWithParts(prompt, prepared.parts);
  const identity = {
    modelFingerprint,
    messages: messages.map(({ role, parts }) => ({
      role,
      parts: parts.map(partFingerprint),
    })),
    sourceRange,
  };
  return {
    identity,
    originalExtent,
    async run() {
      const generated = await models.generate<string>(
        { model, output: "text", messages },
        call,
      );
      return textRepresentation(
        recipe,
        generated.value,
        parseJson({
          ...generated.model,
          prompts: prompt.files.map(({ role, source }) => ({ role, source })),
        }),
        prepared,
        sourceRange,
      );
    },
  };
}
