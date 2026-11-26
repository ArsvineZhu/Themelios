import {
  appError,
  isTextMedia,
  matchesMime,
  plainTextMediaType,
  type CallOptions,
  type Json,
  type MediaInput,
  type ModalityNeed,
  type Range,
  type RepresentationAdapter,
} from "@themelios/core";
import { z } from "zod";
import { modelAcceptsMedia } from "./delivery.js";
import type {
  ModelCapabilities,
  ModelOperation,
  Models,
  PreparationPolicy,
} from "./types.js";

export const mediaDescriptionRecipe = "media.describe";
export const speechTranscriptionRecipe = "speech.transcribe";
export const modelRepresentationRecipeSchema = z.enum([
  mediaDescriptionRecipe,
  speechTranscriptionRecipe,
]);
export type ModelRepresentationRecipe = z.output<
  typeof modelRepresentationRecipeSchema
>;
const recipeOperations: Record<ModelRepresentationRecipe, ModelOperation> = {
  [mediaDescriptionRecipe]: "generate",
  [speechTranscriptionRecipe]: "transcribe",
};

export type AcceptedModalities = readonly (readonly ModalityNeed[])[];

export type Route =
  | { kind: "native" }
  | {
      kind: "transform";
      adapter: RepresentationAdapter;
      parameters: Json;
    }
  | {
      kind: "model";
      recipe: ModelRepresentationRecipe;
      model: string;
    };

export function ruleFor<T extends { mediaType: string }>(
  mediaType: string,
  rules?: readonly T[],
): T | undefined {
  return (
    rules?.find((rule) => rule.mediaType === mediaType) ??
    rules?.find((rule) => matchesMime(rule.mediaType, mediaType))
  );
}

export function canSend(model: ModelCapabilities, mediaType: string): boolean {
  const mime = isTextMedia(mediaType) ? plainTextMediaType : mediaType;
  return modelAcceptsMedia(model, mime);
}

export function adapterAcceptsSource(
  adapter: RepresentationAdapter,
  mediaType: string,
): boolean {
  return adapter.description.inputMimeTypes.some((pattern) =>
    matchesMime(pattern, mediaType),
  );
}

function covers(
  supplies: readonly ModalityNeed[],
  needs: readonly ModalityNeed[],
): boolean {
  return needs.every((need) => supplies.includes(need));
}

const inlineTextRanges: ReadonlySet<Range["kind"]> = new Set(["text", "json"]);

function supportsNativeRange({ info, range }: MediaInput): boolean {
  return (
    range === undefined ||
    (isTextMedia(info.mediaType) && inlineTextRanges.has(range.kind))
  );
}

export function accepts(
  alternatives: AcceptedModalities,
  ...suppliers: (readonly ModalityNeed[])[]
): boolean {
  return alternatives.some((needs) =>
    suppliers.every((supplies) => covers(supplies, needs)),
  );
}

export function mediaModalities(mediaType: string): readonly ModalityNeed[] {
  if (isTextMedia(mediaType)) return ["text"];
  if (mediaType.startsWith("image/")) return ["visual"];
  if (mediaType.startsWith("audio/")) return ["speech"];
  if (mediaType.startsWith("video/")) return ["visual", "speech", "motion"];
  if (mediaType === "application/pdf") return ["text", "visual"];
  return [];
}

export function unsupported(
  input: MediaInput,
  sourceKey: string,
  required: string,
): never {
  throw appError("input.capability_missing", {
    details: { sourceKey, mediaType: input.info.mediaType, required },
  });
}

