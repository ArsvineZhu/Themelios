import { createHash } from "node:crypto";
import {
  AppError,
  appError,
  isTextMedia,
  openCall,
  readMediaBytes,
  rangeSchema,
  throwIfAborted,
  type CallOptions,
  type Completed,
  type DeliveredMedia,
  type InputUse,
  type Json,
  type Material,
  type MediaInput,
  type ModalityNeed,
  type PreparedRepresentation,
  type RepresentationAdapter,
  type SavedResult,
  type Selection,
} from "@themelios/core";
import { deliveredMedia } from "./delivery.js";
import {
  detectInlineMimeType,
  normalizeMaterialInput,
  readMediaText,
  resolveMedia,
  resolveResultOutput,
  type ResolvedMediaInput,
} from "./media-input.js";
import { createSourceDirectory, matchesMime } from "./schema.js";
import { createPrompts } from "./prompts.js";
import { planModelRepresentation } from "./textualize.js";
import type {
  ModelCapabilities,
  ModelPart,
  Preparation,
  PreparationCallOptions,
  PreparationOptions,
  PreparationPlan,
  PreparationPolicy,
  SourceEntry,
  TaskMaterial,
  TaskMaterialInput,
  TaskRequirements,
} from "./types.js";

interface Delivery {
  actual: Material[];
  parts: ModelPart[];
  coverage: DeliveredMedia[];
}

function partBytes(part: ModelPart): number {
  return part.kind === "text"
    ? Buffer.byteLength(part.text)
    : part.bytes.byteLength;
}

type Route =
  | { kind: "native" }
  | {
      kind: "transform";
      adapter: RepresentationAdapter;
      parameters: Json;
    }
  | {
      kind: "model";
      recipe: "media.describe" | "speech.transcribe";
      model: string;
    };

function ruleFor<T extends { mediaType: string }>(
  mediaType: string,
  rules?: readonly T[],
): T | undefined {
  return (
    rules?.find((rule) => rule.mediaType === mediaType) ??
    rules?.find((rule) => matchesMime(rule.mediaType, mediaType))
  );
}

function canSend(model: ModelCapabilities, mediaType: string): boolean {
  const mime = isTextMedia(mediaType) ? "text/plain" : mediaType;
  return model.inputMimeTypes.some((pattern) => matchesMime(pattern, mime));
}

function covers(
  supplies: readonly ModalityNeed[],
  needs: readonly ModalityNeed[],
): boolean {
  return needs.every((need) => supplies.includes(need));
}

function unsupported(
  input: MediaInput,
  sourceKey: string,
  required: string,
): never {
  throw appError("input.capability_missing", {
    details: { sourceKey, mediaType: input.info.mediaType, required },
  });
}

function ensureCount(
  materials: readonly TaskMaterialInput[],
  requirements: TaskRequirements,
): void {
  if (
    materials.length < requirements.minMaterials ||
    (requirements.maxMaterials !== undefined &&
      materials.length > requirements.maxMaterials)
  ) {
    throw appError("input.invalid", {
      details: {
        issues: [
          {
            path: ["materials"],
            reason: "Material count is outside task requirements",
          },
        ],
      },
    });
  }
}

