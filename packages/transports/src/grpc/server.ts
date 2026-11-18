import { once } from "node:events";
import {
  createSecureServer,
  createServer,
  type ServerHttp2Session,
} from "node:http2";
import {
  callOperation,
  createOperations,
  type ApplicationApi,
  type OperationContext,
} from "@themelios/application";
import type { MaterialRead } from "@themelios/content";
import type { Flow } from "@themelios/core";
import type { DescMessage, Message } from "@bufbuild/protobuf";
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  errorLocale,
  grpcCode,
  localizedError,
  transportError,
} from "../errors.js";
import { checkJsonSize } from "../json.js";
import {
  authenticateRequest,
  callOptions,
  loopbackHosts,
  RequestTracker,
  validateWebOrigin,
} from "../request.js";
import type { GrpcServerOptions, Translate } from "../types.js";
import {
  decodeAccept,
  decodeCompleted,
  decodeMany,
  decodeProto,
  decodeSelection,
  decodeTask,
  encodeArtifact,
  encodeBatch,
  encodeDescription,
  encodePreview,
  encodeProto,
  encodeSaved,
  encodeSelection,
  encodeSources,
  encodeStructure,
  encodeTaskResult,
  list,
  objectValue,
  type Encoding,
} from "./codec.js";
import {
  ApplicationService,
  FailureSchema,
  type UploadMaterialRequest,
} from "./generated/themelios/v1/application_pb.js";
import { downloadMaterial, streamTask, withUpload } from "./stream.js";

type CallContext = OperationContext & { maxJsonBytes: number };

