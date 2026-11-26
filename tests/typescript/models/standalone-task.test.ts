import { expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createModels, defineTask, presentTask } from "@themelios/models";
import { z } from "zod";
import { documentSummary } from "../../../apps/workbench/src/document-summary.js";

test("standalone tasks preview, run and present an inline task on a local file", async () => {
  const work = join("temp", "work");
  await mkdir(work, { recursive: true });
  const dir = await mkdtemp(join(work, "standalone-task-"));
  const notePath = join(dir, "note.txt");
  await Bun.write(notePath, "Today we shipped the unified operation router.");

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1_700_000_000,
        model: "mock-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                title: "Router Release",
                sections: [
                  {
                    heading: "Progress",
                    markdown: "Shipped the unified router.",
                    sourceKeys: ["S1", "S1"],
                  },
                ],
                notes: "",
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 },
      });
    },
  });

  const inlineSummary = defineTask({
    ...documentSummary,
    input: z.strictObject({
      language: z.literal("en").transform((): string => "English"),
      maxSections: z.number().int().positive(),
      focus: z.string().nullable(),
    }),
    examples: [],
    templates: {
      inline: true,
      system: "Summarize the sources faithfully.",
      user: "Summarize {{ sources[0].name }} in {{ language }} with up to {{ maxSections }} sections. Bytes: {{ sources[0].originalExtent.bytes }}.",
    },
  });

  const models = createModels({
    connections: {
      local: {
        protocol: "openai-compatible",
        baseURL: new URL("/v1", server.url).href,
      },
    },
    bindings: {
      summarizer: {
        connection: "local",
        providerModel: "mock-model",
        capabilities: {
          operations: ["generate"],
          inputMimeTypes: ["text/plain"],
          needs: ["text"],
          structuredOutput: true,
          streaming: false,
        },
      },
    },
    tasks: {
      [inlineSummary.id]: { model: "summarizer" },
    },
  });

  try {
    const input = {
      variables: { language: "en" as const, maxSections: 3, focus: null },
      materials: [{ source: { file: notePath } }],
    };
    const preview = await models.tasks.preview(inlineSummary, input);
    expect(preview.messages.flatMap(({ parts }) => parts)).toContainEqual({
      kind: "text",
      text: "Summarize note.txt in English with up to 3 sections. Bytes: 46.",
    });
    const completed = await models.tasks.run(inlineSummary, input);
    expect(completed.value).toEqual({
      title: "Router Release",
      sections: [
        {
          heading: "Progress",
          markdown: "Shipped the unified router.",
          sourceKeys: ["S1"],
        },
      ],
      notes: "",
    });
    expect(completed.inputs[0]?.source).toMatchObject({
      mediaType: "text/plain",
      name: "note.txt",
    });
    expect(presentTask(inlineSummary, completed)).toContain("source:S1");
  } finally {
    await models.close();
    await server.stop(true);
  }
});
