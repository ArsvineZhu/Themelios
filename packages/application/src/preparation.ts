import { probeMediaType } from "@themelios/content";
import {
  appError,
  type CallOptions,
  type InputUse,
  type Json,
  type Material,
  openCall,
} from "@themelios/core";
import {
  matchesMime,
  type ModelCapabilities,
  type ModelPart,
  type ModalityNeed,
} from "@themelios/models";
import {
  createSourceDirectory,
  type SourceEntry,
  type TaskMaterial,
  type TaskRequirements,
} from "@themelios/models/tasks";
import { createImageAdapter, imageNeedsOrientation } from "./image.js";
import type {
  MediaInput,
  Preparation,
  PreparationCallOptions,
  PreparationOptions,
  PreparationPlan,
  PreparationPolicy,
  PreparedRepresentation,
  RepresentationAdapter,
} from "./input-contracts.js";
import { readMediaBytes } from "./media-bytes.js";
import {
  materialBytes,
  rangeDescription,
  readMediaText,
  resolveMedia,
  type ResolvedMediaInput,
} from "./resolve-media.js";
import { createTextualize } from "./textualize.js";

export type InternalPreparationOptions = PreparationCallOptions & {
  allowEmptyPdfPages?: boolean;
};

type Route =
  | { kind: "native" }
  | { kind: "transform"; adapter: RepresentationAdapter; parameters: Json }
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

function isText(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json")
  );
}

