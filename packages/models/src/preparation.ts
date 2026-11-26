import { createHash } from "node:crypto";
import {
  AppError,
  appError,
  assertResultSource,
  defaultInlineMaterialBytes,
  defaultMediaInputBytes,
  isTextMedia,
  modelInputRepresentationPurpose,
  openCall,
  parseValue,
  readMediaBytes,
  rangeSchema,
  throwIfAborted,
  type CallOptions,
  type CallScope,
  type Completed,
  type DeliveredMedia,
  type InputUse,
  type Material,
  type MediaInput,
  type PreparedRepresentation,
  type RepresentationAdapter,
  type SavedResult,
  type Selection,
} from "@themelios/core";
import {
  deliveredMedia,
  modelAcceptsMedia,
  partBytes,
  partMediaType,
} from "./delivery.js";
import {
  accepts,
  adapterAcceptsSource,
  canSend,
  createRepresentationRouting,
  mediaModalities,
  ruleFor,
  unsupported,
  type AcceptedModalities,
  type Route,
} from "./representation-route.js";
import {
  readMediaText,
  resolveMedia,
  resolveResultOutput,
  type ResolvedMediaInput,
} from "./media-input.js";
import {
  createSourceDirectory,
  sourceDirectoryFromInputs,
  taskRepresentationSchema,
} from "./schema.js";
import { planModelRepresentation } from "./textualize.js";
import type {
  ModelCapabilities,
  ModelPart,
  Models,
  Preparation,
  PreparationCallOptions,
  PreparationOptions,
  PreparationPreview,
  Prompts,
  SourceEntry,
  TaskMaterial,
  TaskSource,
  TaskRepresentation,
  TaskRequirements,
  TaskRoute,
} from "./types.js";

interface DeliveredPart {
  readonly material: Material;
  readonly part: ModelPart;
  readonly coverage: DeliveredMedia;
}

interface Delivery {
  readonly parts: readonly DeliveredPart[];
}

interface PendingDelivery {
  readonly action: string;
  readonly requiresModel: boolean;
  materialize(call: CallOptions, maxBytes: number): Promise<Delivery>;
}

interface PlannedSource {
  readonly input: ResolvedMediaInput;
  readonly entry: Omit<SourceEntry, "delivered">;
  readonly delivery: Delivery | PendingDelivery;
}

function sourceEntry(
  input: MediaInput,
  key: string,
  role: SourceEntry["role"],
  originalExtent: SourceEntry["originalExtent"],
): PlannedSource["entry"] {
  const { mediaType, name } = input.info;
  return {
    key,
    role,
    mediaType,
    originalExtent,
    requestedRange: input.range ?? null,
    ...(name === undefined ? {} : { name }),
  };
}

function sourceMarker(key: string): ModelPart {
  return { kind: "text", text: "[" + key + "]\n" };
}

function preparationError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return appError("content.decode_failed", {
    details: { reason: String(error) },
    cause: error,
  });
}

function ensureCount(
  materials: readonly TaskMaterial[],
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
  return createPreparationEngine(options);
}

