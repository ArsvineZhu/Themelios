import type { SettingIssue } from "@themelios/runtime/settings";
import { z } from "zod";
import {
  connectionSchema,
  modelBindingSchema,
  modelDefaultsSchema,
  modelNameSchema,
  taskRouteSchema,
} from "./schema.js";

export const modelConfigurationSchema = modelDefaultsSchema
  .extend({
    connections: z.record(modelNameSchema, connectionSchema).default({}),
    bindings: z.record(modelNameSchema, modelBindingSchema).default({}),
    tasks: z.record(modelNameSchema, taskRouteSchema).default({}),
  })
  .prefault({});

export type ModelConfiguration = z.output<typeof modelConfigurationSchema>;
export type ModelConfigurationInput = Partial<ModelConfiguration>;

/** Reports broken references and requirements in an effective model configuration. */
export function modelConfigurationIssues(
  models: ModelConfiguration,
): SettingIssue[] {
  const hasBinding = (name: string) => Object.hasOwn(models.bindings, name);
  return [
    ...bindingIssues(models),
    ...Object.entries(models.tasks).flatMap(([name, route]) => {
      const path = "/models/tasks/" + name;
      return [
        ...routeBindings(path, route, hasBinding),
        ...ruleIssues(
          path + "/preparation/representations",
          route.preparation?.representations ?? [],
          hasBinding,
        ),
        ...ruleIssues(
          path + "/preparation/models",
          route.preparation?.models ?? [],
          hasBinding,
        ),
      ];
    }),
  ];
}

function bindingIssues({
  bindings,
  connections,
}: ModelConfiguration): SettingIssue[] {
  const issues: SettingIssue[] = [];
  for (const [name, binding] of Object.entries(bindings)) {
    const path = "/models/bindings/" + name;
    if (!Object.hasOwn(connections, binding.connection))
      issues.push({
        path: path + "/connection",
        messageKey: "model.connection_not_found",
      });
    if (
      binding.capabilities.operations.includes("embed") &&
      !binding.embeddingSpace
    )
      issues.push({
        path: path + "/embeddingSpace",
        messageKey: "model.embedding_space_required",
      });
  }
  return issues;
}

function routeBindings(
  path: string,
  route: ModelConfiguration["tasks"][string],
  hasBinding: (name: string) => boolean,
): SettingIssue[] {
  const targets = [
    ["model", route.model] as const,
    ...(route.fallback ?? []).map(
      (binding, index) => ["fallback/" + index, binding] as const,
    ),
  ];
  return targets
    .filter(([, binding]) => !hasBinding(binding))
    .map(([field]) => ({
      path: path + "/" + field,
      messageKey: "model.binding_not_found",
    }));
}

function ruleIssues(
  path: string,
  rules: readonly { mediaType: string; model?: string }[],
  hasBinding: (name: string) => boolean,
): SettingIssue[] {
  const issues: SettingIssue[] = [];
  const patterns = new Set<string>();
  for (const rule of rules) {
    if (patterns.has(rule.mediaType))
      issues.push({
        path,
        messageKey: "input.duplicate_media_type",
        params: { type: rule.mediaType },
      });
    patterns.add(rule.mediaType);
    if (rule.model !== undefined && !hasBinding(rule.model))
      issues.push({ path, messageKey: "model.binding_not_found" });
  }
  return issues;
}
