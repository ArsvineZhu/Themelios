import type { Json } from "./json.js";

export type MessageParams = Readonly<Record<string, string | number | boolean>>;

export interface AppErrorOptions {
  code: string;
  messageKey: string;
  params?: MessageParams;
  details?: Json;
  retryable?: boolean;
  traceId?: string;
  cause?: unknown;
}

export interface ErrorInfo {
  code: string;
  message: string;
  details?: Json;
  retryable: boolean;
  traceId?: string;
}

export class AppError extends Error {
  readonly code: string;
  readonly messageKey: string;
  readonly params?: MessageParams;
  readonly details?: Json;
  readonly retryable: boolean;
  traceId?: string;

  constructor(input: AppErrorOptions) {
    super(input.messageKey, { cause: input.cause });
    this.name = "AppError";
    this.code = input.code;
    this.messageKey = input.messageKey;
    this.retryable = input.retryable ?? false;
    if (input.params !== undefined) this.params = input.params;
    if (input.details !== undefined) this.details = input.details;
    if (input.traceId !== undefined) this.traceId = input.traceId;
  }
}

export function attachTraceId(error: unknown, traceId?: string): void {
  if (traceId && error instanceof AppError && !error.traceId) {
    error.traceId = traceId;
  }
}

export function appError(
  code: string,
  options: Omit<AppErrorOptions, "code" | "messageKey"> = {},
): AppError {
  return new AppError({ ...options, code, messageKey: code });
}

export function toAppError(error: unknown): AppError {
  return error instanceof AppError
    ? error
    : appError("internal.unexpected", { cause: error });
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export function toErrorInfo(
  error: unknown,
  translate: (key: string, params?: MessageParams) => string = (key) => key,
  traceId?: string,
): ErrorInfo {
  const {
    code,
    messageKey,
    params,
    details,
    retryable,
    traceId: attachedTraceId,
  } = toAppError(error);
  const resolvedTraceId = traceId ?? attachedTraceId;
  return {
    code,
    message: translate(messageKey, params),
    retryable,
    ...(details === undefined ? {} : { details }),
    ...(resolvedTraceId === undefined ? {} : { traceId: resolvedTraceId }),
  };
}
