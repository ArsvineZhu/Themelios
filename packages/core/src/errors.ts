import type { Json } from "./json.js";

export type MessageParams = Readonly<Record<string, string | number | boolean>>;

export interface AppErrorOptions {
  code: string;
  messageKey: string;
  params?: MessageParams;
  details?: Json;
  retryable?: boolean;
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

  constructor(input: AppErrorOptions) {
    super(input.messageKey, { cause: input.cause });
    this.name = "AppError";
    this.code = input.code;
    this.messageKey = input.messageKey;
    this.retryable = input.retryable ?? false;
    if (input.params !== undefined) this.params = input.params;
    if (input.details !== undefined) this.details = input.details;
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

export function toErrorInfo(
  error: unknown,
  translate: (key: string, params?: MessageParams) => string = (key) => key,
  traceId?: string,
): ErrorInfo {
  const { code, messageKey, params, details, retryable } = toAppError(error);
  return {
    code,
    message: translate(messageKey, params),
    retryable,
    ...(details === undefined ? {} : { details }),
    ...(traceId === undefined ? {} : { traceId }),
  };
}
