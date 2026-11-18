import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { AppError, type Json } from "@themelios/core";
import pino from "pino";
import { createStream } from "rotating-file-stream";
import type { RuntimeSettings } from "./settings.js";
import type { Secrets } from "./secrets.js";

export interface LogFields {
  [key: string]: Json;
}

export interface ModelAttemptDiagnostic {
  connection: string;
  binding: string;
  attempt: number;
  durationMs: number;
  outcome: "success" | "failure" | "cancelled";
  code?: string;
  providerStatus?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  reasoningTokens?: number;
}

export interface ModelContentDiagnostic {
  attempt: number;
  request?: Json;
  response?: Json;
  schema?: Json;
  status?: Json;
  secrets?: readonly string[];
}

export interface Diagnostics {
  log(level: LogLevel, event: string, fields?: LogFields): void;
  span<T>(name: string, work: () => Promise<T>, fields?: LogFields): Promise<T>;
  flush(): Promise<void>;
  close(): void | Promise<void>;
  recordModelAttempt?(record: ModelAttemptDiagnostic): void;
  captureModelContent?(attachment: ModelContentDiagnostic): Promise<void>;
  capturesModelContent?(): boolean;
  recordQueueWait?(
    stage: string,
    queueMs: number,
    labels?: { connection?: string; binding?: string },
  ): void;
  recordNetworkBytes?(direction: "sent" | "received", size: number): void;
}

type LogLevel = RuntimeSettings["logging"]["level"];
const levels: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const secretField =
  /(?:authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|credential|private[-_]?key)$/i;

export function redactDiagnostics(value: Json): Json {
  if (Array.isArray(value)) return value.map(redactDiagnostics);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      secretField.test(key) ? "[REDACTED]" : redactDiagnostics(child),
    ]),
  );
}

function withoutSecrets(value: Json, secrets: readonly string[]): Json {
  if (typeof value === "string") {
    return secrets.reduce(
      (text, secret) => (secret ? text.replaceAll(secret, "[REDACTED]") : text),
      value,
    );
  }
  if (Array.isArray(value))
    return value.map((item) => withoutSecrets(item, secrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      withoutSecrets(child, secrets),
    ]),
  );
}

function stderr(event: string, fields: LogFields): void {
  process.stderr.write(
    JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      event,
      ...fields,
    }) + "\n",
  );
}

export function bootstrapDiagnostics(correlationId: string): Diagnostics {
  return {
    log(level, event, fields) {
      if (level === "warn" || level === "error")
        stderr(event, {
          correlationId,
          ...(redactDiagnostics(fields ?? {}) as LogFields),
        });
    },
    span(_name, work) {
      return work();
    },
    async flush() {},
    close() {},
  };
}

type Trace = {
  context: Context;
  span: Span;
  operation: string;
  completedEvent?: true;
};
const errorTraces = new WeakMap<Error, string>();

export function diagnoseError(error: Error, traceId?: string): void {
  if (traceId) errorTraces.set(error, traceId);
}

export function diagnosticTrace(error: unknown): string | undefined {
  return error instanceof Error ? errorTraces.get(error) : undefined;
}

export interface RuntimeDiagnostics extends Diagnostics {
  operation<T>(name: string, work: () => Promise<T>): Promise<T>;
  correlate(): { traceId?: string };
}

