import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TaskDescription } from "@themelios/models/tasks";
import { repoRoot } from "./workspaces.js";

const app = pathToFileURL(join(repoRoot, "apps/workbench/dist/main.js")).href;
const { workbenchTaskDescriptions } = (await import(app)) as {
  workbenchTaskDescriptions(locale: string): Promise<TaskDescription[]>;
};
const destination = join(repoRoot, "docs", "tasks");
await mkdir(destination, { recursive: true });
for (const task of await workbenchTaskDescriptions("zh-CN")) {
  const schema = (value: unknown) => JSON.stringify(value, null, 2);
  const code = (value: unknown) => "\n```json\n" + schema(value) + "\n```\n";
  const templates = task.templates
    .map(
      (template) =>
        "- `" +
        template.role +
        "`：`" +
        template.path.replaceAll("\\", "/").split("/").at(-1) +
        "`。",
    )
    .join("\n");
  const lines = [
    "# " + task.title,
    "",
    task.purpose,
    "",
    "## 输入与材料",
    "",
    "任务 ID 为 `" +
      task.id +
      "`。每次调用接收 " +
      task.requirements.minMaterials +
      " 至 " +
      (task.requirements.maxMaterials ?? "任意多") +
      " 份材料。",
    "",
    ...task.requirements.inputs.map(
      (input) =>
        "- `" + input.mediaType + "`：" + input.needs.join("、") + "。",
    ),
    "",
    "变量 Schema 见 [输入合同](" +
      task.id +
      ".input.schema.json)。本次来源以 `S1`、`S2` 等键按输入排序。" +
      "模板能读取名称、类型、角色、原件范围、请求选区和实际交付，程序随后追加正文或媒体。",
    code(task.sourcesSchema),
    "## 输出",
    "",
    task.output.kind === "text"
      ? "返回自由文本。"
      : "返回 [结构化对象](" + task.id + ".output.schema.json)。",
    "",
    ...task.outputRules.map((rule) => "- " + rule),
    "",
    "## 编辑和预览",
    "",
    templates,
    "",
    "导出当前用户模板，编辑后写入实例覆盖。`request.json` 使用工作台指南中的任务请求格式。",
    "",
    "```sh",
    "themelios prompt read " + task.id + " --part user > edited.liquid",
    "themelios prompt edit " + task.id + " --part user --file edited.liquid",
    "themelios task preview --input request.json --json",
    "themelios task run --input request.json --save",
    "```",
    "",
    ...task.examples.flatMap((example) => [
      "## 示例 " + example.name,
      "",
      "变量",
      code(example.variables),
      "来源",
      code(example.sources),
      "结果",
      code(example.output),
    ]),
  ];
  await Bun.write(
    join(destination, task.id + ".md"),
    lines.join("\n").trimEnd() + "\n",
  );
  await Bun.write(
    join(destination, task.id + ".input.schema.json"),
    schema(task.inputSchema) + "\n",
  );
  if (task.output.kind === "json") {
    await Bun.write(
      join(destination, task.id + ".output.schema.json"),
      schema(task.output.schema) + "\n",
    );
  }
}
console.log("Wrote task references to docs/tasks.");
