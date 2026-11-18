import { createHash } from "node:crypto";
import {
  AppError,
  appError,
  openCall,
  throwIfAborted,
  type CallOptions,
  type InputUse,
  type Json,
  type Material,
  type Selection,
} from "@themelios/core";
import {
  detectInlineMimeType,
  isTextMedia,
  normalizeMaterialInput,
  rangeDescription,
  readMediaBytes,
  readMediaText,
  resolveMedia,
} from "./media-input.js";
import { createSourceDirectory, matchesMime } from "./schema.js";
import {
  createMediaDescriptionInlineTask,
  prepareModelRepresentation,
} from "./textualize.js";
import type {
  MediaInput,
  ModalityNeed,
  ModelCapabilities,
  ModelPart,
  Preparation,
  PreparationCallOptions,
  PreparationOptions,
  PreparationPlan,
  PreparationPolicy,
  PreparedRepresentation,
  RepresentationAdapter,
  SourceEntry,
  TaskMaterial,
  TaskMaterialInput,
  TaskRequirements,
} from "./types.js";

export { readMediaBytes, rangeDescription } from "./media-input.js";

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
    const knownImage = ["image/jpeg", "image/png", "image/webp"].includes(mime);
    if (!knownImage || !options.imageNeedsOrientation) return true;
    return !(await options.imageNeedsOrientation(input, call));
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

  function modelRoute(
    input: MediaInput,
    needs: readonly ModalityNeed[],
    model: ModelCapabilities,
    policy?: PreparationPolicy,
  ): Route | undefined {
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
    if (covers(assist.needs, needs) && assist.operations.includes(operation)) {
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
      modelRoute(input, needs, model, policy) ??
      unsupported(
        input,
        key,
        needs.join(", ") || "native input or representation",
      )
    );
  }

  async function part(
    input: MediaInput,
    call: CallOptions,
    maxBytes: number,
  ): Promise<ModelPart> {
    if (isTextMedia(input.info.mediaType)) {
      return {
        kind: "text",
        text: await readMediaText(input, options.store, call, maxBytes),
      };
    }
    return {
      kind: "media",
      bytes: await readMediaBytes(input, call, maxBytes),
      mediaType: input.info.mediaType,
      ...(input.info.name === undefined ? {} : { name: input.info.name }),
    };
  }

  function representationRecipe(
    choice: Exclude<Route, { kind: "native" }>,
    key: string,
  ): { id: string; parameters?: Json } {
    if (choice.kind === "model") {
      const templates =
        choice.recipe === "media.describe"
          ? createMediaDescriptionInlineTask().templates
          : null;
      const binding =
        options.modelIdentity?.(choice.model) ??
        options.models?.describe(choice.model);
      const hash = createHash("sha256")
        .update(JSON.stringify({ binding, templates }))
        .digest("hex");
      return { id: `${choice.recipe}:${hash}` };
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
    const hash = createHash("sha256")
      .update(JSON.stringify([description.version, parameters.data]))
      .digest("hex");
    return { id: `${description.id}:${hash}`, parameters: parameters.data };
  }

  async function trySavedRepresentation(
    recipe: string,
    input: MediaInput,
    call: CallOptions,
    maxBytes: number,
  ): Promise<
    { actual: Material[]; parts: ModelPart[]; coverage: string[] } | undefined
  > {
    const store = options.store;
    if (!store?.findRepresentation || !("ref" in input.source)) return;
    const source: Selection = {
      ref: input.source.ref,
      ...(input.range === undefined ? {} : { range: input.range }),
    };
    const found = store.findRepresentation(source, "model-input", recipe);
    if (!found) return;
    const saved = await store.readResult(found.result, call);
    const actual: Material[] = found.outputs.map((output) => ({
      result: saved,
      output,
    }));
    const parts: ModelPart[] = [];
    for (const selected of actual)
      parts.push(await part(resolveMedia(selected, store), call, maxBytes));
    return { actual, parts, coverage: describeOutputs(input, found.outputs) };
  }

  function describeOutputs(input: MediaInput, outputs: readonly string[]) {
    const extent = rangeDescription(input);
    return outputs.map((output) =>
      outputs.length > 1 ? `${extent} (${output})` : extent,
    );
  }

  async function materialize(
    choice: Route,
    input: MediaInput,
    key: string,
    call: CallOptions,
    maxBytes: number,
  ): Promise<{ actual: Material[]; parts: ModelPart[]; coverage: string[] }> {
    if (choice.kind === "native") {
      return {
        actual: [input.source],
        parts: [await part(input, call, maxBytes)],
        coverage: [rangeDescription(input)],
      };
    }
    const recipe = representationRecipe(choice, key);
    const reused = await trySavedRepresentation(
      recipe.id,
      input,
      call,
      maxBytes,
    );
    if (reused) return reused;

    let representation: PreparedRepresentation;
    if (choice.kind === "transform") {
      representation = await choice.adapter.prepare(
        input,
        recipe.parameters ?? {},
        call,
      );
      choice.adapter.validateForModel?.(representation, input);
    } else {
      representation = await prepareModelRepresentation({
        recipe: choice.recipe,
        model: choice.model,
        input,
        call,
        models: options.models!,
        ...(options.prompts ? { prompts: options.prompts } : {}),
        preparation,
        maxMaterialBytes,
        readPart: part,
      });
    }
    let { result } = representation;
    const { outputs } = representation;
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
    const actual = outputs.map((output) => ({ result, output }));
    const parts: ModelPart[] = [];
    for (const item of actual) {
      parts.push(await part(resolveMedia(item, options.store), call, maxBytes));
    }
    return {
      actual,
      parts,
      coverage: describeOutputs(input, outputs),
    };
  }

  async function readSource(
    source: Material,
    key: string,
    signal: AbortSignal,
  ): Promise<MediaInput> {
    const input = resolveMedia(source, options.store);
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
    if (input.info.sizeBytes > maxMaterialBytes) {
      throw appError("model.input_too_large", {
        details: {
          sourceKey: key,
          actualBytes: input.info.sizeBytes,
          maxBytes: maxMaterialBytes,
        },
      });
    }
    throwIfAborted(signal);
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
    const input = await readSource(inputMaterial.source, key, call.signal!);
    const wanted = ruleFor(input.info.mediaType, requirements.inputs);
    if (!wanted) return unsupported(input, key, "task input media type");
    const choice = await route(
      input,
      key,
      wanted.needs,
      model,
      call,
      call.preparation,
    );
    const role = inputMaterial.role ?? "primary";
    const entry: SourceEntry = {
      key,
      role,
      mediaType: input.info.mediaType,
      originalExtent: rangeDescription(input),
      deliveredExtent: [],
      ...(input.info.name === undefined ? {} : { name: input.info.name }),
    };
    const cached =
      preview && choice.kind !== "native"
        ? await trySavedRepresentation(
            representationRecipe(choice, key).id,
            input,
            call,
            remainingBytes,
          )
        : undefined;
    if (preview && choice.kind !== "native" && !cached) {
      const action =
        choice.kind === "model"
          ? `${choice.recipe} (${choice.model})`
          : choice.adapter.description.id;
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
    const delivered =
      cached ?? (await materialize(choice, input, key, call, remainingBytes));
    return {
      entry: { ...entry, deliveredExtent: delivered.coverage },
      input,
      parts: delivered.parts,
      use: {
        source: input.source,
        delivered: delivered.actual,
        role,
      } as InputUse,
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
      previous.bytes +=
        part.kind === "text"
          ? Buffer.byteLength(part.text)
          : part.bytes.byteLength;
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
