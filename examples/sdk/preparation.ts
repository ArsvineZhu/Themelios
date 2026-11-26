import {
  applicationSettings,
  createApplicationModule,
} from "@themelios/application";
import { AppError } from "@themelios/core";
import { defineTask, mediaDescription, textOutput, z } from "@themelios/models";
import { Installation } from "@themelios/runtime";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const counts: Record<string, number> = {};
const transcriptionsPath = "/v1/audio/transcriptions";
const visionProviderModel = "eye";
let lastAudio: Uint8Array | undefined;
let visionPrompt = "";
let visionTemperature: number | undefined;
const gateway = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    counts[path] = (counts[path] ?? 0) + 1;
    if (path === transcriptionsPath) {
      const attachment = (await req.formData()).get("file");
      if (attachment instanceof Blob)
        lastAudio = new Uint8Array(await attachment.arrayBuffer());
      return Response.json({ text: "Tea at 3." });
    }
    const body = await req.json();
    const describeImage = body.model === visionProviderModel;
    if (describeImage) {
      visionPrompt = JSON.stringify(body.messages);
      visionTemperature = body.temperature;
    }
    return Response.json({
      id: "c-1",
      created: 1,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: describeImage ? "Green square." : "Tea note.",
          },
          finish_reason: "stop",
        },
      ],
    });
  },
});
const root = await mkdtemp(
  join(process.env.DEMO_TMP_PARENT ?? tmpdir(), "themelios-route-"),
);
const app = defineTask({
  id: "notes.summary",
  title: "Notes",
  purpose: "Summarize a material",
  input: z.strictObject({}),
  output: textOutput,
  templates: { inline: true, user: "Summarize the sources." },
  requirements: {
    inputs: [
      { mediaType: "image/*", accepts: [["visual"]] },
      { mediaType: "audio/*", accepts: [["speech"]] },
      { mediaType: "text/plain", accepts: [["text"]] },
    ],
    minMaterials: 1,
  },
});
const module = createApplicationModule({
  settings: applicationSettings,
  id: "routes",
  formatId: "routes",
  resourceRoot: root,
  tasks: [app, mediaDescription],
});
const instance = Installation.at(root, module).instance("default");
await instance.init();
await mkdir(join(root, "config"), { recursive: true });
const cfg = `
[models.connections.gateway]
protocol="openai-compatible"
baseURL="${gateway.url.href}v1"
[models.connections.audio]
protocol="openai"
baseURL="${gateway.url.href}v1"
credential="env:DEMO_LOCAL_SECRET"
[models.bindings.main]
connection="gateway"
providerModel="note"
[models.bindings.main.capabilities]
operations=["generate"]
inputMimeTypes=["text/plain"]
needs=["text"]
structuredOutput=false
streaming=false
[models.bindings.eye]
connection="gateway"
providerModel="${visionProviderModel}"
[models.bindings.eye.capabilities]
operations=["generate"]
inputMimeTypes=["text/plain","image/png"]
needs=["visual","text"]
structuredOutput=false
streaming=false
[models.bindings.ear]
connection="audio"
providerModel="ear"
[models.bindings.ear.capabilities]
operations=["transcribe"]
inputMimeTypes=["audio/wav"]
needs=["speech"]
structuredOutput=false
streaming=false
[models.tasks."notes.summary"]
model="main"
[[models.tasks."notes.summary".preparation.models]]
mediaType="image/*"
recipe="media.describe"
model="eye"
[[models.tasks."notes.summary".preparation.models]]
mediaType="audio/*"
recipe="speech.transcribe"
model="ear"
[models.tasks."media.describe"]
model="eye"
[models.tasks."media.describe".parameters]
temperature=0.25
[models.tasks."media.describe".variables]
language="ja"
`;
await writeFile(join(root, "config", "installation.toml"), cfg);
process.env.DEMO_LOCAL_SECRET = "demo-loopback";
const session = await instance.open();
try {
  const api = session.api;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEklEQVR4nGNkOMEAAUwMDBgsABZYAM4QradeAAAAAElFTkSuQmCC",
    "base64",
  );
  const wav = Buffer.alloc(204);
  wav.write("RIFF");
  wav.writeUInt32LE(196, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(160, 40);
  for (let frame = 0; frame < 80; frame++)
    wav.writeInt16LE(frame + 1, 44 + frame * 2);
  for (const [bytes, mediaType] of [
    [png, "image/png"],
    [wav, "audio/wav"],
  ] as const) {
    const source = await api.materials.accept({ bytes, mediaType });
    const materials = [
      { source },
      {
        source: {
          bytes: new TextEncoder().encode("Tea"),
          mediaType: "text/plain",
        },
        role: "context" as const,
      },
    ];
    const request = { task: "notes.summary", materials, variables: {} };
    const before = await api.tasks.preview(request);
    const completed = await api.tasks.runAndSave(request);
    const after = await api.tasks.preview(request);
    console.log(
      mediaType,
      "before",
      before.pending,
      "saved",
      "ref" in completed,
      "after",
      after.pending,
      after.sources.entries.map((s) => s.role),
      counts,
    );
    if (mediaType === "image/png") {
      await api.prompts.setOverride("media.describe", {
        role: "user",
        template:
          "Describe in {{ language }}. Source: {{ sources[0].originalExtent | extent }}.",
      });
      const overridden = await api.tasks.preview(request);
      await api.tasks.run(request);
      if (
        !overridden.pending.length ||
        !visionPrompt.includes("Describe in ja. Source: 3 × 3 px") ||
        visionTemperature !== 0.25
      ) {
        throw Error(
          "Auxiliary description did not use the active template, language, or model parameters.",
        );
      }
      console.log(
        "auxiliary override",
        visionPrompt.includes("Describe in ja."),
      );
    }
    if (mediaType === "audio/wav") {
      const selected = {
        ...source,
        range: { kind: "time" as const, startMs: 2, endMs: 4 },
      };
      const slice = { ...request, materials: [{ source: selected }] };
      const planned = await api.tasks.preview(slice);
      const saved = await api.tasks.runAndSave(slice);
      const posted = Buffer.from(lastAudio ?? []);
      const expected = wav.subarray(44 + 16 * 2, 44 + 32 * 2);
      if (posted.length !== 76 || !posted.subarray(44).equals(expected)) {
        throw Error(
          "Transcription attachment differs from the selected PCM frames.",
        );
      }
      const transcriptions = counts[transcriptionsPath];
      try {
        await api.tasks.run({
          ...request,
          materials: [
            {
              source: {
                ...source,
                range: { kind: "time", startMs: 9, endMs: 11 },
              },
            },
          ],
        });
        throw Error("Out-of-range selection was accepted.");
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          error.code !== "content.range_invalid" ||
          counts[transcriptionsPath] !== transcriptions
        )
          throw error;
      }
      console.log(
        "time selection",
        planned.sources.entries[0],
        "original bytes",
        bytes.length,
        "posted bytes",
        posted.length,
        "selected frames",
        [posted.readInt16LE(44), posted.readInt16LE(posted.length - 2)],
        "saved coverage",
        saved.inputs[0]?.coverage,
      );
    }
  }
} finally {
  await session.close();
  await gateway.stop(true);
}
