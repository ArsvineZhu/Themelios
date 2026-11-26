import type { AppError, Json } from "@themelios/core";
import type {
  Diagnostics,
  ModelAttemptDiagnostic,
} from "@themelios/runtime/diagnostics";
import type { Network } from "@themelios/runtime/network";
import type { LanguageModelUsage } from "ai";
import type { ModelIdentity } from "./types.js";

type Tokens = Pick<
  ModelAttemptDiagnostic,
  "inputTokens" | "outputTokens" | "cacheTokens" | "reasoningTokens"
>;
export interface ModelReply {
  tokens?: Tokens;
  response?: Json;
  schema?: Json;
}

type Finish = ModelReply & { error?: AppError; cancelled?: boolean };
type Exchange = {
  started: number;
  status?: number;
  duration?: number;
  settle(result: Finish): void;
  logged: Promise<unknown>;
};

export function logDiagnostic(write: () => void): void {
  try {
    write();
  } catch {
    /* Diagnostics cannot change the provider result. */
  }
}

/** Counts outbound requests and binds the provider attempt lifetime to the model operation. */
export class ModelTelemetry {
  readonly #active: Exchange[] = [];
  #sequence = 0;

  constructor(
    readonly identity: ModelIdentity,
    readonly diagnostics?: Diagnostics,
  ) {}

  get capturesContent() {
    try {
      return Boolean(
        this.diagnostics?.captureModelContent &&
        (this.diagnostics.capturesModelContent?.() ?? true),
      );
    } catch {
      return false;
    }
  }

  observeFetch(fetch: Network["fetch"], credential?: string): Network["fetch"] {
    if (!this.diagnostics) return fetch;
    return async (request) => {
      const event = this.#exchange(request, credential);
      const response = await fetch(request);
      event.status = response.status;
      return response;
    };
  }

  async finish(result: Finish): Promise<void> {
    const batch = this.#active.splice(0);
    const last = batch.at(-1);
    for (const exchange of batch)
      exchange.settle(exchange === last ? result : {});
    if (batch.length)
      await Promise.all(batch.map((exchange) => exchange.logged));
  }

  #exchange(request: Request, credential?: string): Exchange {
    const diagnostics = this.diagnostics!;
    const started = performance.now();
    const previous = this.#active.at(-1);
    if (previous) previous.duration = started - previous.started;
    const attempt = ++this.#sequence;
    const labels = {
      connection: this.identity.connection,
      binding: this.identity.binding,
      attempt,
    };
    const completed = Promise.withResolvers<Finish>();
    const capture = this.capturesContent
      ? requestDetails(request, credential).catch(() => undefined)
      : undefined;
    const exchange: Exchange = {
      started,
      settle: completed.resolve,
      logged: Promise.resolve()
        .then(() =>
          diagnostics.span(
            "model.request",
            async () => {
              const { error, cancelled, tokens, response, schema } =
                await completed.promise;
              const outcome = cancelled
                ? "cancelled"
                : error
                  ? "failure"
                  : "success";
              const durationMs = Math.round(
                exchange.duration ?? performance.now() - started,
              );
              const code = error?.code;
              const providerStatus = exchange.status;
              const status = {
                outcome,
                durationMs,
                ...(code === undefined ? {} : { code }),
                ...(providerStatus === undefined ? {} : { providerStatus }),
              } as const;
              logDiagnostic(() =>
                diagnostics.recordModelAttempt?.({
                  ...labels,
                  ...status,
                  ...tokens,
                }),
              );
              const captured = await capture;
              if (captured) {
                await diagnostics.captureModelContent?.({
                  attempt,
                  request: captured.request,
                  secrets: captured.secrets,
                  ...(response === undefined ? {} : { response }),
                  ...(schema === undefined ? {} : { schema }),
                  status,
                });
              }
              if (error) throw error;
            },
            { ...labels, stage: "model.request" },
          ),
        )
        .catch(() => undefined),
    };
    this.#active.push(exchange);
    return exchange;
  }
}

export function countTokens(usage: LanguageModelUsage): Tokens {
  const { inputTokens, outputTokens, inputTokenDetails, outputTokenDetails } =
    usage;
  const cacheTokens = inputTokenDetails.cacheReadTokens;
  const reasoningTokens = outputTokenDetails.reasoningTokens;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheTokens === undefined ? {} : { cacheTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

async function requestDetails(
  request: Request,
  credential?: string,
): Promise<{ request: Json; secrets: string[] }> {
  const secrets = [...request.headers]
    .filter(([name]) =>
      /(?:auth|cookie|api[-_]?key|token|secret|signature|credential)/i.test(
        name,
      ),
    )
    .map(([, value]) => value);
  if (credential) secrets.push(credential);
  const body = request.body ? await captureBody(request.clone()) : undefined;
  return {
    request: {
      method: request.method,
      ...(body === undefined ? {} : { body }),
    },
    secrets: [...new Set(secrets)],
  };
}

async function captureBody(request: Request): Promise<Json> {
  const mediaType =
    request.headers.get("content-type")?.split(";")[0] ??
    "application/octet-stream";
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    const body = await request.text();
    try {
      return withoutMedia(JSON.parse(body) as Json);
    } catch {
      return { mediaType, sizeBytes: Buffer.byteLength(body) };
    }
  }
  if (
    mediaType === "multipart/form-data" ||
    mediaType === "application/x-www-form-urlencoded"
  ) {
    return [...(await request.formData())].map(([name, value]) => ({
      name,
      value:
        typeof value === "string"
          ? withoutMedia(value)
          : { mediaType: value.type, sizeBytes: value.size },
    }));
  }
  return { mediaType, sizeBytes: (await request.blob()).size };
}

function withoutMedia(value: Json): Json {
  if (typeof value === "string") {
    const data =
      /^data:([^;,]+)(?:;[^;,]+)*;base64,([A-Za-z0-9+/_-]*={0,2})$/.exec(value);
    return data ? encodedMedia(data[2]!, data[1]!) : value;
  }
  if (Array.isArray(value)) return value.map(withoutMedia);
  if (!value || typeof value !== "object") return value;
  const mime = value.mimeType ?? value.mediaType;
  const typedData =
    typeof mime === "string"
      ? mime
      : typeof value.format === "string"
        ? "audio/" + value.format
        : undefined;
  return Object.fromEntries(
    Object.entries(value).map(([field, entry]) => [
      field,
      typeof entry === "string" &&
      ((field === "data" && typedData) ||
        /^(?:file_data|b64_json|base64)$/i.test(field))
        ? /^data:/i.test(entry)
          ? withoutMedia(entry)
          : encodedMedia(entry, typedData ?? "application/octet-stream")
        : withoutMedia(entry),
    ]),
  );
}

function encodedMedia(data: string, mediaType: string): Json {
  const sizeBytes = Math.floor((data.replace(/=+$/, "").length * 3) / 4);
  return { mediaType, sizeBytes };
}
