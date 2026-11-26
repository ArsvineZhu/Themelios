import {
  agentArtifactRefPattern,
  artifactRefSchema,
  jsonSchema,
} from "@themelios/core";
import type { AgentRefBridge } from "@themelios/runtime/operations";
import type {
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { z } from "zod";
import { transportError } from "../errors.js";

type SchemaDef = z.core.$ZodTypes["_zod"]["def"];
type TaggedOption = z.core.$ZodType<Record<string, unknown>>;
export type SchemaDirection = "input" | "output";

const outputValidator = new AjvJsonSchemaValidator();
const outputBranches = new WeakMap<
  z.core.$ZodType,
  JsonSchemaValidator<unknown>
>();

/** Chooses the outward shape of a validated result without invoking any codec. */
function matchesOutputShape(schema: z.core.$ZodType, value: unknown): boolean {
  let validate = outputBranches.get(schema);
  if (!validate) {
    const projection = z.toJSONSchema(schema, {
      io: "output",
      cycles: "ref",
      unrepresentable: "any",
    });
    // Zod and the SDK share the dialect but declare $vocabulary differently.
    validate = outputValidator.getValidator(
      projection as unknown as JsonSchemaType,
    );
    outputBranches.set(schema, validate);
  }
  return validate(value).valid;
}

function wrappedSchema(def: SchemaDef, direction: SchemaDirection) {
  if (def.type === "lazy") return def.getter();
  if (def.type === "pipe") return direction === "input" ? def.in : def.out;
  if ("innerType" in def && def.type !== "success" && def.type !== "promise")
    return def.innerType;
}

export function agentSchema(
  schema: z.ZodType,
  direction: SchemaDirection,
  bridge?: AgentRefBridge,
) {
  const options = { io: direction, cycles: "ref" } as const;
  const advertised = z.toJSONSchema(schema, {
    ...options,
    unrepresentable: "any",
    override({ jsonSchema }) {
      if (
        bridge &&
        jsonSchema["x-themelios-ref"] &&
        typeof jsonSchema.pattern === "string"
      ) {
        jsonSchema.pattern = `${jsonSchema.pattern}|${agentArtifactRefPattern.source}`;
      }
    },
  });

  const convertRef: (value: string) => string = !bridge
    ? (value) => value
    : direction === "input"
      ? (value) =>
          agentArtifactRefPattern.test(value) ? bridge.resolveRef(value) : value
      : (value) =>
          artifactRefSchema.safeParse(value).success
            ? bridge.formatRef(value)
            : value;

  function walkObject(
    shape: z.core.$ZodShape,
    rest: z.core.$ZodType | undefined,
    value: unknown,
  ) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const child = Object.hasOwn(shape, key) ? shape[key] : rest;
        return [key, child ? walk(child, item) : item];
      }),
    );
  }

  function walkSequence(
    def: z.core.$ZodArrayDef | z.core.$ZodTupleDef,
    value: unknown,
  ) {
    if (!Array.isArray(value)) return value;
    return value.map((item, index) => {
      const child =
        def.type === "array" ? def.element : (def.items[index] ?? def.rest);
      return child ? walk(child, item) : item;
    });
  }

  function walkInputUnion(def: z.core.$ZodUnionDef, value: unknown): unknown {
    let matched: { value: unknown } | undefined;
    let rejected: { error: unknown } | undefined;
    for (const branch of def.options) {
      let candidate: unknown;
      try {
        candidate = walk(branch, value);
      } catch (error) {
        rejected ??= { error };
        continue;
      }
      if (!z.core.safeParse(branch, candidate).success) continue;
      if (def.inclusive !== false) return candidate;
      if (matched)
        throw transportError("transport.invalid_request", {
          reason: "ambiguous_union",
        });
      matched = { value: candidate };
    }
    if (matched) return matched.value;
    if (rejected) throw rejected.error;
    return value;
  }

  function walkUnion(node: z.core.$ZodUnion, value: unknown): unknown {
    // Tagged unions choose their schema before any artifact lookup or validation.
    if (node instanceof z.ZodDiscriminatedUnion) {
      if (value === null || typeof value !== "object") return value;
      const tag = (value as Record<string, unknown>)[node.def.discriminator];
      const union = node as z.core.$ZodDiscriminatedUnion<
        readonly TaggedOption[]
      >;
      const branch = z.core.getDiscriminatedOption(union, tag);
      if (branch) return walk(branch, value);
      if (!node.def.unionFallback) return value;
    }
    const def = node._zod.def;
    if (direction === "input") return walkInputUnion(def, value);
    const branch = def.options.find((candidate) =>
      matchesOutputShape(candidate, value),
    );
    return branch ? walk(branch, value) : value;
  }

  function walk(node: z.core.$ZodType, value: unknown): unknown {
    if (value == null || node === jsonSchema) return value;
    if (
      typeof value === "string" &&
      z.globalRegistry.get(node)?.["x-themelios-ref"]
    ) {
      return convertRef(value);
    }
    const definition = node as z.core.$ZodTypes;
    const def = definition._zod.def;
    switch (def.type) {
      case "union":
        return walkUnion(definition as z.core.$ZodUnion, value);
      case "intersection":
        return walk(def.right, walk(def.left, value));
      case "object":
        return walkObject(def.shape, def.catchall, value);
      case "record":
        return walkObject({}, def.valueType, value);
      case "array":
      case "tuple":
        return walkSequence(def, value);
      default: {
        const child = wrappedSchema(def, direction);
        return child ? walk(child, value) : value;
      }
    }
  }

  return {
    // The operation validates canonical values after decoding. Output has already
    // been validated before encoding declared references for the Agent.
    advertised: {
      "~standard": {
        version: 1 as const,
        vendor: "themelios",
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => advertised,
          output: () => advertised,
        },
      },
    },
    convert: (value: unknown) => (bridge ? walk(schema, value) : value),
  };
}