export function createPreparation(
  options: PreparationOptions = {},
): Preparation {
  const maxMaterialBytes = options.maxMaterialBytes ?? 67_108_864;
  const maxInlineBytes = options.maxInlineBytes ?? 8_388_608;
  let prompts = options.prompts;
  const adapters = [...(options.adapters ?? [])].sort(
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
    (adapter) => adapter.requiresNormalization !== undefined,
  );

  function supports(
    adapter: RepresentationAdapter,
    mediaType: string,
    needs: readonly ModalityNeed[],
    model: ModelCapabilities,
  ) {
    const { inputMimeTypes, supplies, outputMimeTypes } = adapter.description;
    return (
      inputMimeTypes.some((pattern) => matchesMime(pattern, mediaType)) &&
      covers(supplies, needs) &&
      outputMimeTypes.some((mime) => canSend(model, mime))
    );
  }

  async function nativeInput(
    input: MediaInput,
    model: ModelCapabilities,
    call: CallOptions,
  ): Promise<boolean> {
    const mime = input.info.mediaType;
    if (!canSend(model, mime)) return false;
    if (
      input.range &&
      !(
        isTextMedia(mime) &&
        (input.range.kind === "text" || input.range.kind === "json")
      )
    ) {
      return false;
    }
    for (const adapter of normalizers) {
      if (
        adapter.description.inputMimeTypes.some((type) =>
          matchesMime(type, mime),
        ) &&
        (await adapter.requiresNormalization?.(input, call))
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
    needs: readonly ModalityNeed[],
    model: ModelCapabilities,
    rule: NonNullable<PreparationPolicy["representations"]>[number],
  ): Promise<Route> {
    const adapter = byId.get(rule.recipe);
    if (
      !adapter ||
      !covers(model.needs, needs) ||
      !supports(adapter, input.info.mediaType, needs, model)
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
    needs: readonly ModalityNeed[],
    model: ModelCapabilities,
    call: CallOptions,
  ): Promise<Route | undefined> {
    if (!covers(model.needs, needs)) return;
    if (await nativeInput(input, model, call)) return { kind: "native" };
    for (const adapter of adapters) {
      if (!supports(adapter, input.info.mediaType, needs, model)) continue;
      if ((await adapter.available()).available)
        return transform(adapter, input, model);
    }
  }

  async function modelRoute(
    input: MediaInput,
    needs: readonly ModalityNeed[],
    model: ModelCapabilities,
    call: CallOptions,
    policy?: PreparationPolicy,
  ): Promise<Route | undefined> {
    const rule = ruleFor(input.info.mediaType, policy?.models);
    if (
      !rule ||
      !options.models ||
      !canSend(model, "text/plain") ||
      !model.needs.includes("text")
    )
      return;
    const assist = options.models.describe(rule.model).capabilities;
    const operation =
      rule.recipe === "media.describe" ? "generate" : "transcribe";
    if (
      assist.operations.includes(operation) &&
      (await installedRoute(input, needs, assist, call))
    ) {
      return { kind: "model", recipe: rule.recipe, model: rule.model };
    }
  }

  async function route(
    input: MediaInput,
    key: string,
    needs: readonly ModalityNeed[],
    model: ModelCapabilities,
    call: CallOptions,
    policy?: PreparationPolicy,
  ): Promise<Route> {
    const rule = ruleFor(input.info.mediaType, policy?.representations);
    if (rule) return explicitRoute(input, key, needs, model, rule);
    return (
      (await installedRoute(input, needs, model, call)) ??
      (await modelRoute(input, needs, model, call, policy)) ??
      unsupported(
        input,
        key,
        needs.join(", ") || "native input or representation",
      )
    );
  }

  async function part(
    input: ResolvedMediaInput,
    call: CallOptions,
    maxBytes: number,
  ): Promise<ModelPart> {
    if (isTextMedia(input.info.mediaType)) {
      return {
        kind: "text",
        text: await readMediaText(input, options.store, call, maxBytes),
      };
    }
    if (input.range) {
      throw appError("input.capability_missing", {
        details: {
          mediaType: input.info.mediaType,
          required: "representation for the selected range",
        },
      });
    }
    return {
      kind: "media",
      bytes: await readMediaBytes(input, call, maxBytes),
      mediaType: input.info.mediaType,
      ...(input.info.name === undefined ? {} : { name: input.info.name }),
    };
  }

  async function planRepresentation(
    choice: Exclude<Route, { kind: "native" }>,
    input: MediaInput,
    key: string,
    call: CallOptions,
  ) {
    if (choice.kind === "model") {
      const planned = await planModelRepresentation({
        recipe: choice.recipe,
        model: choice.model,
        input,
        call,
        models: options.models!,
        prompts: (prompts ??= createPrompts()),
        preparation,
        ...(options.mediaDescriptionDefaults === undefined
          ? {}
          : {
              descriptionDefaults: options.mediaDescriptionDefaults,
            }),
      });
      const hash = createHash("sha256")
        .update(JSON.stringify(planned.identity))
        .digest("hex");
      return {
        id: `${choice.recipe}:${hash}`,
        action: `${choice.recipe} (${choice.model})`,
        originalExtent: planned.originalExtent,
        run: planned.run,
      };
    }
    const { description } = choice.adapter;
    const parameters = description.parameters.safeParse(choice.parameters);
    if (!parameters.success) {
      throw appError("input.invalid", {
        details: {
          issues: parameters.error.issues.map((issue) => ({
            path: ["materials", key, description.id, ...issue.path.map(String)],
            reason: issue.message,
          })),
        },
      });
    }
    const identity = await choice.adapter.cacheIdentity?.();
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          description.version,
          parameters.data,
          identity ?? null,
        ]),
      )
      .digest("hex");
    return {
      id: `${description.id}:${hash}`,
      action: description.id,
      originalExtent: input.info.extent,
      async run() {
        const representation = await choice.adapter.prepare(
          input,
          parameters.data,
          call,
        );
        choice.adapter.validateForModel?.(representation, input);
        return representation;
      },
    };
  }

  async function trySavedRepresentation(
    recipe: string,
    input: MediaInput,
    call: CallOptions,
    maxBytes: number,
  ): Promise<Delivery | undefined> {
    const store = options.store;
    if (!store?.findRepresentation || !("ref" in input.source)) return;
    const source: Selection = {
      ref: input.source.ref,
      ...(input.range === undefined ? {} : { range: input.range }),
    };
    const found = store.findRepresentation(source, "model-input", recipe);
    if (!found) return;
    const saved = await store.readResult(found.result, call);
    return readOutputs(saved, found.outputs, input, call, maxBytes);
  }

  async function readOutputs(
    result: Completed | SavedResult,
    outputs: readonly string[],
    input: MediaInput,
    call: CallOptions,
    maxBytes: number,
  ): Promise<Delivery> {
    const actual: Material[] = [];
    const parts: ModelPart[] = [];
    const coverage: DeliveredMedia[] = [];
    let remainingBytes = maxBytes;
    for (const name of outputs) {
      const selected = resolveResultOutput(result, name, options.store);
      const modelPart = await part(selected, call, remainingBytes);
      remainingBytes -= partBytes(modelPart);
      actual.push(selected.source);
      parts.push(modelPart);
      coverage.push(
        deliveredMedia(input, modelPart, {
          name,
          ...(selected.coverage === undefined
            ? {}
            : { coverage: selected.coverage }),
        }),
      );
    }
    return { actual, parts, coverage };
  }

  async function materialize(
    recipe: { id: string; run(): Promise<PreparedRepresentation> },
    input: MediaInput,
    call: CallOptions,
    maxBytes: number,
  ): Promise<Delivery> {
    let { result, outputs } = await recipe.run();
    if ("ref" in input.source) {
      result = {
        ...result,
        representation: {
          source: input.source,
          recipe: recipe.id,
          outputs: [...outputs],
        },
      };
    }
    return readOutputs(result, outputs, input, call, maxBytes);
  }

  async function readSource(
    source: Material,
    key: string,
    signal: AbortSignal,
  ): Promise<ResolvedMediaInput> {
    const input = await resolveMedia(source, options.store, { signal });
    if (input.range) {
      const parsed = rangeSchema.safeParse(input.range);
      if (!parsed.success)
        throw appError("content.range_invalid", {
          details: { sourceKey: key, reason: "invalid material selection" },
        });
    }
    if ("bytes" in input.source) {
      if (input.source.bytes.byteLength > maxInlineBytes) {
        throw appError("content.inline_too_large", {
          details: {
            sourceKey: key,
            actualBytes: input.source.bytes.byteLength,
            maxBytes: maxInlineBytes,
          },
        });
      }
      await detectInlineMimeType(
        input.source.bytes,
        input.info.mediaType,
        input.info.name,
      );
    }
    const byteSelection =
      isTextMedia(input.info.mediaType) && input.range?.kind === "text";
    const inputBytes = byteSelection
      ? input.range.end - input.range.start
      : input.info.sizeBytes;
    if (inputBytes > maxMaterialBytes) {
      throw appError("model.input_too_large", {
        details: {
          sourceKey: key,
          actualBytes: inputBytes,
          maxBytes: maxMaterialBytes,
        },
      });
    }
    throwIfAborted(signal);
    return input;
  }

  async function originalInfo(
    input: ResolvedMediaInput,
    call: CallOptions,
    selectedAdapter?: RepresentationAdapter,
  ): Promise<ResolvedMediaInput> {
    if (input.info.extent.kind !== "unknown") return input;
    if (selectedAdapter) {
      const extent = await selectedAdapter.probe(input, call);
      return { ...input, info: { ...input.info, extent } };
    }
    for (const adapter of adapters) {
      if (
        !adapter.description.inputMimeTypes.some((mime) =>
          matchesMime(mime, input.info.mediaType),
        )
      )
        continue;
      if (!(await adapter.available()).available) continue;
      try {
        const extent = await adapter.probe(input, call);
        if (extent.kind !== "unknown")
          return { ...input, info: { ...input.info, extent } };
      } catch (error) {
        throwIfAborted(call.signal);
        // Optional metadata readers may lack a decoder for an otherwise valid native input.
        if (
          !(error instanceof AppError) ||
          !["content.decode_failed", "input.capability_missing"].includes(
            error.code,
          )
        )
          throw error;
      }
    }
    return input;
  }

  async function prepareSource(
    inputMaterial: TaskMaterial,
    key: string,
    requirements: TaskRequirements,
    model: ModelCapabilities,
    call: PreparationCallOptions,
    preview: boolean,
    remainingBytes: number,
  ) {
    const source = await readSource(inputMaterial.source, key, call.signal!);
    const wanted = ruleFor(source.info.mediaType, requirements.inputs);
    if (!wanted) return unsupported(source, key, "task input media type");
    const choice = await route(
      source,
      key,
      wanted.needs,
      model,
      call,
      call.preparation,
    );
    const input =
      choice.kind === "model"
        ? source
        : await originalInfo(
            source,
            call,
            choice.kind === "transform" ? choice.adapter : undefined,
          );
    const recipe =
      choice.kind === "native"
        ? undefined
        : await planRepresentation(choice, input, key, call);
    const role = inputMaterial.role ?? "primary";
    const entry: SourceEntry = {
      key,
      role,
      mediaType: input.info.mediaType,
      originalExtent: recipe?.originalExtent ?? input.info.extent,
      requestedRange: input.range ?? null,
      delivered: [],
      ...(input.info.name === undefined ? {} : { name: input.info.name }),
    };
    let delivered: Delivery;
    if (!recipe) {
      const native = await part(input, call, remainingBytes);
      delivered = {
        actual: [input.source],
        parts: [native],
        coverage: [deliveredMedia(input, native)],
      };
    } else {
      const cached = await trySavedRepresentation(
        recipe.id,
        input,
        call,
        remainingBytes,
      );
      if (preview && !cached) {
        const action = recipe.action;
        return {
          entry,
          input,
          pending: {
            sourceKey: key,
            action,
            requiresModel: choice.kind === "model",
          },
          parts: [{ kind: "text" as const, text: `<pending: ${action}>` }],
        };
      }
      delivered =
        cached ?? (await materialize(recipe, input, call, remainingBytes));
    }
    return {
      entry: { ...entry, delivered: delivered.coverage },
      input,
      parts: delivered.parts,
      use: {
        source: input.source,
        delivered: delivered.actual,
        role,
        coverage: {
          originalExtent: entry.originalExtent,
          requestedRange: entry.requestedRange,
          delivered: delivered.coverage,
        },
      } satisfies InputUse,
    };
  }

  function checkParts(
    previous: { bytes: number; images: number },
    parts: readonly ModelPart[],
    model: ModelCapabilities,
    input: MediaInput,
    key: string,
    maxBytes: number,
  ) {
    for (const part of parts) {
      const mime = part.kind === "text" ? "text/plain" : part.mediaType;
      if (!canSend(model, mime))
        return unsupported(input, key, `model input supporting ${mime}`);
      previous.bytes += partBytes(part);
      if (part.kind === "media" && part.mediaType.startsWith("image/"))
        previous.images++;
    }
    if (previous.bytes > maxBytes)
      throw appError("model.input_too_large", {
        details: {
          sourceKey: key,
          actualBytes: previous.bytes,
          maxBytes,
        },
      });
    const maxImages = model.limits?.maxImages ?? Infinity;
    if (previous.images > maxImages)
      return unsupported(input, key, "image count ≤ " + maxImages);
  }

  async function prepare(
    inputMaterials: readonly TaskMaterialInput[],
    requirements: TaskRequirements,
    model: ModelCapabilities,
    optionsForCall: PreparationCallOptions | undefined,
    preview: boolean,
  ) {
    const call = openCall(
      preview ? "tasks.preview" : "tasks.prepare",
      optionsForCall,
    );
    const callOptions: PreparationCallOptions = {
      ...optionsForCall,
      signal: call.signal,
    };
    const maxBytes = Math.min(
      maxMaterialBytes,
      model.limits?.maxInputBytes ?? Infinity,
    );
    const entries: SourceEntry[] = [];
    const uses: InputUse[] = [];
    const parts: ModelPart[] = [];
    const pending: PreparationPlan["pending"][number][] = [];
    const budget = { bytes: 0, images: 0 };
    try {
      ensureCount(inputMaterials, requirements);
      for (const [index, raw] of inputMaterials.entries()) {
        const key = "S" + (index + 1);
        call.throwIfAborted("prepare");
        const normalized = await normalizeMaterialInput(
          raw,
          maxInlineBytes,
          call.signal,
        );
        const prepared = await prepareSource(
          normalized,
          key,
          requirements,
          model,
          callOptions,
          preview,
          maxBytes - budget.bytes,
        );
        entries.push(prepared.entry);
        parts.push({ kind: "text", text: `[${key}]\n` }, ...prepared.parts);
        if (prepared.pending) pending.push(prepared.pending);
        else {
          uses.push(prepared.use);
          checkParts(
            budget,
            prepared.parts,
            model,
            prepared.input,
            key,
            maxBytes,
          );
        }
        call.progress({
          stage: "prepare",
          completed: index + 1,
          total: inputMaterials.length,
          unit: "materials",
        });
      }
      return { parts, uses, pending, sources: createSourceDirectory(entries) };
    } catch (error) {
      call.throwIfAborted();
      if (error instanceof AppError) throw error;
      throw appError("content.decode_failed", {
        details: { reason: String(error) },
        cause: error,
      });
    } finally {
      call.close();
    }
  }

  const preparation: Preparation = {
    async plan(materials, requirements, model, optionsForCall) {
      const { sources, parts, pending } = await prepare(
        materials,
        requirements,
        model,
        optionsForCall,
        true,
      );
      return { sources, readyParts: parts, pending };
    },
    async forModel(materials, requirements, model, optionsForCall) {
      const { sources, parts, uses } = await prepare(
        materials,
        requirements,
        model,
        optionsForCall,
        false,
      );
      return { sources, parts, uses };
    },
  };
  return preparation;
}
