import {
  createOperationDirectory,
  type AnyOperation,
  type OperationDirectory,
} from "@themelios/runtime/operations";

export function resolveDirectory<App>(
  operations: readonly AnyOperation<App>[],
  allowOperations?: readonly string[],
): OperationDirectory<App> {
  if (!allowOperations) return createOperationDirectory(operations);
  const allow = new Set(allowOperations);
  return createOperationDirectory(operations.filter((op) => allow.has(op.id)));
}
