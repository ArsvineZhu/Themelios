import type { ZodType } from "zod";
import type {
  CallOptions,
  Completed,
  ErrorInfo,
  Flow,
  Json,
  SavedResult,
} from "@themelios/core";
import type { Content } from "@themelios/content";
import type { Configuration, InstanceInfo } from "@themelios/runtime";
import type { ApplicationPrompts } from "@themelios/models/prompts";
import type { ModelParameters } from "@themelios/models";
import type {
  Preview,
  TaskDescription,
  TaskMaterial,
} from "@themelios/models/tasks";

export type Permission = "read" | "write" | "admin";
export interface Principal {
  id: string;
  permissions: readonly Permission[];
}

export interface RunTaskInput {
  task: string;
  variables: Json;
  materials: readonly TaskMaterial[];
  model?: string;
  parameters?: ModelParameters;
  persist?: boolean;
}
export type TaskResult = Completed<Json> | SavedResult<Json>;
export type BatchItemResult =
  { ok: true; result: TaskResult } | { ok: false; error: ErrorInfo };

export interface ApplicationTasks {
  run(
    input: RunTaskInput & { persist: true },
    options?: CallOptions,
  ): Promise<SavedResult<Json>>;
  run(
    input: RunTaskInput & { persist?: false },
    options?: CallOptions,
  ): Promise<Completed<Json>>;
  run(input: RunTaskInput, options?: CallOptions): Promise<TaskResult>;
  stream(input: RunTaskInput, options?: CallOptions): Flow<TaskResult>;
  runMany(
    inputs: readonly RunTaskInput[],
    options?: CallOptions,
  ): Promise<readonly BatchItemResult[]>;
  preview(
    input: Omit<RunTaskInput, "persist">,
    options?: CallOptions,
  ): Promise<Preview>;
  /** 返回生成自 TaskDefinition 的可序列化帮助、Schema、模板位置与示例。 */
  describe(id: string): Promise<TaskDescription>;
  list(): readonly { id: string; title: string; purpose: string }[];
}

export interface ApplicationApi<S = unknown> {
  readonly materials: Content["materials"];
  readonly results: Content["results"];
  readonly representations: Content["representations"];
  readonly tasks: ApplicationTasks;
  readonly prompts: ApplicationPrompts;
  readonly configuration: Configuration<S>;
  info(): InstanceInfo;
}

export interface OperationContext {
  readonly principal: Principal;
  readonly locale: string;
  readonly options: CallOptions;
  readonly maxJsonBytes?: number;
}

/** 目录记录外部入口的机械形状；execute调用唯一的Application能力。 */
export interface Operation<I, O> {
  id: string;
  description?: string;
  input: ZodType<I>;
  output: ZodType<O>;
  permission: Permission;
  mode: "unary" | "stream";
  execute(input: I, context: OperationContext): Promise<O> | Flow<O>;
}
