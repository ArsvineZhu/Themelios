import { z } from "zod";
import { defineTask, type OutputIssue } from "@themelios/models/tasks";

const input = z
  .object({
    language: z
      .enum(["zh-CN", "en"])
      .default("zh-CN")
      .meta({ descriptionKey: "tasks.summary.fields.language" }),
    maxSections: z
      .number()
      .int()
      .min(1)
      .max(12)
      .default(6)
      .meta({ descriptionKey: "tasks.summary.fields.maxSections" }),
    focus: z
      .string()
      .max(2000)
      .nullable()
      .default(null)
      .meta({ descriptionKey: "tasks.summary.fields.focus" }),
  })
  .strict();

const section = z
  .object({
    heading: z
      .string()
      .min(1)
      .max(160)
      .meta({ descriptionKey: "tasks.summary.fields.heading" }),
    markdown: z
      .string()
      .min(1)
      .max(20000)
      .meta({ descriptionKey: "tasks.summary.fields.markdown" }),
    sourceKeys: z
      .array(z.string().regex(/^S[1-9][0-9]*$/))
      .min(1)
      .max(64)
      .meta({ descriptionKey: "tasks.summary.fields.sourceKeys" }),
  })
  .strict();

const output = z
  .object({
    title: z
      .string()
      .min(1)
      .max(200)
      .meta({ descriptionKey: "tasks.summary.fields.title" }),
    sections: z
      .array(section)
      .max(12)
      .meta({ descriptionKey: "tasks.summary.fields.sections" }),
    notes: z
      .string()
      .max(4000)
      .meta({ descriptionKey: "tasks.summary.fields.notes" }),
  })
  .strict();

export const documentSummary = defineTask<
  z.output<typeof input>,
  z.output<typeof output>,
  z.input<typeof input>
>({
  id: "document.summary",
  titleKey: "tasks.summary.title",
  purposeKey: "tasks.summary.purpose",
  input,
  output,
  requirements: {
    minMaterials: 1,
    maxMaterials: 64,
    inputs: [
      { mediaType: "text/plain", needs: ["text"] },
      { mediaType: "text/markdown", needs: ["text"] },
      { mediaType: "application/json", needs: ["text"] },
      { mediaType: "application/pdf", needs: ["text"] },
      { mediaType: "image/*", needs: ["visual"] },
    ],
  },
  templates: { system: "system.md.liquid", user: "user.md.liquid" },
  outputRuleKeys: [
    "tasks.summary.rules.sectionCount",
    "tasks.summary.rules.sourceKeys",
    "tasks.summary.rules.uniqueKeys",
  ],
  examples: [
    {
      name: "project-progress",
      variables: { language: "zh-CN", maxSections: 3, focus: null },
      sources: [
        {
          key: "S1",
          mediaType: "text/plain",
          name: "progress.txt",
          text: "本周完成资料目录迁移。已保存的文本材料可以离线读取。下一步接入真实模型。",
          originalExtent: "全文",
          deliveredExtent: ["全文"],
          role: "primary",
        },
      ],
      output: {
        title: "资料工作台进展",
        sections: [
          {
            heading: "当前进度",
            markdown:
              "资料目录迁移已经完成，已保存文本支持离线读取。下一步工作是接入真实模型。",
            sourceKeys: ["S1"],
          },
        ],
        notes: "",
      },
    },
  ],
  validateOutput(value, sources, variables) {
    const issues: OutputIssue[] = [];
    if (value.sections.length > variables.maxSections) {
      issues.push({
        path: ["sections"],
        code: "section_count",
        messageKey: "tasks.summary.errors.sectionCount",
        params: { max: variables.maxSections, actual: value.sections.length },
      });
    }
    value.sections.forEach((item, sectionIndex) => {
      const used = new Set<string>();
      item.sourceKeys.forEach((key, keyIndex) => {
        if (!sources.has(key)) {
          issues.push({
            path: ["sections", sectionIndex, "sourceKeys", keyIndex],
            code: "unknown_source",
            messageKey: "tasks.summary.errors.unknownSource",
            params: { key },
          });
        }
        if (used.has(key)) {
          issues.push({
            path: ["sections", sectionIndex, "sourceKeys", keyIndex],
            code: "duplicate_source",
            messageKey: "tasks.summary.errors.duplicateSource",
            params: { key },
          });
        }
        used.add(key);
      });
    });
    return issues;
  },
  present(value, sources) {
    return (
      [
        `# ${value.title}`,
        ...value.sections.flatMap((item) => [
          `## ${item.heading}`,
          item.markdown,
          item.sourceKeys
            .map((key) => `[${key}](${sources.link(key)})`)
            .join(" "),
        ]),
        ...(value.notes ? [value.notes] : []),
      ].join("\n\n") + "\n"
    );
  },
});
