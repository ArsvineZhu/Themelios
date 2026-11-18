import { agentArtifactRefPattern, artifactRefSchema } from "@themelios/core";
import type { AgentRefBridge } from "@themelios/runtime/operations";
import { z } from "zod";

type Shape = {
  $ref?: string;
  $defs?: Record<string, Shape>;
  properties?: Record<string, Shape>;
  additionalProperties?: Shape | boolean;
  items?: Shape;
  anyOf?: Shape[];
  oneOf?: Shape[];
  allOf?: Shape[];
  pattern?: string;
  "x-themelios-ref"?: boolean;
};

export function agentSchema(
  schema: z.ZodType,
  direction: "input" | "output",
  bridge?: AgentRefBridge,
) {
  const options = { io: direction, cycles: "ref" } as const;
  if (!bridge)
    return { advertised: schema, convert: (value: unknown) => value };
  const canonical = z.toJSONSchema(schema, options) as Shape;
  const advertised = z.toJSONSchema(schema, {
    ...options,
    override({ jsonSchema }) {
      if (!jsonSchema["x-themelios-ref"]) return;
      const pattern = jsonSchema.pattern as string;
      jsonSchema.pattern = `${pattern}|${agentArtifactRefPattern.source}`;
    },
  });

  function field(value: string): string {
    if (direction === "input" && agentArtifactRefPattern.test(value)) {
      return bridge!.resolveRef(value);
    }
    if (direction === "output" && artifactRefSchema.safeParse(value).success) {
      return bridge!.formatRef(value);
    }
    return value;
  }

  function walkObject(shape: Shape, value: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const child = Object.hasOwn(shape.properties ?? {}, key)
          ? shape.properties![key]
          : shape.additionalProperties;
        return [
          key,
          child && typeof child === "object" ? walk(child, item) : item,
        ];
      }),
    );
  }

  function walk(shape: Shape, value: unknown): unknown {
    if (shape.$ref) {
      const ref = shape.$ref;
      const target = ref === "#" ? canonical : canonical.$defs?.[ref.slice(8)];
      return target ? walk(target, value) : value;
    }
    const alternatives = shape.anyOf ?? shape.oneOf ?? shape.allOf;
    if (alternatives)
      value = alternatives.reduce<unknown>(
        (current, branch) => walk(branch, current),
        value,
      );
    if (typeof value === "string")
      return shape["x-themelios-ref"] ? field(value) : value;
    if (Array.isArray(value))
      return shape.items
        ? value.map((item) => walk(shape.items!, item))
        : value;
    if (value !== null && typeof value === "object")
      return walkObject(shape, value as Record<string, unknown>);
    return value;
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
    convert: (value: unknown) => walk(canonical, value),
  };
}
