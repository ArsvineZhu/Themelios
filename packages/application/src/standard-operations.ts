import {
  configurationOperations,
  instanceOperations,
  type AnyOperation,
  type ConfigurationOperationTarget,
  type InstanceOperationTarget,
} from "@themelios/runtime/operations";
import {
  contentOperations,
  type ContentOperationTarget,
} from "./content-operations.js";
import { taskOperations, type TaskOperationTarget } from "./task-operations.js";

export type StandardApplicationTarget = InstanceOperationTarget &
  ConfigurationOperationTarget &
  ContentOperationTarget &
  TaskOperationTarget;

export function standardOperations<
  App extends StandardApplicationTarget,
>(): readonly AnyOperation<App>[] {
  return [
    ...instanceOperations<App>(),
    ...contentOperations<App>(),
    ...taskOperations<App>(),
    ...configurationOperations<App>(),
  ];
}
