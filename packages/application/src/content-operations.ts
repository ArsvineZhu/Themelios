import { extentSchema, type Materials, type Results } from "@themelios/content";
import {
  commitPointSchema,
  instantSchema,
  type ArtifactRef,
  type CallOptions,
} from "@themelios/core";
import { z } from "zod";
import {
  defineOperation,
  type AnyOperation,
} from "@themelios/runtime/operations";
import {
  createWireCodec,
  mediaTypeSchema,
  parseWireInline,
  toOrigin,
  wireAcceptSchema,
  wireArtifactRefSchema,
  wireCompletedSchema,
  wireOriginSchema,
  wireSavedSchema,
  wireSelectionSchema,
} from "./wire.js";

export interface ContentOperationTarget {
  readonly materials: Materials;
  readonly results: Results;
}

const requiredRef = z.strictObject({ ref: wireArtifactRefSchema });

const artifactInfoSchema = z.strictObject({
  ref: wireArtifactRefSchema,
  kind: z.enum(["material", "result"]),
  mediaType: mediaTypeSchema,
  sizeBytes: z.int().nonnegative(),
  name: z.string().min(1).optional(),
  extent: extentSchema,
  origin: wireOriginSchema.optional(),
  createdAt: instantSchema,
  createdAtCut: commitPointSchema,
});

const textBlockSchema = z.strictObject({
  kind: z.enum([
    "heading",
    "paragraph",
    "list",
    "code",
    "table",
    "quote",
    "thematic-break",
  ]),
  selection: wireSelectionSchema,
  depth: z.int().min(1).max(6).optional(),
  text: z.string(),
});

const sourceLinkSchema = z.strictObject({
  relation: z.enum(["input", "file", "representation-source"]),
  selection: wireSelectionSchema,
});

export function contentOperations<
  App extends ContentOperationTarget,
