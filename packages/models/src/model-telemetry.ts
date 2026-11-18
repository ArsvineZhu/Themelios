import type { AppError, Json } from "@themelios/core";
import type {
  Diagnostics,
  ModelAttemptDiagnostic,
} from "@themelios/runtime/diagnostics";
import type { LanguageModelUsage } from "ai";
import type { FetchFunction, ModelIdentity } from "./types.js";

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

  observeFetch(fetch: FetchFunction, credential?: string): FetchFunction {
    if (!this.diagnostics) return fetch;
    return async (input, init) => {
      const event = this.#exchange(input, init, credential);
      const response = await fetch(input, init);
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

  #exchange(
    input: string | URL | Request,
    init?: RequestInit,
    credential?: string,
  ): Exchange {
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
    let capture: ReturnType<typeof requestDetails> | undefined;
    if (this.capturesContent)
      logDiagnostic(() => {
        capture = requestDetails(input, init, credential);
      });
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
              logDiagnostic(() =>
                diagnostics.recordModelAttempt?.({
                  ...labels,
                  durationMs,
                  outcome,
                  ...(code ? { code } : {}),
                  ...(providerStatus === undefined ? {} : { providerStatus }),
                  ...tokens,
                }),
              );
              if (capture) {
                await diagnostics.captureModelContent?.({
                  attempt,
                  request: capture.request,
                  secrets: capture.secrets,
                  ...(response === undefined ? {} : { response }),
                  ...(schema === undefined ? {} : { schema }),
                  status: {
                    outcome,
                    durationMs,
                    ...(code ? { code } : {}),
                    ...(exchange.status === undefined
                      ? {}
                      : { providerStatus: exchange.status }),
                  },
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

function requestDetails(
  input: string | URL | Request,
  init?: RequestInit,
  credential?: string,
): { request: Json; secrets: string[] } {
  const request = input instanceof Request ? input : undefined;
  const headers = new Headers(init?.headers ?? request?.headers);
  const secrets = [...headers]
    .filter(([name]) =>
      /(?:auth|cookie|api[-_]?key|token|secret|signature|credential)/i.test(
        name,
      ),
    )
    .map(([, value]) => value);
  if (credential) secrets.push(credential);
  const body = captureBody(
    init?.body,
    headers.get("content-type") ?? undefined,
  );
  return {
    request: {
      method: init?.method ?? request?.method ?? "GET",
      ...(body === undefined ? {} : { body }),
    },
    secrets: [...new Set(secrets)],
  };
}

function captureBody(
  body: RequestInit["body"],
  mediaType?: string,
): Json | undefined {
  if (typeof body === "string") {
    try {
      return withoutMedia(JSON.parse(body) as Json);
    } catch {
      return {
        mediaType: mediaType ?? "text/plain",
        sizeBytes: Buffer.byteLength(body),
      };
    }
  }
  if (body instanceof FormData) {
    return [...body].map(([name, value]) => ({
      name,
      value:
        typeof value === "string"
          ? withoutMedia(value)
          : { mediaType: value.type, sizeBytes: value.size },
    }));
  }
  if (body instanceof Blob)
    return {
      mediaType: body.type || mediaType || "application/octet-stream",
      sizeBytes: body.size,
    };
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return {
      mediaType: mediaType ?? "application/octet-stream",
      sizeBytes: body.byteLength,
    };
  }
  return undefined;
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
