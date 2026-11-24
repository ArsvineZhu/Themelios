import {
  createModels,
  createPreparation,
  createPrompts,
  createTasks,
  defineTask,
  describeTask,
  z,
} from "@themelios/models";
import type {
  Connection,
  ModelBinding,
  ModelOperation,
} from "@themelios/models";
import { createSourceDirectory } from "@themelios/models/tasks";
const action = Bun.argv[2] ?? "all";
const live = process.env.DEMO_LIVE === "1";
const protocol = process.env.DEMO_PROTOCOL as
  Connection["protocol"] | undefined;
const baseURL = live ? process.env.DEMO_URL : "http://fixture.invalid/v1";
const providerModel = live ? process.env.DEMO_MODEL : "fixture";
if (!baseURL || !providerModel || (live && (!protocol || action === "all")))
  throw Error(
    "Set DEMO_PROTOCOL, DEMO_URL, DEMO_MODEL and choose generate, embed, rank or transcribe.",
  );
const endpoint = {
  baseURL,
  ...(!live || process.env.DEMO_KEY
    ? { credential: "env:DEMO_KEY" as const }
    : {}),
};
const useFixture = live
  ? {}
  : {
      fetch: fixtureFetch,
      resolveCredential: async () => "fixed-demo-token",
    };
const text = (s: string) => ({ kind: "text" as const, text: s });
const json = (body: unknown) => Response.json(body);
const counters = new Map<string, number>();
function chatFixture(init?: RequestInit): Response {
  const raw = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  const message = raw.response_format ? '{"tea":"Earl Grey"}' : "Earl Grey";
  if (raw.stream) {
    const sequence = [
      { delta: { role: "assistant", content: message }, finish_reason: null },
      { delta: {}, finish_reason: "stop" },
    ];
    return new Response(
      sequence
        .map(
          (v) =>
            "data: " +
            JSON.stringify({
              id: "c1",
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture",
              choices: [{ index: 0, ...v }],
            }) +
            "\n\n",
        )
        .join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  return json({
    id: "c1",
    object: "chat.completion",
    created: 1,
    model: "fixture",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: message },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
}

const fixtures = new Map(
  Object.entries({
    embeddings: () =>
      json({
        object: "list",
        data: [{ index: 0, object: "embedding", embedding: [3, 4] }],
        usage: { prompt_tokens: 2, total_tokens: 2 },
        model: "fixture",
      }),
    batchEmbedContents: () => json({ embeddings: [{ values: [3, 4] }] }),
    embedContent: () => json({ embedding: { values: [3, 4] } }),
    generateContent: () =>
      json({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Earl Grey" }] },
            finishReason: "STOP",
          },
        ],
      }),
    rerank: () => json({ results: [{ index: 1, relevance_score: 0.95 }] }),
    transcriptions: () =>
      json({
        text: "Tea",
        duration: 1,
        language: "english",
        words: [{ word: "Tea", start: 0.1, end: 0.75 }],
        segments: [
          {
            id: 0,
            seek: 0,
            start: 0.1,
            end: 0.75,
            text: "Tea",
            tokens: [],
            temperature: 0,
            avg_logprob: 0,
            compression_ratio: 1,
            no_speech_prob: 0,
          },
        ],
      }),
    responses: () =>
      json({
        id: "resp_1",
        created_at: 1,
        model: "fixture",
        status: "completed",
        output: [
          {
            type: "message",
            id: "m_1",
            role: "assistant",
            content: [
              { type: "output_text", text: "Earl Grey", annotations: [] },
            ],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      }),
    completions: chatFixture,
  }),
);

async function fixtureFetch(input: string | URL | Request, init?: RequestInit) {
  const path = new URL(input instanceof Request ? input.url : String(input))
    .pathname;
  counters.set(path, (counters.get(path) ?? 0) + 1);
  const endpoint = path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf(":")) + 1,
  );
  const fixture = fixtures.get(endpoint);
  if (!fixture) throw Error("No sample response for " + path);
  return fixture(init);
}

const create = (
  protocol: Connection["protocol"],
  operation: ModelOperation,
) => {
  const binding: ModelBinding = {
    connection: "gateway",
    providerModel,
    capabilities: {
      operations: [operation],
      needs: ["text", "speech", "visual"],
      inputMimeTypes: ["text/plain", "audio/wav", "image/png"],
      streaming: true,
      structuredOutput: true,
      transcriptionTimestamps: ["segment", "word"],
    },
    ...(operation === "embed"
      ? {
          embeddingSpace: {
            id: "tea-vectors",
            dimensions: Number(process.env.DEMO_DIMENSIONS ?? 2),
            metric: "cosine",
            normalization: "l2",
            purposes: ["query", "document"],
          },
        }
      : {}),
  };
  const configured =
    operation === "transcribe"
      ? {
          ...binding,
          parameters: {
            providerOptions: { openai: { responseFormat: "verbose_json" } },
          },
        }
      : binding;
  return createModels({
    connections: { gateway: { protocol, ...endpoint } },
    bindings: { tea: configured },
    defaults: { maxAttempts: 1, timeoutMs: 30000, concurrency: 2 },
    ...useFixture,
  });
};
const routes: Record<Connection["protocol"], ModelOperation[]> = {
  "openai-compatible": ["generate", "embed"],
  openai: ["generate", "embed", "transcribe"],
  google: ["generate", "embed"],
  cohere: ["rank"],
};
const request = {
  model: "tea",
  messages: [{ role: "user" as const, parts: [text("Name one tea")] }],
  output: "text" as const,
};
for (const [name, operations] of Object.entries(routes)) {
  if (protocol && name !== protocol) continue;
  for (const operation of operations) {
    if (action !== "all" && action !== operation) continue;
    const models = create(name as Connection["protocol"], operation);
    try {
      console.log(name, operation, models.describe("tea").providerModel);
      if (operation === "generate") {
        console.log((await models.generate(request)).value);
        if (name === "openai")
          console.log(
            "chat",
            (
              await models.generate({
                ...request,
                parameters: { providerOptions: { openai: { api: "chat" } } },
              })
            ).value,
          );
        if (name === "openai-compatible") {
          console.log(
            "object",
            (
              await models.generate({
                ...request,
                output: z.strictObject({ tea: z.string() }),
              })
            ).value,
          );
          for await (const event of models.stream(request))
            console.log(event.type);
          const task = defineTask({
            id: "tea.name",
            title: "Tea",
            purpose: "Read the note",
            input: z.strictObject({ language: z.string() }),
            output: "text",
            requirements: {
              minMaterials: 1,
              inputs: [{ mediaType: "text/plain", needs: ["text"] }],
            },
            templates: {
              inline: true,
              user: "Read {{ language }}: {% for item in sources %}{{ item.key }} {% endfor %}",
            },
          });
          const prompts = createPrompts();
          const directory = createSourceDirectory([
            {
              key: "S1",
              mediaType: "text/plain",
              originalExtent: { kind: "text", bytes: 9 },
              requestedRange: null,
              delivered: [
                {
                  mediaType: "text/plain",
                  sourceRange: null,
                  extent: { kind: "text", bytes: 9 },
                },
              ],
              role: "primary",
            },
          ]);
          console.log("source", directory.has("S1"), directory.link("S1"));
          console.log(
            "task",
            (await describeTask(task, prompts)).id,
            "compiled",
            (await prompts.compile(task, { language: "en" }, directory))
              .messages.length,
          );
          const tasks = createTasks({
            models,
            prompts,
            preparation: createPreparation(),
            routes: { "tea.name": { model: "tea" } },
          });
          const input = {
            variables: { language: "en" },
            materials: [{ text: "Earl Grey" }],
          };
          console.log(
            "preview",
            (await tasks.preview(task, input)).sources.entries,
          );
          console.log("runTask", (await models.runTask(task, input)).value);
          console.log(
            "many",
            (
              await tasks.runMany(task, [input, { ...input, materials: [] }])
            ).map((x) => x.ok),
          );
          for await (const event of tasks.stream(task, input))
            console.log("task", event.type);
        }
      } else if (operation === "embed") {
        for (const purpose of ["query", "document"] as const) {
          console.log(
            purpose,
            (
              await models.embed({
                model: "tea",
                inputs: [[text("tea")]],
                purpose,
              })
            ).vectors,
          );
        }
        if (name === "google" && !live)
          console.log(
            "multimodal",
            (
              await models.embed({
                model: "tea",
                inputs: [
                  [
                    text("swatch"),
                    {
                      kind: "media",
                      mediaType: "image/png",
                      bytes: Buffer.from(
                        "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEklEQVR4nGNkOMEAAUwMDBgsABZYAM4QradeAAAAAElFTkSuQmCC",
                        "base64",
                      ),
                    },
                  ],
                ],
                purpose: "document",
              })
            ).vectors,
          );
      } else if (operation === "rank")
        console.log(
          "top1",
          (
            await models.rank({
              model: "tea",
              query: "tea",
              documents: ["Chair", "Earl Grey"],
              topN: 1,
            })
          ).ranking,
        );
      else {
        const bytes = live
          ? await Bun.file(process.env.DEMO_AUDIO ?? "utterance.wav").bytes()
          : new Uint8Array([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69]);
        for (const timestamps of [undefined, "segment", "word"] as const)
          console.log(
            timestamps ?? "plain",
            await models.transcribe({
              model: "tea",
              audio: { mediaType: "audio/wav", bytes },
              language: "en",
              ...(timestamps ? { timestamps } : {}),
            }),
          );
      }
    } finally {
      await models.close();
    }
  }
}
if (!live)
  console.log("sample provider requests", Object.fromEntries(counters));
