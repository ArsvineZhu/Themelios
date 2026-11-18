import type { Json } from "@themelios/core";
import { failure } from "../failure.js";

type Obj = Record<string, Json>;
const unsafe = new Set(["__proto__", "constructor", "prototype"]);

export const isObject = (value: unknown): value is Obj =>
  value !== null &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

export function pointer(parts: readonly string[]): string {
  return parts
    .map((key) => "/" + key.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("");
}

export function pathParts(path: string): string[] {
  const parts = path.startsWith("/")
    ? path
        .slice(1)
        .split("/")
        .map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"))
    : path.split(".");
  if (
    parts.some((key) => !key || unsafe.has(key)) ||
    (path.startsWith("/") && /~(?![01])/.test(path))
  ) {
    throw failure("config.unknown_setting", { path });
  }
  return parts;
}

export function at(
  value: Json | undefined,
  path: readonly string[],
): Json | undefined {
  return path.reduce<Json | undefined>(
    (parent, key) =>
      isObject(parent) && Object.hasOwn(parent, key) ? parent[key] : undefined,
    value,
  );
}

export function setAt(
  object: Obj,
  path: readonly string[],
  value: Json | undefined,
): void {
  let current = object;
  const parents: [Obj, string][] = [];
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(current, key) || !isObject(current[key])) {
      if (value === undefined) return;
      current[key] = {};
    }
    parents.push([current, key]);
    current = current[key] as Obj;
  }
  const key = path.at(-1)!;
  if (value !== undefined) current[key] = value;
  else {
    delete current[key];
    for (const [parent, name] of parents.reverse()) {
      if (Object.keys(parent[name] as Obj).length) break;
      delete parent[name];
    }
  }
}

export function merge(lower: Obj, upper: Obj): Obj {
  const result = { ...lower };
  for (const [key, value] of Object.entries(upper)) {
    const previous = Object.hasOwn(result, key) ? result[key] : undefined;
    result[key] =
      isObject(previous) && isObject(value) ? merge(previous, value) : value;
  }
  return result;
}

export function leafPaths(value: Json, path: string[] = []): string[][] {
  return isObject(value) && Object.keys(value).length
    ? Object.entries(value).flatMap(([key, child]) =>
        leafPaths(child, [...path, key]),
      )
    : [path];
}

export function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function assertValues(
  value: unknown,
  path: string[] = [],
): asserts value is Json {
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (unsafe.has(key))
        throw failure("config.unknown_setting", {
          path: pointer([...path, key]),
        });
      assertValues(child, [...path, key]);
    }
  } else if (Array.isArray(value)) {
    value.forEach((child, index) =>
      assertValues(child, [...path, String(index)]),
    );
  } else if (!(
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )) {
    throw failure("config.invalid", {
      issues: [{ path: pointer(path), messageKey: "config.invalid_value" }],
    });
  }
}

export function matches(
  pattern: readonly string[],
  path: readonly string[],
): boolean {
  return (
    pattern.length <= path.length &&
    pattern.every(
      (segment, index) => segment === "*" || segment === path[index],
    )
  );
}