export async function startGrpcServer<S>(
  api: ApplicationApi<S>,
  options: GrpcServerOptions,
): Promise<{
  address: string;
  close(): Promise<void>;
}> {
  const directory = createOperations(api);
  const allowed = options.operations && new Set(options.operations);
  const tracker = new RequestTracker();
  const hostname = options.hostname === "[::1]" ? "::1" : options.hostname;
  if (
    !loopbackHosts.includes(
      options.hostname as (typeof loopbackHosts)[number],
    ) &&
    hostname !== "::1" &&
    !options.authenticate &&
    Object.keys(options.policy().authTokens).length === 0
  ) {
    throw transportError("config.invalid", {
      issues: [
        {
          path: "/transports/grpc/listen",
          messageKey: "transport.auth_required",
        },
      ],
    });
  }

  async function context(
    rpc: HandlerContext,
    signal: AbortSignal,
    id: string,
    locale: string,
  ): Promise<CallContext> {
    if (allowed && !allowed.has(id))
      throw transportError("transport.not_found");
    const policy = options.policy();
    validateWebOrigin(
      new Request(rpc.url, { headers: rpc.requestHeader }),
      policy,
    );
    const principal = await authenticateRequest(
      rpc.requestHeader,
      options,
      policy,
      signal,
    );
    const call = callOptions(rpc.requestHeader, signal);
    const grpc = rpc.timeoutMs();
    if (grpc !== undefined)
      call.timeoutMs = Math.max(0, Math.min(grpc, call.timeoutMs ?? Infinity));
    return {
      principal,
      locale,
      options: call,
      maxJsonBytes: policy.maxJsonBytes,
    };
  }

  function getLocale(rpc: HandlerContext) {
    const settings = api.configuration.snapshot() as { locale?: string } | null;
    return errorLocale(
      rpc.requestHeader.get("accept-language"),
      settings?.locale,
    );
  }

  function unary<O extends DescMessage>(
    id: string,
    output: O,
    encode: Encoding = objectValue,
    decode: Encoding = objectValue,
  ) {
    return async (request: Message, rpc: HandlerContext) => {
      const locale = getLocale(rpc);
      let lease: ReturnType<RequestTracker["take"]> | undefined;
      try {
        lease = tracker.take(rpc.signal);
        const ctx = await context(rpc, lease.signal, id, locale);
        const input = decode(decodeProto(rpc.method.input, request));
        checkJsonSize(input, ctx.maxJsonBytes, "request");
        const result = await callOperation(directory, id, input, ctx);
        checkJsonSize(result, ctx.maxJsonBytes, "result");
        return encodeProto(output, encode(result));
      } catch (error) {
        throw grpcError(error, locale, rpc, options.translate);
      } finally {
        lease?.close();
      }
    };
  }

  async function upload(
    request: AsyncIterable<UploadMaterialRequest>,
    rpc: HandlerContext,
  ) {
    const locale = getLocale(rpc);
    let lease: ReturnType<RequestTracker["take"]> | undefined;
    try {
      lease = tracker.take(rpc.signal);
      const ctx = await context(rpc, lease.signal, "materials.accept", locale);
      return await withUpload(request, lease.signal, async (input) => {
        const value = await callOperation(
          directory,
          "materials.accept",
          input,
          ctx,
        );
        return encodeProto(
          ApplicationService.method.uploadMaterial.output,
          encodeSelection(value),
        );
      });
    } catch (error) {
      throw grpcError(error, locale, rpc, options.translate);
    } finally {
      lease?.close();
    }
  }

  async function* read(request: Message, rpc: HandlerContext) {
    const locale = getLocale(rpc);
    let lease: ReturnType<RequestTracker["take"]> | undefined;
    try {
      lease = tracker.take(rpc.signal);
      const ctx = await context(rpc, lease.signal, "materials.read", locale);
      const input = decodeProto(rpc.method.input, request);
      checkJsonSize(input, ctx.maxJsonBytes, "request");
      const result = (await callOperation(
        directory,
        "materials.read",
        input,
        ctx,
      )) as MaterialRead;
      yield* downloadMaterial(result, ctx.maxJsonBytes, lease.signal);
    } catch (error) {
      throw grpcError(error, locale, rpc, options.translate);
    } finally {
      lease?.close();
    }
  }

  async function* stream(request: Message, rpc: HandlerContext) {
    const locale = getLocale(rpc);
    let lease: ReturnType<RequestTracker["take"]> | undefined;
    try {
      lease = tracker.take(rpc.signal);
      const ctx = await context(rpc, lease.signal, "tasks.stream", locale);
      const input = decodeTask(decodeProto(rpc.method.input, request));
      checkJsonSize(input, ctx.maxJsonBytes, "request");
      const result = callOperation(
        directory,
        "tasks.stream",
        input,
        ctx,
      ) as Flow<unknown>;
      yield* streamTask(result, ctx.maxJsonBytes);
    } catch (error) {
      throw grpcError(error, locale, rpc, options.translate);
    } finally {
      lease?.close();
    }
  }

  const method = ApplicationService.method;
  const impl: ServiceImpl<typeof ApplicationService> = {
    getInstanceInfo: unary("instance.info", method.getInstanceInfo.output),
    acceptMaterial: unary(
      "materials.accept",
      method.acceptMaterial.output,
      encodeSelection,
      decodeAccept,
    ),
    uploadMaterial: upload,
    inspectMaterial: unary(
      "materials.inspect",
      method.inspectMaterial.output,
      encodeArtifact,
    ),
    readMaterial: read,
    readMaterialText: unary(
      "materials.text",
      method.readMaterialText.output,
      objectValue,
      decodeSelection,
    ),
    getMaterialStructure: unary(
      "materials.structure",
      method.getMaterialStructure.output,
      encodeStructure,
    ),
    getMaterialSources: unary(
      "materials.sources",
      method.getMaterialSources.output,
      encodeSources,
    ),
    listMaterials: unary(
      "materials.list",
      method.listMaterials.output,
      list("items", encodeArtifact),
    ),
    retainMaterial: unary(
      "materials.retain",
      method.retainMaterial.output,
      () => ({}),
    ),
    releaseMaterial: unary(
      "materials.release",
      method.releaseMaterial.output,
      () => ({}),
    ),
    saveResult: unary(
      "results.save",
      method.saveResult.output,
      encodeSaved,
      decodeCompleted,
    ),
    readResult: unary("results.read", method.readResult.output, encodeSaved),
    listTasks: unary("tasks.list", method.listTasks.output, list("tasks")),
    describeTask: unary(
      "tasks.describe",
      method.describeTask.output,
      encodeDescription,
    ),
    previewTask: unary(
      "tasks.preview",
      method.previewTask.output,
      encodePreview,
      decodeTask,
    ),
    runTask: unary(
      "tasks.run",
      method.runTask.output,
      encodeTaskResult,
      decodeTask,
    ),
    streamTask: stream,
    runManyTasks: unary(
      "tasks.runMany",
      method.runManyTasks.output,
      encodeBatch,
      decodeMany,
    ),
    readPrompt: unary("prompts.read", method.readPrompt.output),
    describePrompt: unary("prompts.describe", method.describePrompt.output),
    diffPrompt: unary("prompts.diff", method.diffPrompt.output, list("files")),
    setPromptOverride: unary(
      "prompts.setOverride",
      method.setPromptOverride.output,
    ),
    resetPrompt: unary("prompts.reset", method.resetPrompt.output),
    describeConfiguration: unary(
      "configuration.describe",
      method.describeConfiguration.output,
      list("fields"),
    ),
    explainSetting: unary(
      "configuration.explain",
      method.explainSetting.output,
    ),
    setSetting: unary("configuration.set", method.setSetting.output),
    unsetSetting: unary("configuration.unset", method.unsetSetting.output),
    reloadConfiguration: unary(
      "configuration.reload",
      method.reloadConfiguration.output,
    ),
  };
  const adapter = connectNodeAdapter({
    grpc: true,
    grpcWeb: false,
    connect: false,
    readMaxBytes: 1024 * 1024 * 1024,
    routes(router) {
      for (const name of Object.keys(method) as (keyof typeof method)[]) {
        router.rpc(
          method[name],
          impl[name] as never,
          name === "uploadMaterial"
            ? { readMaxBytes: 1024 * 1024 + 64 }
            : undefined,
        );
      }
    },
  });
  const credentials =
    options.tls &&
    (await Promise.all([
      options.secrets.resolve(options.tls.key),
      options.secrets.resolve(options.tls.cert),
    ]));
  const server = credentials
    ? createSecureServer({ key: credentials[0], cert: credentials[1] }, adapter)
    : createServer({}, adapter);
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
    session.on("error", () => session.destroy());
  });
  server.listen(options.port, hostname);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw transportError("internal.unexpected");
  const host = hostname.includes(":") ? "[" + hostname + "]" : hostname;
  const url =
    (options.tls ? "https://" : "http://") + host + ":" + address.port;
  let closing: Promise<void> | undefined;
  return {
    address: url,
    close() {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await tracker.close();
        for (const session of sessions) session.destroy();
        await stopped;
      })();
      return closing;
    },
  };
}

function grpcError(
  error: unknown,
  locale: string,
  rpc: HandlerContext,
  translate?: Translate,
): ConnectError {
  const cause =
    rpc.signal.aborted && rpc.signal.reason instanceof ConnectError
      ? rpc.signal.reason
      : error;
  const mapped =
    cause instanceof ConnectError && cause.code === Code.DeadlineExceeded
      ? transportError(
          "call.timeout",
          { operation: rpc.method.name, stage: "grpc" },
          cause,
        )
      : cause instanceof ConnectError && cause.code === Code.Canceled
        ? transportError("call.cancelled")
        : cause;
  const info = localizedError(mapped, locale, translate);
  const detail = encodeProto(FailureSchema, JSON.parse(JSON.stringify(info)));
  return new ConnectError(
    info.message,
    grpcCode(info.code),
    undefined,
    [{ desc: FailureSchema, value: detail }],
    error,
  );
}