export function createRepresentationRouting(
  registered: readonly RepresentationAdapter[] = [],
  models?: Models,
) {
  const adapters = [...registered].sort(
    (a, b) =>
      b.description.priority - a.description.priority ||
      a.description.id.localeCompare(b.description.id),
  );
  const byId = new Map(
    adapters.map((adapter) => [adapter.description.id, adapter]),
  );
  if (byId.size !== adapters.length)
    throw appError("config.invalid", {
      details: {
        issues: [{ path: "preparation", messageKey: "input.duplicate_recipe" }],
      },
    });
  const normalizers = adapters.filter(
    (
      adapter,
    ): adapter is RepresentationAdapter &
      Required<Pick<RepresentationAdapter, "requiresNormalization">> =>
      adapter.requiresNormalization !== undefined,
  );

  function supports(
    adapter: RepresentationAdapter,
    mediaType: string,
    alternatives: AcceptedModalities,
    model: ModelCapabilities,
  ) {
    const { supplies, outputMimeTypes } = adapter.description;
    return (
      adapterAcceptsSource(adapter, mediaType) &&
      accepts(alternatives, supplies, model.needs) &&
      outputMimeTypes.some((mime) => canSend(model, mime))
    );
  }

  async function nativeInput(
    input: MediaInput,
    model: ModelCapabilities,
    call: CallOptions,
  ): Promise<boolean> {
    const mime = input.info.mediaType;
    if (!canSend(model, mime) || !supportsNativeRange(input)) return false;
    for (const adapter of normalizers) {
      if (
        adapterAcceptsSource(adapter, mime) &&
        (await adapter.requiresNormalization(input, call))
      )
        return false;
    }
    return true;
  }

  function transform(
    adapter: RepresentationAdapter,
    input: MediaInput,
    model: ModelCapabilities,
    parameters?: Json,
  ): Route {
    return {
      kind: "transform",
      adapter,
      parameters:
        adapter.parametersForModel?.(
          input.info.mediaType,
          (mime) => canSend(model, mime),
          parameters ?? {},
        ) ??
        parameters ??
        {},
    };
  }

  async function explicitRoute(
    input: MediaInput,
    key: string,
    alternatives: AcceptedModalities,
    model: ModelCapabilities,
    rule: NonNullable<PreparationPolicy["representations"]>[number],
  ): Promise<Route> {
    const adapter = byId.get(rule.recipe);
    if (
      !adapter ||
      !supports(adapter, input.info.mediaType, alternatives, model)
    ) {
      return unsupported(input, key, rule.recipe);
    }
    const availability = await adapter.available();
    if (!availability.available)
      return unsupported(input, key, availability.missing.join(", "));
    return transform(adapter, input, model, rule.parameters);
  }

  async function installedRoute(
    input: MediaInput,
    alternatives: AcceptedModalities,
    model: ModelCapabilities,
    call: CallOptions,
  ): Promise<Route | undefined> {
    if (
      accepts(
        alternatives,
        model.needs,
        mediaModalities(input.info.mediaType),
      ) &&
      (await nativeInput(input, model, call))
    )
      return { kind: "native" };
    for (const adapter of adapters) {
      if (!supports(adapter, input.info.mediaType, alternatives, model))
        continue;
      if ((await adapter.available()).available)
        return transform(adapter, input, model);
    }
  }

  function modelRoute(
    input: MediaInput,
    model: ModelCapabilities,
    policy?: PreparationPolicy,
  ): Route | undefined {
    const rule = ruleFor(input.info.mediaType, policy?.models);
    if (
      !rule ||
      !models ||
      !canSend(model, plainTextMediaType) ||
      !model.needs.includes("text")
    )
      return;
    const assist = models.describe(rule.model).capabilities;
    const operation = recipeOperations[rule.recipe];
    if (assist.operations.includes(operation)) {
      return { kind: "model", recipe: rule.recipe, model: rule.model };
    }
  }

  async function route(
    input: MediaInput,
    key: string,
    alternatives: AcceptedModalities,
    model: ModelCapabilities,
    call: CallOptions,
    policy?: PreparationPolicy,
  ): Promise<Route> {
    const rule = ruleFor(input.info.mediaType, policy?.representations);
    if (rule) return explicitRoute(input, key, alternatives, model, rule);
    return (
      (await installedRoute(input, alternatives, model, call)) ??
      modelRoute(input, model, policy) ??
      unsupported(
        input,
        key,
        alternatives.map((needs) => needs.join(" + ")).join(" or "),
      )
    );
  }

  return { adapters, route };
}