export function createPreparationEngine(
  options: PreparationOptions,
  assistance?: {
    readonly models: Models;
    readonly prompts: Prompts;
    readonly taskRoute: (taskId: string) => TaskRoute | undefined;
  },
): Preparation {
  const maxMaterialBytes = options.maxMaterialBytes ?? defaultMediaInputBytes;
  const maxInlineBytes = options.maxInlineBytes ?? defaultInlineMaterialBytes;
  const { adapters, route } = createRepresentationRouting(
    options.adapters,
    assistance?.models,
  );

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
    alternatives: AcceptedModalities,
  ) {
    if (choice.kind === "model") {
      const planned = await planModelRepresentation({
        recipe: choice.recipe,
        model: choice.model,
        input,
        call,
        ...assistance!,
        preparation,
        alternatives,
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
      async run(options: CallOptions) {
        const representation = await choice.adapter.prepare(
          input,
          parameters.data,
          options,
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
    if (!store?.representations || !("ref" in input.source)) return;
    const source: Selection = {
      ref: input.source.ref,
      ...(input.range === undefined ? {} : { range: input.range }),
    };
    const found = await store.representations.read(
      source,
      modelInputRepresentationPurpose,
      recipe,
      call,
    );
    if (!found) return;
    return readOutputs(found.result, found.outputs, input, call, maxBytes);
  }

  async function readOutputs(
    result: Completed | SavedResult,
    outputs: readonly string[],
    input: MediaInput,
    call: CallOptions,
    maxBytes: number,
  ): Promise<Delivery> {
    const parts: DeliveredPart[] = [];
    let remainingBytes = maxBytes;
    for (const name of outputs) {
      const selected = resolveResultOutput(result, name, options.store);
      const delivered = await outputPart(
        selected,
        name,
        input,
        call,
        remainingBytes,
      );
      remainingBytes -= partBytes(delivered.part);
      parts.push(delivered);
    }
    return { parts };
  }

  async function outputPart(
    selected: ResolvedMediaInput,
    name: string,
    source: MediaInput,
    call: CallOptions,
    maxBytes: number,
  ): Promise<DeliveredPart> {
    const modelPart = await part(selected, call, maxBytes);
    return {
      material: selected.source,
      part: modelPart,
      coverage: deliveredMedia(source, modelPart, {
        name,
        ...(selected.coverage === undefined
          ? {}
          : { coverage: selected.coverage }),
      }),
    };
  }

  async function materialize(
    recipe: {
      id: string;
      run(call: CallOptions): Promise<PreparedRepresentation>;
    },
    input: MediaInput,
    call: CallOptions,
    maxBytes: number,
  ): Promise<Delivery> {
    let { result, outputs } = await recipe.run(call);
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
    source: TaskSource,
    key: string,
    signal: AbortSignal,
    metadataOnly = false,
  ): Promise<ResolvedMediaInput> {
    const input = await resolveMedia(
      source,
      options.store,
      { signal },
      maxInlineBytes,
      key,
    );
    if (input.range) {
      const parsed = rangeSchema.safeParse(input.range);
      if (!parsed.success)
        throw appError("content.range_invalid", {
          details: { sourceKey: key, reason: "invalid material selection" },
        });
    }
    if (metadataOnly) return input;
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
      if (!adapterAcceptsSource(adapter, input.info.mediaType)) continue;
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

  async function planLinkedRepresentation(
    source: ResolvedMediaInput,
    entry: PlannedSource["entry"],
    supplied: TaskRepresentation,
    alternatives: AcceptedModalities,
    model: ModelCapabilities,
    call: CallOptions,
    remainingBytes: number,
  ): Promise<PlannedSource> {
    const saved = await options.store!.results.read(supplied.result, call);
    assertResultSource(saved, source.storedSelection!, [supplied.output]);
    const represented = resolveResultOutput(
      saved,
      supplied.output,
      options.store,
    );
    if (!represented.coverage)
      return unsupported(
        source,
        entry.key,
        "a named result output with recorded coverage",
      );
    if (
      !accepts(
        alternatives,
        model.needs,
        mediaModalities(represented.info.mediaType),
      ) ||
      !canSend(model, represented.info.mediaType)
    )
      return unsupported(
        source,
        entry.key,
        "a selected representation that the model and task accept",
      );
    return {
      input: source,
      entry,
      delivery: {
        parts: [
          await outputPart(
            represented,
            supplied.output,
            source,
            call,
            remainingBytes,
          ),
        ],
      },
    };
  }

  async function prepareSource(
    inputMaterial: TaskMaterial,
    key: string,
    requirements: TaskRequirements,
    model: ModelCapabilities,
    call: PreparationCallOptions,
    remainingBytes: number,
  ): Promise<PlannedSource> {
    const supplied =
      inputMaterial.representation === undefined
        ? undefined
        : parseValue(
            taskRepresentationSchema,
            inputMaterial.representation,
            "input.invalid",
          );
    if (supplied && !("ref" in inputMaterial.source))
      throw appError("input.invalid", {
        details: {
          issues: [
            {
              path: ["materials", key, "source"],
              reason: "A representation requires an original stored selection",
            },
          ],
        },
      });
    const source = await readSource(
      inputMaterial.source,
      key,
      call.signal!,
      supplied !== undefined,
    );
    const wanted = ruleFor(source.info.mediaType, requirements.inputs);
    if (!wanted) return unsupported(source, key, "task input media type");
    const role = inputMaterial.role ?? "primary";
    if (supplied)
      return planLinkedRepresentation(
        source,
        sourceEntry(source, key, role, source.info.extent),
        supplied,
        wanted.accepts,
        model,
        call,
        remainingBytes,
      );
    const choice = await route(
      source,
      key,
      wanted.accepts,
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
        : await planRepresentation(choice, input, key, call, wanted.accepts);
    const entry = sourceEntry(
      input,
      key,
      role,
      recipe?.originalExtent ?? input.info.extent,
    );
    if (!recipe) {
      const native = await part(input, call, remainingBytes);
      return {
        entry,
        input,
        delivery: {
          parts: [
            {
              material: input.source,
              part: native,
              coverage: deliveredMedia(input, native),
            },
          ],
        },
      };
    }
    const cached = await trySavedRepresentation(
      recipe.id,
      input,
      call,
      remainingBytes,
    );
    return {
      entry,
      input,
      delivery: cached ?? {
        action: recipe.action,
        requiresModel: choice.kind === "model",
        materialize: (options, maxBytes) =>
          materialize(recipe, input, options, maxBytes),
      },
    };
  }

  function checkParts(
    previous: { bytes: number; images: number },
    parts: readonly DeliveredPart[],
    model: ModelCapabilities,
    input: MediaInput,
    key: string,
    maxBytes: number,
  ) {
    for (const { part } of parts) {
      const mime = partMediaType(part);
      if (!modelAcceptsMedia(model, mime))
        return unsupported(input, key, `model input supporting ${mime}`);
      previous.bytes += partBytes(part);
      if (mime.startsWith("image/")) previous.images++;
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

  async function usePlan<T>(
    inputMaterials: readonly TaskMaterial[],
    requirements: TaskRequirements,
    model: ModelCapabilities,
    optionsForCall: PreparationCallOptions | undefined,
    finish: (
      planned: readonly PlannedSource[],
      maxBytes: number,
      call: CallScope,
    ) => T | Promise<T>,
  ): Promise<T> {
    const call = openCall("tasks.prepare", optionsForCall);
    const callOptions: PreparationCallOptions = {
      ...optionsForCall,
      signal: call.signal,
    };
    const maxBytes = Math.min(
      maxMaterialBytes,
      model.limits?.maxInputBytes ?? Infinity,
    );
    const planned: PlannedSource[] = [];
    const budget = { bytes: 0, images: 0 };
    try {
      ensureCount(inputMaterials, requirements);
      for (const [index, material] of inputMaterials.entries()) {
        const key = "S" + (index + 1);
        call.throwIfAborted("prepare");
        const source = await prepareSource(
          material,
          key,
          requirements,
          model,
          callOptions,
          maxBytes - budget.bytes,
        );
        planned.push(source);
        if ("parts" in source.delivery)
          checkParts(
            budget,
            source.delivery.parts,
            model,
            source.input,
            key,
            maxBytes,
          );
        call.progress({
          stage: "prepare",
          completed: index + 1,
          total: inputMaterials.length,
          unit: "materials",
        });
      }
      call.throwIfAborted();
      return await finish(planned, maxBytes, call);
    } catch (error) {
      call.throwIfAborted();
      throw preparationError(error);
    } finally {
      call.close();
    }
  }

  const preparation: Preparation = {
    preview(inputMaterials, requirements, model, optionsForCall) {
      return usePlan(
        inputMaterials,
        requirements,
        model,
        optionsForCall,
        (planned): PreparationPreview => {
          const entries: SourceEntry[] = [];
          const readyParts: ModelPart[] = [];
          const pending: PreparationPreview["pending"][number][] = [];
          for (const { entry, delivery } of planned) {
            readyParts.push(sourceMarker(entry.key));
            if ("parts" in delivery) {
              entries.push({
                ...entry,
                delivered: delivery.parts.map(({ coverage }) => coverage),
              });
              readyParts.push(...delivery.parts.map(({ part }) => part));
            } else {
              const { action, requiresModel } = delivery;
              entries.push({ ...entry, delivered: [] });
              readyParts.push({
                kind: "text",
                text: "<pending: " + action + ">",
              });
              pending.push({ sourceKey: entry.key, action, requiresModel });
            }
          }
          return {
            sources: { entries: createSourceDirectory(entries).entries },
            readyParts,
            pending,
          };
        },
      );
    },
    prepare(inputMaterials, requirements, model, optionsForCall) {
      return usePlan(
        inputMaterials,
        requirements,
        model,
        optionsForCall,
        async (planned, maxBytes, call) => {
          const budget = { bytes: 0, images: 0 };
          const parts: ModelPart[] = [];
          const uses: InputUse[] = [];
          for (const { input, entry, delivery } of planned) {
            call.throwIfAborted("prepare");
            const sent =
              "parts" in delivery
                ? delivery
                : await delivery.materialize(
                    { signal: call.signal },
                    maxBytes - budget.bytes,
                  );
            checkParts(budget, sent.parts, model, input, entry.key, maxBytes);
            parts.push(
              sourceMarker(entry.key),
              ...sent.parts.map(({ part }) => part),
            );
            const {
              key,
              mediaType,
              name,
              role,
              originalExtent,
              requestedRange,
            } = entry;
            uses.push({
              key,
              original:
                name === undefined ? { mediaType } : { mediaType, name },
              source: input.source,
              delivered: sent.parts.map(({ material }) => material),
              role,
              coverage: {
                originalExtent,
                requestedRange,
                delivered: sent.parts.map(({ coverage }) => coverage),
              },
            });
          }
          call.throwIfAborted();
          return { sources: sourceDirectoryFromInputs(uses), parts, uses };
        },
      );
    },
  };
  return preparation;
}
