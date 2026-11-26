import {
  artifactInfoSchema,
  materialOperationIds,
  resultOperationIds,
  retainedListOptionsSchema,
  sourceTraceOptionsSchema,
  sourceLinkSchema,
  textBlockSchema,
  type Materials,
  type Results,
} from "@themelios/content";
import {
  artifactRefSchema,
  selectionSchema,
  savedResultSchema,
  mediaTypeSchema,
} from "@themelios/core";
import { z } from "zod";
import {
  defineOperation,
  standardPermission,
  type AnyOperation,
} from "@themelios/runtime/operations";
import {
  decodeCompleted,
  decodeWireAccept,
  wireAcceptSchema,
  wireCompletedSchema,
} from "./wire.js";

export interface ContentOperationTarget {
  readonly materials: Materials;
  readonly results: Results;
}

const requiredRef = z.strictObject({ ref: artifactRefSchema });

export function contentOperations<
  App extends ContentOperationTarget,
>(): readonly AnyOperation<App>[] {
  return [
    defineOperation<App>()({
      id: materialOperationIds.accept,
      description: "Import bytes as immutable material.",
      permission: standardPermission.write,
      kind: "unary",
      input: wireAcceptSchema.transform(decodeWireAccept),
      binaryInput: z
        .strictObject({
          body: z.instanceof(ReadableStream<Uint8Array>),
          mediaType: mediaTypeSchema.optional(),
          name: z.string().min(1).optional(),
        })
        .transform(({ body, mediaType, name }) => ({
          body,
          ...(mediaType === undefined ? {} : { mediaType }),
          ...(name === undefined ? {} : { name }),
        })),
      output: selectionSchema,
      http: [
        {
          method: "POST",
          path: "/materials",
          status: 201,
          binaryBody: true,
          queryStrings: ["name"],
        },
        { method: "POST", path: "/materials/accept", status: 201 },
      ],
      execute: (app, input, context) =>
        app.materials.accept(input, context.options),
    }),
    defineOperation<App>()({
      id: materialOperationIds.inspect,
      description: "Inspect material metadata.",
      permission: standardPermission.read,
      input: requiredRef,
      output: artifactInfoSchema,
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: [
        {
          method: "GET",
          path: "/materials/:ref",
          paramMap: { ref: "ref" },
        },
      ],
      execute(app, { ref }) {
        return app.materials.inspect(app.materials.resolve(ref));
      },
    }),
    defineOperation<App>()({
      id: materialOperationIds.read,
      description: "Read original bytes and metadata.",
      permission: standardPermission.read,
      kind: "binary-read",
      input: requiredRef,
      mcp: { expose: false },
      http: [
        {
          method: "GET",
          path: "/materials/:ref/content",
          paramMap: { ref: "ref" },
        },
      ],
      execute(app, { ref }, context) {
        return app.materials.read(app.materials.resolve(ref), context.options);
      },
    }),
    defineOperation<App>()({
      id: materialOperationIds.text,
      description: "Read a text or JSON selection.",
      permission: standardPermission.read,
      input: selectionSchema,
      output: z.strictObject({ text: z.string() }),
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: [{ method: "POST", path: "/materials/text" }],
      async execute(app, selection, context) {
        const ref = app.materials.resolve(selection.ref);
        const resolved = { ...selection, ref };
        return { text: await app.materials.text(resolved, context.options) };
      },
    }),
    defineOperation<App>()({
      id: materialOperationIds.structure,
      description: "Read text blocks with source coordinates.",
      permission: standardPermission.read,
      input: requiredRef,
      output: z.array(textBlockSchema),
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: [
        {
          method: "GET",
          path: "/materials/:ref/structure",
          paramMap: { ref: "ref" },
        },
      ],
      execute(app, { ref }, context) {
        return app.materials.structure(
          app.materials.resolve(ref),
          context.options,
        );
      },
    }),
    defineOperation<App>()({
      id: materialOperationIds.sources,
      description: "Trace links from material or result to its sources.",
      permission: standardPermission.read,
      input: sourceTraceOptionsSchema.extend({ ref: artifactRefSchema }),
      output: z.array(sourceLinkSchema),
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: [
        {
          method: "GET",
          path: "/materials/:ref/sources",
          paramMap: { ref: "ref" },
          queryNumbers: ["depth"],
        },
      ],
      execute(app, { ref, depth }) {
        return app.materials.sources(
          app.materials.resolve(ref),
          depth === undefined ? {} : { depth },
        );
      },
    }),
    defineOperation<App>()({
      id: materialOperationIds.listRetained,
      description:
        "List explicitly retained materials and results at a commit cut.",
      permission: standardPermission.read,
      input: retainedListOptionsSchema,
      output: z.array(artifactInfoSchema),
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: [
        {
          method: "GET",
          path: "/materials",
          queryStrings: ["at", "after"],
          queryNumbers: ["limit"],
        },
      ],
      execute(app, { at, after, limit }) {
        return app.materials.listRetained({
          ...(at === undefined ? {} : { at }),
          ...(after === undefined
            ? {}
            : { after: app.materials.resolve(after) }),
          ...(limit === undefined ? {} : { limit }),
        });
      },
    }),
    defineOperation<App>()({
      id: materialOperationIds.retain,
      description: "Retain a material as a root.",
      permission: standardPermission.write,
      input: requiredRef,
      output: z.null(),
      mcp: { expose: false, idempotentHint: true },
      http: [
        {
          method: "POST",
          path: "/materials/:ref/retain",
          paramMap: { ref: "ref" },
          status: 204,
        },
      ],
      execute(app, { ref }) {
        app.materials.retain(app.materials.resolve(ref));
        return null;
      },
    }),
    defineOperation<App>()({
      id: materialOperationIds.release,
      description: "Release a retained material root.",
      permission: standardPermission.write,
      input: requiredRef,
      output: z.null(),
      mcp: { expose: false, destructiveHint: true, idempotentHint: true },
      http: [
        {
          method: "POST",
          path: "/materials/:ref/release",
          paramMap: { ref: "ref" },
          status: 204,
        },
      ],
      execute(app, { ref }) {
        app.materials.release(app.materials.resolve(ref));
        return null;
      },
    }),
    defineOperation<App>()({
      id: resultOperationIds.save,
      description: "Save a completed value and its source graph.",
      permission: standardPermission.write,
      input: wireCompletedSchema,
      output: savedResultSchema,
      mcp: { expose: false },
      http: [{ method: "POST", path: "/results", status: 201 }],
      execute(app, wire, context) {
        return app.results.save(decodeCompleted(wire), context.options);
      },
    }),
    defineOperation<App>()({
      id: resultOperationIds.read,
      description: "Read a saved result and its precise source references.",
      permission: standardPermission.read,
      input: requiredRef,
      output: savedResultSchema,
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: [
        { method: "GET", path: "/results/:ref", paramMap: { ref: "ref" } },
      ],
      execute(app, { ref }, context) {
        return app.results.read(app.materials.resolve(ref), context.options);
      },
    }),
  ];
}
