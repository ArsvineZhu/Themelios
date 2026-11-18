import { expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createModels, defineTask } from "@themelios/models";
import { z } from "zod";
import { documentSummary } from "../../../apps/workbench/src/document-summary.js";

test("standalone models.runTask runs inline templates on local files without storage and deduplicates repeated sourceKeys", async () => {
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
    templates: {
      inline: true,
      system: "Summarize the sources faithfully.",
      user: "Summarize {{ sources[0].name }} in {{ language }} with up to {{ maxSections }} sections.",
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
    routes: {
      [inlineSummary.id]: { model: "summarizer" },
    },
  });

  try {
    const completed = await models.runTask(inlineSummary, {
      variables: { language: "en", maxSections: 3, focus: null },
      materials: [{ path: notePath }],
    });
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

    const quickTask = defineTask({
      id: "custom.echo",
      title: "Echo Title",
      purpose: "Return uppercase text.",
      input: z.strictObject({ prefix: z.string() }),
      output: "text",
      requirements: {
        minMaterials: 1,
        inputs: [{ mediaType: "text/plain", needs: ["text"] }],
      },
      templates: {
        inline: true,
        user: "{{ prefix }}",
      },
    });
    expect(quickTask.title).toBe("Echo Title");
  } finally {
    await models.close();
    await server.stop(true);
  }
});
