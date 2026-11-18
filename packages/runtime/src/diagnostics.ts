import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { AppError, type Json } from "@themelios/core";
import pino from "pino";
import { createStream } from "rotating-file-stream";
import type { RuntimeSettings } from "./settings.js";

export interface LogFields {
  [key: string]: Json;
}

export interface TraceFrame {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly operation: string;
  completedEvent?: boolean;
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
  log(
    level: LogLevel,
    event: string,
    fields?: LogFields,
    traceOverride?: TraceFrame,
  ): void;
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

export interface RuntimeDiagnostics extends Diagnostics {
  correlate(): { traceId?: string; spanId?: string };
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

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

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

export async function createRuntimeDiagnostics(input: {
  settings: RuntimeSettings;
  logs: string;
  correlationId: string;
  level: () => LogLevel | undefined;
  capture: () => boolean | undefined;
  traceScope: {
    current(): TraceFrame | undefined;
    enter<T>(frame: TraceFrame, work: () => Promise<T>): Promise<T>;
  };
}): Promise<RuntimeDiagnostics> {
  const { settings, logs, correlationId, traceScope } = input;
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
  let attachments = 0;

  const diagnostics: RuntimeDiagnostics = {
    correlate() {
      const current = traceScope.current();
      return current
        ? { traceId: current.traceId, spanId: current.spanId }
        : {};
    },

    log(level, event, fields = {}, traceOverride) {
      if (
        closed ||
        levels[level] < levels[input.level() ?? settings.logging.level]
      )
        return;
      const current = traceOverride ?? traceScope.current();
      logger[level]({
        ...(redactDiagnostics(fields) as LogFields),
        event,
        correlationId,
        ...(current
          ? {
              operation: current.operation,
              traceId: current.traceId,
              spanId: current.spanId,
              ...(current.parentSpanId === undefined
                ? {}
                : { parentSpanId: current.parentSpanId }),
            }
          : {}),
      });
    },

    async span(name, work, fields = {}) {
      const parent = traceScope.current();
      const frame: TraceFrame = {
        traceId: parent?.traceId ?? newTraceId(),
        spanId: newSpanId(),
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        operation: parent?.operation ?? name,
      };
      const root = !parent;
      const begin = performance.now();
      let outcome: "success" | "failure" = "success";
      let code = "";
      return traceScope.enter(frame, async () => {
        try {
          return await work();
        } catch (error) {
          outcome = "failure";
          code = error instanceof AppError ? error.code : "internal.unexpected";
          throw error;
        } finally {
          const durationMs = Math.round(performance.now() - begin);
          if (!frame.completedEvent || root) {
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
              frame,
            );
          }
        }
      });
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
      const frame = traceScope.current();
      if (frame) frame.completedEvent = true;
      diagnostics.log(
        outcome === "success" ? "info" : "warn",
        "model.request.completed",
        {
          connection,
          binding,
          outcome,
          ...(code ? { code } : {}),
          stage: "model.request",
          attempt,
          durationMs,
          ...(providerStatus === undefined ? {} : { providerStatus }),
          ...(inputTokens === undefined ? {} : { inputTokens }),
          ...(outputTokens === undefined ? {} : { outputTokens }),
          ...(cacheTokens === undefined ? {} : { cacheTokens }),
          ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        },
        frame,
      );
    },

    async captureModelContent({ attempt, secrets = [], ...contents }) {
      if (!diagnostics.capturesModelContent?.()) return;
      const frame = traceScope.current();
      if (!frame) return;
      const directory = join(logs, "model-content", frame.traceId);
      const sequence = attachments++;
      const filename = join(directory, `${frame.spanId}-${sequence}.json`);
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
        !closed && (input.capture() ?? settings.logging.captureModelContent)
      );
    },

    recordQueueWait(stage, queueMs, labels = {}) {
      diagnostics.log("debug", "queue.acquired", { stage, queueMs, ...labels });
    },

    recordNetworkBytes() {},

    async flush() {
      const stream = file;
      if (stream)
        await new Promise<void>((resolve) => stream.write("", () => resolve()));
    },

    async close() {
      if (closed) return;
      await diagnostics.flush();
      closed = true;
      file?.end();
      await fileDone;
    },
  };
  return diagnostics;
}
