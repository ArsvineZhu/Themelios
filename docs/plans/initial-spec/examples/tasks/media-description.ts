import { z } from "zod";
import { defineTask } from "@themelios/models/tasks";

const input = z.object({
  language: z.enum(["zh-CN", "en"]).default("zh-CN")
    .meta({ descriptionKey: "tasks.mediaDescription.fields.language" }),
  instructions: z.string().max(4000).nullable().default(null)
    .meta({ descriptionKey: "tasks.mediaDescription.fields.instructions" }),
}).strict();

export const mediaDescription = defineTask<
  z.output<typeof input>, string, z.input<typeof input>
>({
  id: "media.describe",
  titleKey: "tasks.mediaDescription.title",
  purposeKey: "tasks.mediaDescription.purpose",
  input,
  output: "text",
  requirements: {
    minMaterials: 1,
    maxMaterials: 1,
    inputs: [
      { mediaType: "text/plain", needs: ["text"] },
      { mediaType: "text/markdown", needs: ["text"] },
      { mediaType: "image/*", needs: ["visual"] },
      { mediaType: "application/pdf", needs: ["text", "visual"] },
      { mediaType: "audio/*", needs: ["speech"] },
      { mediaType: "video/*", needs: ["visual", "speech", "motion"] },
    ],
  },
  templates: { system: "system.md.liquid", user: "user.md.liquid" },
  examples: [{
    name: "short-note",
    variables: { language: "zh-CN", instructions: null },
    sources: [{
      key: "S1", mediaType: "text/plain", role: "primary",
      originalExtent: "全文", deliveredExtent: ["全文"],
      text: "下午三点在图书馆讨论接口设计。",
    }],
    output: "这是一条安排讨论的文字通知：时间为下午三点，地点为图书馆，主题为接口设计。",
  }],
});
