import {
  fromJson,
  toJson,
  type DescMessage,
  type JsonValue,
  type Message,
  type MessageShape,
} from "@bufbuild/protobuf";
import { transportError } from "../errors.js";

type ObjectValue = { [key: string]: JsonValue };
export type Encoding = (value: unknown) => JsonValue;

function record(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function array(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}
function valueOf(value: unknown): JsonValue {
  return value as JsonValue;
}
function optional<T>(
  key: string,
  value: T | undefined,
): Record<string, Exclude<T, undefined>> {
  return (value === undefined ? {} : { [key]: value }) as Record<
    string,
    Exclude<T, undefined>
  >;
}
function enumName(
  value: JsonValue | undefined,
  prefix: string,
): string | undefined {
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    value.endsWith("_UNSPECIFIED")
  )
    return undefined;
  return value.slice(prefix.length).toLowerCase();
}
function enumValue(
  value: JsonValue | undefined,
  prefix: string,
): string | undefined {
  return typeof value === "string" ? prefix + value.toUpperCase() : undefined;
}
function safeInteger(
  value: JsonValue | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw transportError("input.invalid", {
      issues: [{ path: name, reason: "unsafe_integer" }],
    });
  }
  return number;
}
function discriminated(value: JsonValue): ObjectValue {
  const { kind, ...fields } = record(value);
  return typeof kind === "string" ? { [kind]: fields } : {};
}

export function decodeProto(
  schema: DescMessage,
  message: Message,
): ObjectValue {
  // Proto JSON already implements the special protobuf.Value and bytes representations.
  return record(toJson(schema, message));
}
export function encodeProto<T extends DescMessage>(
  schema: T,
  value: JsonValue,
): MessageShape<T> {
  return fromJson(schema, value);
}
export const objectValue: Encoding = record;
export const list =
  (key: string, map: Encoding = valueOf): Encoding =>
  (input) => ({ [key]: array(input).map(map) });

export function decodeSelection(json: unknown): ObjectValue {
  const { ref, range } = record(json);
  if (range === undefined) return optional("ref", ref);
  const object = record(range);
  for (const kind of ["text", "pages", "time", "image", "json"]) {
    if (!Object.hasOwn(object, kind)) continue;
    const fields = record(object[kind]);
    if (kind === "text") {
      return {
        ...optional("ref", ref),
        range: {
          kind,
          start: safeInteger(fields.start, "range.start") ?? 0,
          end: safeInteger(fields.end, "range.end") ?? 0,
        },
      };
    }
    if (kind === "pages")
      return {
        ...optional("ref", ref),
        range: { kind, start: 0, end: 0, ...fields },
      };
    if (kind === "time")
      return {
        ...optional("ref", ref),
        range: { kind, startMs: 0, endMs: 0, ...fields },
      };
    if (kind === "image")
      return {
        ...optional("ref", ref),
        range: { kind, x: 0, y: 0, width: 0, height: 0, ...fields },
      };
    return { ...optional("ref", ref), range: { kind, pointer: "", ...fields } };
  }
  return { ...optional("ref", ref), range: {} };
}

export function encodeSelection(json: unknown): ObjectValue {
  const { range, ...selection } = record(json);
  return {
    ...selection,
    ...(range === undefined ? {} : { range: discriminated(range) }),
  };
}

function decodeInline(value: unknown): ObjectValue {
  const { bytes, ...material } = record(value);
  return { ...material, bytesBase64: bytes ?? "" };
}

export function decodeOrigin(value: unknown): ObjectValue {
  const { kind, ...fields } = record(value);
  return { ...fields, ...optional("kind", enumName(kind, "ORIGIN_KIND_")) };
}

export function decodeAccept(value: unknown): ObjectValue {
  const { material, origin } = record(value);
  return {
    ...(material === undefined ? {} : decodeInline(material)),
    ...(origin === undefined ? {} : { origin: decodeOrigin(origin) }),
  };
}