>(): readonly AnyOperation<App>[] {
  return [
    defineOperation<App, unknown, unknown>({
      id: "materials.accept",
      description: "Import bytes as immutable material.",
      permission: "write",
      kind: "unary",
      input: wireAcceptSchema,
      output: wireSelectionSchema,
      http: [
        {
          method: "POST",
          path: "/materials",
          status: 201,
          binaryInput: z.strictObject({
            body: z.instanceof(ReadableStream<Uint8Array>),
            mediaType: mediaTypeSchema,
            name: z.string().min(1).optional(),
          }),
          queryStrings: ["name"],
        },
        { method: "POST", path: "/materials/accept", status: 201 },
      ],
      execute(app, value, context) {
        if (typeof value === "object" && value !== null && "body" in value) {
          const payload = value as {
            body: ReadableStream<Uint8Array>;
            mediaType: string;
            name?: string;
            origin?: z.infer<typeof wireOriginSchema>;
          };
          return app.materials.accept(
            {
              body: payload.body,
              mediaType: payload.mediaType,
              ...(payload.name === undefined ? {} : { name: payload.name }),
              ...(payload.origin === undefined
                ? {}
                : { origin: toOrigin(payload.origin) }),
            },
            context.options,
          );
        }
        return app.materials.accept(parseWireInline(value), context.options);
      },
    }),
    defineOperation<App, { ref: string }, unknown>({
      id: "materials.inspect",
      description: "Inspect material metadata.",
      permission: "read",
      input: requiredRef,
      output: artifactInfoSchema,
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: {
        method: "GET",
        path: "/materials/:ref",
        paramMap: { ref: "ref" },
      },
      execute(app, { ref }) {
        return app.materials.inspect(app.materials.resolve(ref));
      },
    }),
    defineOperation<App, { ref: string }, unknown>({
      id: "materials.read",
      description: "Read original bytes and metadata.",
      permission: "read",
      kind: "binary-read",
      input: requiredRef,
      mcp: { expose: false },
      http: {
        method: "GET",
        path: "/materials/:ref/content",
        paramMap: { ref: "ref" },
      },
      execute(app, { ref }, context) {
        return app.materials.read(app.materials.resolve(ref), context.options);
      },
    }),
    defineOperation<App, z.infer<typeof wireSelectionSchema>, { text: string }>(
      {
        id: "materials.text",
        description: "Read a text or JSON selection.",
        permission: "read",
        input: wireSelectionSchema,
        output: z.strictObject({ text: z.string() }),
        mcp: { readOnlyHint: true, idempotentHint: true },
        http: { method: "POST", path: "/materials/text" },
        async execute(app, selection, context) {
          const ref = app.materials.resolve(selection.ref);
          const resolved =
            selection.range === undefined
              ? { ref }
              : { ref, range: selection.range };
          return { text: await app.materials.text(resolved, context.options) };
        },
      },
    ),
    defineOperation<App, { ref: string }, unknown>({
      id: "materials.structure",
      description: "Read text blocks with source coordinates.",
      permission: "read",
      input: requiredRef,
      output: z.array(textBlockSchema),
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: {
        method: "GET",
        path: "/materials/:ref/structure",
        paramMap: { ref: "ref" },
      },
      execute(app, { ref }, context) {
        return app.materials.structure(
          app.materials.resolve(ref),
          context.options,
        );
      },
    }),
    defineOperation<App, { ref: string; depth?: number | undefined }, unknown>({
      id: "materials.sources",
      description: "Trace links from material or result to its sources.",
      permission: "read",
      input: requiredRef.extend({ depth: z.int().positive().optional() }),
      output: z.array(sourceLinkSchema),
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: {
        method: "GET",
        path: "/materials/:ref/sources",
        paramMap: { ref: "ref" },
        queryNumbers: ["depth"],
      },
      execute(app, { ref, depth }) {
        return app.materials.sources(
          app.materials.resolve(ref),
          depth === undefined ? {} : { depth },
        );
      },
    }),
    defineOperation<
      App,
      {
        at?: string | undefined;
        after?: string | undefined;
        limit?: number | undefined;
      },
      unknown
    >({
      id: "materials.list",
      description: "List material metadata at a commit cut.",
      permission: "read",
      input: z.strictObject({
        at: commitPointSchema.optional(),
        after: wireArtifactRefSchema.optional(),
        limit: z.int().positive().max(1000).optional(),
      }),
      output: z.array(artifactInfoSchema),
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: {
        method: "GET",
        path: "/materials",
        queryStrings: ["at", "after"],
        queryNumbers: ["limit"],
      },
      execute(app, { at, after, limit }) {
        return app.materials.list({
          ...(at === undefined ? {} : { at }),
          ...(after === undefined
            ? {}
            : { after: app.materials.resolve(after) }),
          ...(limit === undefined ? {} : { limit }),
        });
      },
    }),
    defineOperation<App, { ref: string }, null>({
      id: "materials.retain",
      description: "Retain a material as a root.",
      permission: "write",
      input: requiredRef,
      output: z.null(),
      mcp: { expose: false, idempotentHint: true },
      http: {
        method: "POST",
        path: "/materials/:ref/retain",
        paramMap: { ref: "ref" },
        status: 204,
      },
      execute(app, { ref }) {
        app.materials.retain(app.materials.resolve(ref));
        return null;
      },
    }),
    defineOperation<App, { ref: string }, null>({
      id: "materials.release",
      description: "Release a retained material root.",
      permission: "write",
      input: requiredRef,
      output: z.null(),
      mcp: { expose: false, destructiveHint: true, idempotentHint: true },
      http: {
        method: "POST",
        path: "/materials/:ref/release",
        paramMap: { ref: "ref" },
        status: 204,
      },
      execute(app, { ref }) {
        app.materials.release(app.materials.resolve(ref));
        return null;
      },
    }),
    defineOperation<App, z.infer<typeof wireCompletedSchema>, unknown>({
      id: "results.save",
      description: "Save a completed value and its source graph.",
      permission: "write",
      input: wireCompletedSchema,
      output: wireSavedSchema,
      mcp: { expose: false },
      http: { method: "POST", path: "/results", status: 201 },
      async execute(app, wire, context) {
        const codec = createWireCodec(
          {
            resolve: (ref) => app.materials.resolve(ref),
            readResult: (ref: ArtifactRef, opts?: CallOptions) =>
              app.results.read(ref, opts),
          },
          context.options,
        );
        return app.results.save(
          await codec.decodeCompleted(wire),
          context.options,
        );
      },
    }),
    defineOperation<App, { ref: string }, unknown>({
      id: "results.read",
      description: "Read a saved result and its precise source references.",
      permission: "read",
      input: requiredRef,
      output: wireSavedSchema,
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: { method: "GET", path: "/results/:ref", paramMap: { ref: "ref" } },
      execute(app, { ref }, context) {
        return app.results.read(app.materials.resolve(ref), context.options);
      },
    }),
  ];
}
