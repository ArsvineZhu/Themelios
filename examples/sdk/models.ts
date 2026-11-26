import {
  createModels,
  createPrompts,
  defineTask,
  describeTask,
  presentTask,
  textOutput,
  z,
} from "@themelios/models";
import { inlineText } from "@themelios/core";
import type {
  Connection,
  ModelBinding,
  ModelOperation,
} from "@themelios/models";
const action = Bun.argv[2] ?? "all";
const live = process.env.DEMO_LIVE === "1";
const routes = new Map<Connection["protocol"], readonly ModelOperation[]>([
  ["openai-compatible", ["generate", "embed"]],
  ["openai", ["generate", "embed", "transcribe"]],
  ["google", ["generate", "embed"]],
  ["cohere", ["rank"]],
]);
const requestedProtocol = process.env.DEMO_PROTOCOL;
const protocol = [...routes.keys()].find(
  (candidate) => candidate === requestedProtocol,
);
if (requestedProtocol !== undefined && protocol === undefined)
  throw Error("Unknown demo protocol " + requestedProtocol);
const selectedRoutes = [...routes].filter(
  ([name]) => protocol === undefined || protocol === name,
);
if (
  action !== "all" &&
  !selectedRoutes.some(([, operations]) =>
    operations.some((operation) => operation === action),
  )
)
  throw Error("No selected protocol demonstrates " + action);

function demoEndpoint() {
  const credential = "env:DEMO_KEY" as const;
  if (!live)
    return {
      baseURL: "http://fixture.invalid/v1",
      providerModel: "fixture",
      credential,
    } as const;
  const {
    DEMO_URL: baseURL,
    DEMO_MODEL: providerModel,
    DEMO_KEY: key,
  } = process.env;
  if (!baseURL || !providerModel || !protocol || action === "all")
    throw Error(
      "Set DEMO_PROTOCOL, DEMO_URL, DEMO_MODEL and choose generate, embed, rank or transcribe.",
    );
  return {
    baseURL,
    providerModel,
    ...(key ? { credential } : {}),
  };
}

const { providerModel, ...endpoint } = demoEndpoint();
const useFixture = live
  ? {}
  : {
      fetch: fixtureFetch,
      resolveCredential: async () => "fixed-demo-token",
    };
const text = (s: string) => ({ kind: "text" as const, text: s });
const json = (body: unknown) => Response.json(body);
const counters = new Map<string, number>();
async function chatFixture(request: Request): Promise<Response> {
  const raw = await request.json();
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

async function fixtureFetch(request: Request) {
  const path = new URL(request.url).pathname;
  counters.set(path, (counters.get(path) ?? 0) + 1);
  const endpoint = path.slice(
    Math.max(path.lastIndexOf("/"), path.lastIndexOf(":")) + 1,
  );
  const fixture = fixtures.get(endpoint);
  if (!fixture) throw Error("No sample response for " + path);
  return fixture(request);
}

const teaTaskId = "tea.name";
const operationSettings: Partial<
  Record<ModelOperation, Partial<ModelBinding>>
> = {
  embed: {
    embeddingSpace: {
      id: "tea-vectors",
      dimensions: Number(process.env.DEMO_DIMENSIONS ?? 2),
      metric: "cosine",
      normalization: "l2",
      purposes: ["query", "document"],
    },
  },
  transcribe: {
    parameters: {
      providerOptions: { openai: { responseFormat: "verbose_json" } },
    },
  },
};

function create(protocol: Connection["protocol"], operation: ModelOperation) {
  return createModels(
    {
      connections: { gateway: { protocol, ...endpoint } },
      bindings: {
        tea: {
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
          ...operationSettings[operation],
        },
      },
      maxAttempts: 1,
      timeoutMs: 30000,
      concurrency: 2,
    },
    useFixture,
  );
}
const request = {
  model: "tea",
  messages: [{ role: "user" as const, parts: [text("Name one tea")] }],
  output: textOutput,
};
for (const [name, operations] of selectedRoutes) {
  for (const operation of operations) {
    if (action !== "all" && action !== operation) continue;
    const models = create(name, operation);
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
                output: {
                  kind: "json",
                  schema: z.strictObject({ tea: z.string() }),
                },
              })
            ).value,
          );
          for await (const event of models.stream(request))
            console.log(event.type);
          const task = defineTask({
            id: teaTaskId,
            title: "Tea",
            purpose: "Read the note",
            input: z.strictObject({ language: z.string() }),
            output: textOutput,
            requirements: {
              minMaterials: 1,
              inputs: [{ mediaType: "text/plain", accepts: [["text"]] }],
            },
            templates: {
              inline: true,
              user: "Read {{ language }}: {% for item in sources %}{{ item.key }} {% endfor %}",
            },
          });
          const prompts = createPrompts();
          console.log("task", (await describeTask(task, prompts)).id);
          const { tasks } = models;
          const input = {
            variables: { language: "en" },
            materials: [{ source: inlineText("Earl Grey") }],
          };
          console.log(
            "preview",
            (await tasks.preview(task, input)).sources.entries,
          );
          console.log("run", presentTask(task, await tasks.run(task, input)));
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