function decodeMaterial(json: unknown): ObjectValue {
  const { selection, inline, resultOutput } = record(json);
  if (selection !== undefined) return decodeSelection(selection);
  if (inline !== undefined) return decodeInline(inline);
  if (resultOutput === undefined) return {};
  const { completed, saved, output } = record(resultOutput);
  return {
    ...(completed === undefined
      ? optional("result", saved)
      : { result: decodeCompleted(completed) }),
    ...optional("output", output),
  };
}

function encodeInline(value: unknown): ObjectValue {
  const { bytesBase64, ...fields } = record(value);
  return { ...fields, ...optional("bytes", bytesBase64) };
}

function encodeMaterial(value: unknown): ObjectValue {
  const obj = record(value);
  if ("result" in obj) {
    const result = record(obj.result);
    return {
      resultOutput: {
        ...optional("output", obj.output),
        ...("ref" in result
          ? { saved: result }
          : { completed: encodeCompleted(result) }),
      },
    };
  }
  return "bytesBase64" in obj
    ? { inline: encodeInline(obj) }
    : { selection: encodeSelection(obj) };
}

function decodeCopyMap(json: unknown): ObjectValue {
  const { range, source, ...fields } = record(json);
  const part = record(range);
  return {
    ...fields,
    ...(range === undefined
      ? {}
      : {
          range: {
            start: safeInteger(part.start, "mappings.range.start") ?? 0,
            end: safeInteger(part.end, "mappings.range.end") ?? 0,
          },
        }),
    ...(source === undefined ? {} : { source: decodeSelection(source) }),
  };
}

function encodeCopyMap(value: unknown): ObjectValue {
  const { source, ...fields } = record(value);
  return { ...fields, source: encodeSelection(source) };
}

export function decodeCompleted(value: unknown): ObjectValue {
  const { inputs, files, producer, mappings, ...fields } = record(value);
  const { kind, ...producerData } = record(producer);
  return {
    ...fields,
    inputs: array(inputs).map((item) => {
      const { source, delivered, role } = record(item);
      return {
        ...optional("role", enumName(role, "INPUT_ROLE_")),
        ...(source === undefined ? {} : { source: decodeMaterial(source) }),
        delivered: array(delivered).map(decodeMaterial),
      };
    }),
    files: array(files).map((item) => {
      const { selection, inline, sourceIndices, ...file } = record(item);
      return {
        ...file,
        sourceIndices: array(sourceIndices),
        ...(inline !== undefined
          ? { material: decodeInline(inline) }
          : selection !== undefined
            ? { material: decodeSelection(selection) }
            : {}),
      };
    }),
    ...(producer === undefined
      ? {}
      : {
          producer: {
            ...producerData,
            ...optional("kind", enumName(kind, "PRODUCER_KIND_")),
          },
        }),
    ...(array(mappings).length
      ? { mappings: array(mappings).map(decodeCopyMap) }
      : {}),
  };
}

function encodeProducer(value: unknown) {
  const { kind, ...fields } = record(value);
  return { ...fields, ...optional("kind", enumValue(kind, "PRODUCER_KIND_")) };
}

function encodeInputs(value: unknown, convert: Encoding): JsonValue[] {
  return array(value).map((item) => {
    const { source, delivered, role } = record(item);
    return {
      ...optional("role", enumValue(role, "INPUT_ROLE_")),
      source: convert(source),
      delivered: array(delivered).map(convert),
    };
  });
}

function encodeCompleted(value: unknown): ObjectValue {
  const { inputs, files, producer, mappings, ...fields } = record(value);
  return {
    ...fields,
    producer: encodeProducer(producer),
    inputs: encodeInputs(inputs, encodeMaterial),
    files: array(files).map((item) => {
      const { material, ...file } = record(item);
      return { ...file, ...encodeMaterial(material) };
    }),
    mappings: array(mappings).map(encodeCopyMap),
  };
}