function canSend(model: ModelCapabilities, mediaType: string): boolean {
  const mime = isText(mediaType) ? "text/plain" : mediaType;
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

function imageParameters(
  parameters: Json | undefined,
  input: MediaInput,
  model: ModelCapabilities,
): Json {
  if (
    parameters !== undefined &&
    (parameters === null ||
      typeof parameters !== "object" ||
      Array.isArray(parameters))
  ) {
    return parameters;
  }
  const options = parameters ?? {};
  if (options.format !== undefined && options.format !== "source")
    return options;
  if (canSend(model, input.info.mediaType)) return options;
  const format = (["png", "jpeg", "webp"] as const).find((candidate) =>
    canSend(model, "image/" + candidate),
  );
  return format === undefined ? options : { ...options, format };
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
  const maxMaterialBytes = options.maxMaterialBytes ?? 67_108_864;
  const maxInlineBytes = options.maxInlineBytes ?? 8_388_608;
  const maxImagePixels = options.maxImagePixels ?? 40_000_000;
  const configured = options.adapters ?? [];
  const adapters = [
    ...configured,
    ...(configured.some(
      (adapter) => adapter.description.id === "image.normalize",
    )
      ? []
      : [
          createImageAdapter({
            maxPixels: maxImagePixels,
            maxBytes: maxMaterialBytes,
          }),
        ]),
  ].sort(
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
    if (input.range && !logicalTextRange(mime, input.range.kind)) return false;
    const knownImage = ["image/jpeg", "image/png", "image/webp"].includes(mime);
    return (
      !knownImage ||
      !(await imageNeedsOrientation(
        input,
        maxImagePixels,
        call,
        maxMaterialBytes,
      ))
    );
  }
  function logicalTextRange(mime: string, kind: string) {
    return isText(mime) && (kind === "text" || kind === "json");
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
        adapter.description.id === "image.normalize"
          ? imageParameters(parameters, input, model)
          : (parameters ?? {}),
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
      !options.prompts ||
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
    input: ResolvedMediaInput,
    call: CallOptions,
    maxBytes: number,
  ): Promise<ModelPart> {
    if (isText(input.info.mediaType)) {
      return {
        kind: "text",
        text: await readMediaText(input, options.materials, call, maxBytes),
      };
    }
    return {
      kind: "media",
      bytes: await readMediaBytes(input, call, maxBytes),
      mediaType: input.info.mediaType,
      ...(input.info.name === undefined ? {} : { name: input.info.name }),
    };
  }
  const preparation: Preparation = {
    async plan(materials, requirements, model, options) {
      const { sources, parts, pending } = await prepare(
        materials,
        requirements,
        model,
        options,
        true,
      );
      return { sources, readyParts: parts, pending };
    },
    async forModel(materials, requirements, model, options) {
      const { sources, parts, uses } = await prepare(
        materials,
        requirements,
        model,
        options,
        false,
      );
      return { sources, parts, uses };
    },
  };
  async function materialize(
    choice: Route,
    input: ResolvedMediaInput,
    key: string,
    call: CallOptions,
    maxBytes: number,
    emptyPdfPages: boolean,
  ): Promise<{ actual: Material[]; parts: ModelPart[]; coverage: string[] }> {
    if (choice.kind === "native")
      return {
        actual: [input.source],
        parts: [await part(input, call, maxBytes)],
        coverage: [rangeDescription(input)],
      };
    let representation: PreparedRepresentation;
    if (choice.kind === "transform") {
      const adapter = choice.adapter;
      const parameters = adapter.description.parameters.safeParse(
        choice.parameters,
      );
      if (!parameters.success)
        throw appError("input.invalid", {
          details: {
            issues: parameters.error.issues.map((issue) => ({
              path: [
                "materials",
                key,
                adapter.description.id,
                ...issue.path.map(String),
              ],
              reason: issue.message,
            })),
          },
        });
      representation = await adapter.prepare(input, choice.parameters, call);
      const value = representation.result.value;
      if (
        adapter.description.id === "pdf.text" &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Array.isArray(value.emptyPages) &&
        value.emptyPages.length &&
        !emptyPdfPages
      ) {
        throw appError("input.capability_missing", {
          details: {
            sourceKey: key,
            mediaType: input.info.mediaType,
            required: "text on every selected PDF page; use a visual route",
            emptyPages: value.emptyPages,
          },
        });
      }
    } else {
      const result = await createTextualize({
        models: options.models!,
        prompts: options.prompts!,
        preparation,
        ...(options.materials === undefined
          ? {}
          : { materials: options.materials }),
      }).run(
        {
          material: input.source,
          mode: choice.recipe === "media.describe" ? "describe" : "transcribe",
          model: choice.model,
        },
        call,
      );
      representation = { result, outputs: ["text.txt"] };
    }
    const { result, outputs } = representation;
    const actual = outputs.map((output) => ({ result, output }));
    const parts: ModelPart[] = [];
    for (const item of actual) {
      const representation = resolveMedia(item, options.materials);
      parts.push(await part(representation, call, maxBytes));
    }
    return {
      actual,
      parts,
      coverage: outputs.map(
        (output) =>
          result.producer.name +
          ": " +
          output +
          " from " +
          rangeDescription(input),
      ),
    };
  }
  function captureMaterials(
    input: readonly TaskMaterial[],
    requirements: TaskRequirements,
  ): readonly TaskMaterial[] {
    ensureCount(input, requirements);
    for (const [index, { source }] of input.entries()) {
      if ("bytes" in source && source.bytes.byteLength > maxInlineBytes) {
        throw appError("content.inline_too_large", {
          details: {
            sourceKey: "S" + (index + 1),
            actualBytes: source.bytes.byteLength,
            maxBytes: maxInlineBytes,
          },
        });
      }
    }
    return structuredClone(input);
  }
  async function readSource(
    source: Material,
    key: string,
  ): Promise<ResolvedMediaInput> {
    const input = resolveMedia(source, options.materials);
    if ("bytes" in input.source)
      await probeMediaType(
        input.source.bytes.subarray(0, 16_384),
        input.info.mediaType,
      );
    if (materialBytes(input) > maxMaterialBytes)
      throw appError("model.input_too_large", {
        details: {
          sourceKey: key,
          actualBytes: materialBytes(input),
          maxBytes: maxMaterialBytes,
        },
      });
    return input;
  }
  async function prepareSource(
    inputMaterial: TaskMaterial,
    key: string,
    requirements: TaskRequirements,
    model: ModelCapabilities,
    call: InternalPreparationOptions,
    preview: boolean,
    remainingBytes: number,
  ) {
    const input = await readSource(inputMaterial.source, key);
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
    if (preview && choice.kind !== "native") {
      const action =
        choice.kind === "model"
          ? choice.recipe + " (" + choice.model + ")"
          : choice.adapter.description.id;
      return {
        entry,
        input,
        pending: {
          sourceKey: key,
          action,
          requiresModel: choice.kind === "model",
        },
        parts: [{ kind: "text" as const, text: "<pending: " + action + ">" }],
      };
    }
    const delivered = await materialize(
      choice,
      input,
      key,
      call,
      remainingBytes,
      call.allowEmptyPdfPages ?? false,
    );
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
    inputMaterials: readonly TaskMaterial[],
    requirements: TaskRequirements,
    model: ModelCapabilities,
    optionsForCall: InternalPreparationOptions | undefined,
    preview: boolean,
  ) {
    const call = openCall(
      preview ? "tasks.preview" : "tasks.prepare",
      optionsForCall,
    );
    const callOptions: InternalPreparationOptions = {
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
      const captured = captureMaterials(inputMaterials, requirements);
      for (const [index, material] of captured.entries()) {
        const key = "S" + (index + 1);
        call.throwIfAborted("prepare");
        const prepared = await prepareSource(
          material,
          key,
          requirements,
          model,
          callOptions,
          preview,
          maxBytes - budget.bytes,
        );
        entries.push(prepared.entry);
        parts.push(
          { kind: "text", text: "[" + key + "]\n" },
          ...prepared.parts,
        );
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
          total: captured.length,
          unit: "materials",
        });
      }
      return { parts, uses, pending, sources: createSourceDirectory(entries) };
    } finally {
      call.close();
    }
  }
  return preparation;
}
