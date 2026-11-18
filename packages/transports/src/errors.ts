import {
  appError,
  toAppError,
  type ErrorInfo,
  type Json,
  type MessageParams,
} from "@themelios/core";
import { locales as runtimeLocales } from "@themelios/runtime/locales";
import { locales } from "./locales.js";
import type { Translate } from "./types.js";

type Mapping = [http: number, cli: number];
const mappings = new Map<string, Mapping>();
function map(status: Mapping, codes: string): void {
  for (const code of codes.split(/\s+/)) mappings.set(code, status);
}
map(
  [400, 2],
  "transport.invalid_request input.invalid config.invalid content.range_invalid content.selection_invalid content.schema_invalid content.media_mismatch input.invalid_source_key time.precision_unsupported model.invalid_request model.input_too_large runtime.instance_name_invalid",
);
map([401, 3], "transport.auth_required");
map([403, 3], "transport.access_denied runtime.read_only");
map(
  [404, 4],
  "transport.not_found runtime.instance_not_found config.unknown_setting content.not_found content.output_not_found model.binding_not_found tasks.not_found",
);
map([409, 5], "runtime.instance_exists storage.already_exists");
map(
  [409, 5],
  "runtime.instance_busy runtime.instance_not_empty runtime.application_mismatch runtime.format_mismatch storage.format_mismatch call.invalid_state call.stream_consumed time.domain_conflict",
);
map([410, 4], "storage.history_unavailable");
map(
  [413, 2],
  "transport.request_too_large transport.result_too_large content.inline_too_large",
);
map([415, 2], "transport.unsupported_media_type");
map([422, 2], "time.overflow time.order_undefined time.domain_mismatch");
map(
  [422, 2],
  "content.text_unavailable model.capability_missing model.refused input.capability_missing",
);
map([422, 2], "content.decode_failed content.result_cycle");
map([429, 7], "model.rate_limited");
map([499, 130], "call.cancelled");
map([500, 1], "storage.blob_missing storage.blob_corrupt");
map(
  [502, 7],
  "network.failed model.authentication_failed model.output_truncated model.incomplete model.output_invalid",
);
map([503, 7], "model.unavailable");
map([503, 1], "runtime.closed");
map([503, 1], "secret.unavailable");
map([504, 6], "call.timeout network.timeout");

export function httpStatus(code: string): number {
  return mappings.get(code)?.[0] ?? 500;
}

export function cliExitCode(code: string): number {
  return mappings.get(code)?.[1] ?? 1;
}

export const transportError = (code: string, details?: Json, cause?: unknown) =>
  appError(code, { ...(details === undefined ? {} : { details }), cause });

export function errorLocale(
  header: string | null | undefined,
  fallback = "zh-CN",
): string {
  const choices = (header ?? "").split(",").flatMap((item) => {
    const [tag, quality] = item.trim().toLowerCase().split(";");
    if (!tag || !/^(?:en|zh)(?:-|$)/.test(tag)) return [];
    const weight =
      quality === undefined ? 1 : Number(quality.trim().replace(/^q=/, ""));
    if (!Number.isFinite(weight) || weight <= 0 || weight > 1) return [];
    return [{ locale: tag.startsWith("zh") ? "zh-CN" : "en", weight }];
  });
  return choices.sort((a, b) => b.weight - a.weight)[0]?.locale ?? fallback;
}

export interface ErrorPresentation {
  locale?: string;
  local?: boolean;
  translate?: (key: string, params?: MessageParams) => string;
  traceId?: string;
}

export function normalizeError(
  error: unknown,
  options: ErrorPresentation = {},
): ErrorInfo {
  const appErr = toAppError(error);
  const { code, messageKey, params, details, retryable } = appErr;
  const language = options.locale === "en" ? "en" : "zh-CN";
  const dictionary = runtimeLocales[language];
  const translated = options.translate?.(messageKey, params);
  const text =
    (translated && translated !== messageKey ? translated : undefined) ??
    dictionary[messageKey] ??
    locales[language][messageKey] ??
    runtimeLocales.en[messageKey] ??
    code;
  const message = text.replace(
    /\{\{\s*([\w.]+)\s*\}\}/g,
    (_token, key: string) => String(params?.[key] ?? ""),
  );
  const visible =
    details === undefined || options.local ? details : sanitize(details, code);
  const traceId = options.traceId ?? appErr.traceId;
  return {
    code,
    message,
    retryable,
    ...(visible === undefined ? {} : { details: visible }),
    ...(traceId ? { traceId } : {}),
  };
}

export function localizedError(
  error: unknown,
  locale: string,
  translate?: Translate,
): ErrorInfo {
  return normalizeError(error, {
    locale,
    ...(translate
      ? { translate: (key, params) => translate(locale, key, params) }
      : {}),
  });
}

function sanitize(value: Json, code: string): Json {
  if (Array.isArray(value)) return value.map((item) => sanitize(item, code));
  if (!value || typeof value !== "object") return value;
  const files = /^(?:path|file|modulePath|staging|destination)$/;
  const privatePath =
    /^(?:storage\.|runtime\.|transport\.delivery_failed)/.test(code);
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/^(?:stack|cause|secret|password|authorization|headers)$/i.test(
            key,
          ) && !(files.test(key) && (key !== "path" || privatePath)),
      )
      .map(([key, item]) => [key, sanitize(item, code)]),
  );
}