export function encodeSaved(value: unknown): ObjectValue {
  const { inputs, files, producer, mappings, ...fields } = record(value);
  return {
    ...fields,
    producer: encodeProducer(producer),
    inputs: encodeInputs(inputs, encodeSelection),
    files: Object.fromEntries(
      Object.entries(record(files)).map(([key, item]) => {
        const { material, ...fields } = record(item);
        return [key, { ...fields, material: encodeSelection(material) }];
      }),
    ),
    mappings: array(mappings).map(encodeCopyMap),
  };
}

export function decodeTask(value: unknown): ObjectValue {
  const { materials, parameters, ...fields } = record(value);
  const { seed, ...values } = record(parameters);
  return {
    ...fields,
    materials: array(materials).map((item) => {
      const { source, role } = record(item);
      return {
        ...(source === undefined ? {} : { source: decodeMaterial(source) }),
        ...(role === undefined
          ? {}
          : { role: enumName(role, "INPUT_ROLE_") ?? "" }),
      };
    }),
    ...(parameters === undefined
      ? {}
      : {
          parameters: {
            ...values,
            ...optional("seed", safeInteger(seed, "parameters.seed")),
          },
        }),
  };
}

export const decodeMany = (input: unknown): ObjectValue => ({
  inputs: array(record(input).inputs).map(decodeTask),
});

export const encodeTaskResult: Encoding = (value) =>
  "ref" in record(value)
    ? { saved: encodeSaved(value) }
    : { completed: encodeCompleted(value) };

export const encodeBatch: Encoding = (value) => ({
  items: array(value).map((item) => {
    const { ok, result, error } = record(item);
    return ok ? { result: encodeTaskResult(result) } : optional("error", error);
  }),
});

export function encodeArtifact(value: unknown): ObjectValue {
  const { kind, origin, extent, ...fields } = record(value);
  const { kind: originKind, ...originData } = record(origin);
  return {
    ...fields,
    ...optional("kind", enumValue(kind, "ARTIFACT_KIND_")),
    ...(extent === undefined ? {} : { extent: discriminated(extent) }),
    ...(origin === undefined
      ? {}
      : {
          origin: {
            ...originData,
            ...optional("kind", enumValue(originKind, "ORIGIN_KIND_")),
          },
        }),
  };
}

export const encodeStructure = list("blocks", (item) => {
  const { selection, ...fields } = record(item);
  return { ...fields, selection: encodeSelection(selection) };
});
export const encodeSources = list("sources", (item) => {
  const { selection, ...fields } = record(item);
  return { ...fields, selection: encodeSelection(selection) };
});

function encodeSource(value: unknown) {
  const { role, ...fields } = record(value);
  return { ...fields, ...optional("role", enumValue(role, "INPUT_ROLE_")) };
}

export const encodePreview: Encoding = (value) => {
  const { messages, sources, ...fields } = record(value);
  return {
    ...fields,
    messages: array(messages).map((item) => {
      const { parts, role } = record(item);
      return {
        ...optional("role", role),
        parts: array(parts).map((part) => {
          const { kind, text, ...media } = record(part);
          return kind === "text" ? optional("text", text) : { media };
        }),
      };
    }),
    sources: { entries: array(record(sources).entries).map(encodeSource) },
  };
};

export const encodeDescription: Encoding = (value) => {
  const { examples, output, ...fields } = record(value);
  const choice = record(output);
  return {
    ...fields,
    ...(choice.kind === "text"
      ? { textOutput: {} }
      : optional("jsonOutputSchema", choice.schema)),
    examples: array(examples).map((item) => {
      const { sources, ...fields } = record(item);
      return {
        ...fields,
        sources: array(sources).map((value) => {
          const { text, ...source } = record(value);
          return { source: encodeSource(source), ...optional("text", text) };
        }),
      };
    }),
  };
};