export async function createRuntimeDiagnostics(input: {
  settings: RuntimeSettings;
  logs: string;
  secrets: Secrets;
  correlationId: string;
  level: () => LogLevel | undefined;
  capture: () => boolean | undefined;
}): Promise<RuntimeDiagnostics> {
  const { settings, logs, secrets, correlationId } = input;
  const logFile = join(logs, "runtime.jsonl");
  let file: ReturnType<typeof createStream> | undefined;
  let fileDone: Promise<void> | undefined;
  if (settings.logging.file) {
    try {
      await mkdir(logs, { recursive: true });
      const stream = createStream("runtime.jsonl", {
        path: logs,
        size: String(settings.logging.rotateBytes) + "B",
        maxFiles: settings.logging.maxFiles,
      });
      file = stream;
      fileDone = finished(stream).catch((error: Error) => {
        file = undefined;
        stderr("diagnostics.file_failed", {
          file: logFile,
          reason: error.message,
          correlationId,
        });
      });
    } catch (error) {
      stderr("diagnostics.file_failed", {
        file: logFile,
        reason: String(error),
        correlationId,
      });
    }
  }
  let congested = false;
  let closed = false;
  const logger = pino(
    {
      base: null,
      level: "debug",
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    {
      write(line) {
        if (closed) return;
        if (Buffer.byteLength(line) > 32768) {
          const { time, level, event, traceId, spanId } = JSON.parse(
            line,
          ) as LogFields;
          line =
            JSON.stringify({
              time,
              level,
              event,
              traceId,
              spanId,
              truncated: true,
            }) + "\n";
        }
        if (!file || file.writableLength > 1024 * 1024) {
          const level = (JSON.parse(line) as LogFields).level;
          if (level === "warn" || level === "error") process.stderr.write(line);
          if (file && !congested) {
            congested = true;
            stderr("diagnostics.file_congested", {
              file: logFile,
              correlationId,
            });
          }
        } else {
          congested = false;
          file.write(line);
        }
      },
    },
  );
  const traceContext = new AsyncLocalStorage<Trace>();
  const { endpoint, credential } = settings.telemetry;
  const getHeaders = async () =>
    credential ? { Authorization: await secrets.resolve(credential) } : {};
  const telemetryUrl = (suffix: string) =>
    endpoint!.replace(/\/$/, "") + "/v1/" + suffix;
  const metrics = new MeterProvider({
    readers: endpoint
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: telemetryUrl("metrics"),
              headers: getHeaders,
              timeoutMillis: 2000,
            }),
            exportTimeoutMillis: 2000,
          }),
        ]
      : [],
  });
  const tracerProvider = new TracerProvider({
    spanProcessors: endpoint
      ? [
          new BatchSpanProcessor({
            exporter: new OTLPTraceExporter({
              url: telemetryUrl("traces"),
              headers: getHeaders,
              timeoutMillis: 2000,
            }),
            exportTimeoutMillis: 2000,
            maxQueueSize: 512,
            maxExportBatchSize: 128,
          }),
        ]
      : [],
  });
  const tracer = tracerProvider.getTracer("themelios.runtime");
  const meter = metrics.getMeter("themelios.runtime");
  const duration = meter.createHistogram("themelios.operation.duration", {
    unit: "ms",
  });
  const active = meter.createUpDownCounter("themelios.operation.active", {
    unit: "{operation}",
  });
  const modelAttempts = meter.createCounter("themelios.model.attempts", {
    unit: "{request}",
  });
  const modelTokens = meter.createCounter("themelios.model.tokens", {
    unit: "{token}",
  });
  const queueWait = meter.createHistogram("themelios.queue.wait", {
    unit: "ms",
  });
  const networkBytes = meter.createCounter("themelios.network.bytes", {
    unit: "By",
  });
  let attachments = 0;
  const diagnostics: RuntimeDiagnostics = {
    correlate() {
      const traceId = traceContext.getStore()?.span.spanContext().traceId;
      return traceId ? { traceId } : {};
    },
    log(level, event, fields = {}) {
      if (
        closed ||
        levels[level] < levels[input.level() ?? settings.logging.level]
      )
        return;
      const current = traceContext.getStore();
      const ids = current?.span.spanContext();
      logger[level]({
        ...(redactDiagnostics(fields) as LogFields),
        event,
        correlationId,
        ...(current ? { operation: current.operation } : {}),
        ...(ids ? { traceId: ids.traceId, spanId: ids.spanId } : {}),
      });
    },
    async span(name, work, fields = {}) {
      const parent = traceContext.getStore();
      const context = parent?.context ?? ROOT_CONTEXT;
      const span = tracer.startSpan(name, {}, context);
      const operation = parent?.operation ?? name;
      const root = !parent;
      const begin = performance.now();
      if (root) active.add(1, { operation });
      let outcome = "success";
      let code = "";
      const current: Trace = {
        context: trace.setSpan(context, span),
        span,
        operation,
      };
      return traceContext.run(current, async () => {
        try {
          const result = await work();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          outcome = "failure";
          code = error instanceof AppError ? error.code : "internal.unexpected";
          span.setStatus({ code: SpanStatusCode.ERROR, message: code });
          throw error;
        } finally {
          const durationMs = Math.round(performance.now() - begin);
          if (!current.completedEvent || root) {
            diagnostics.log(
              outcome === "success" ? "info" : "warn",
              root ? "operation.completed" : "stage.completed",
              {
                ...fields,
                stage: name,
                durationMs,
                outcome,
                ...(code ? { code } : {}),
              },
            );
          }
          if (root) {
            duration.record(durationMs, { operation, outcome, code });
            active.add(-1, { operation });
          }
          span.end();
        }
      });
    },
    operation(name, work) {
      return diagnostics.span(name, work);
    },
    recordModelAttempt(record) {
      const {
        connection,
        binding,
        attempt,
        durationMs,
        outcome,
        code = "",
        inputTokens,
        outputTokens,
        cacheTokens,
        reasoningTokens,
        providerStatus,
      } = record;
      const span = traceContext.getStore();
      if (span) span.completedEvent = true;
      const labels = { connection, binding, outcome, code };
      modelAttempts.add(1, labels);
      for (const [category, value] of Object.entries({
        input: inputTokens,
        output: outputTokens,
        cache: cacheTokens,
        reasoning: reasoningTokens,
      })) {
        if (value !== undefined && Number.isSafeInteger(value) && value >= 0)
          modelTokens.add(value, { ...labels, category });
      }
      diagnostics.log(
        outcome === "success" ? "info" : "warn",
        "model.request.completed",
        {
          ...labels,
          stage: "model.request",
          attempt,
          durationMs,
          ...(providerStatus === undefined ? {} : { providerStatus }),
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(cacheTokens === undefined ? {} : { cacheTokens }),
          ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        },
      );
    },
    async captureModelContent({ attempt, secrets = [], ...contents }) {
      if (!diagnostics.capturesModelContent?.()) return;
      const ids = traceContext.getStore()?.span.spanContext();
      if (!ids) return;
      const directory = join(logs, "model-content", ids.traceId);
      const sequence = attachments++;
      const filename = join(directory, `${ids.spanId}-${sequence}.json`);
      try {
        await mkdir(directory, { recursive: true });
        const sanitized = withoutSecrets(
          redactDiagnostics({ attempt, ...contents }),
          secrets,
        );
        await writeFile(filename, JSON.stringify(sanitized) + "\n", {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        diagnostics.log("warn", "diagnostics.content_failed", {
          attempt,
          reason: String(error),
        });
      }
    },
    capturesModelContent() {
      return (
        !closed && (input.capture() ?? settings.telemetry.captureModelContent)
      );
    },
    recordQueueWait(stage, queueMs, labels = {}) {
      queueWait.record(queueMs, { stage, ...labels });
      diagnostics.log("debug", "queue.acquired", { stage, queueMs, ...labels });
    },
    recordNetworkBytes(direction, size) {
      networkBytes.add(size, { direction });
    },
    async flush() {
      const stream = file;
      if (stream)
        await new Promise<void>((resolve) => stream.write("", () => resolve()));
      await capped(
        "flush",
        Promise.all([
          tracerProvider.forceFlush({ timeoutMillis: 2000 }),
          metrics.forceFlush(),
        ]),
        correlationId,
      );
    },
    async close() {
      if (closed) return;
      await diagnostics.flush();
      closed = true;
      file?.end();
      await fileDone;
      await capped(
        "shutdown",
        Promise.all([tracerProvider.shutdown(), metrics.shutdown()]),
        correlationId,
      );
    },
  };
  return diagnostics;
}

async function capped(
  stage: string,
  work: Promise<unknown>,
  correlationId: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("deadline_exceeded")), 2000);
      }),
    ]);
  } catch (error) {
    stderr("diagnostics.telemetry_failed", {
      stage,
      reason: String(error),
      correlationId,
    });
  } finally {
    clearTimeout(timer);
  }
}
