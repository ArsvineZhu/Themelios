import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { repoRoot } from "../../scripts/workspaces.js";

const model = process.env.THEMELIOS_MODEL_ID;
const baseURL = process.env.THEMELIOS_MODEL_URL;
if (!model || !baseURL) {
  console.error(
    "Set THEMELIOS_MODEL_URL and THEMELIOS_MODEL_ID. Set THEMELIOS_MODEL_KEY if the endpoint requires a key.",
  );
  process.exit(2);
}
const credential =
  process.env.THEMELIOS_MODEL_KEY === undefined
    ? {}
    : { credential: "env:THEMELIOS_MODEL_KEY" };
const visionURL = process.env.THEMELIOS_VISION_URL;
const visionId = process.env.THEMELIOS_VISION_ID;
const media = process.argv.includes("--media");
const work = join(repoRoot, "temp", "work");
await mkdir(work, { recursive: true });
const sandbox = await mkdtemp(join(work, "workbench-live-"));
const installationRoot = join(sandbox, "工作台 数据");
const config = join(installationRoot, "config");
await mkdir(config, { recursive: true });
const modelConfig = {
  locale: "en",
  models: {
    connections: {
      live: { protocol: "openai-compatible", baseURL, ...credential },
      ...(media && visionURL && visionId
        ? {
            vision: {
              protocol: "openai-compatible",
              baseURL: visionURL,
              ...(process.env.THEMELIOS_VISION_KEY === undefined
                ? {}
                : { credential: "env:THEMELIOS_VISION_KEY" }),
            },
          }
        : {}),
    },
    bindings: {
      summary: {
        connection: "live",
        providerModel: model,
        capabilities: {
          operations: ["generate"],
          inputMimeTypes: ["text/plain"],
          needs: ["text"],
          structuredOutput: true,
          streaming: true,
        },
        parameters: { temperature: 0, maxOutputTokens: 768 },
      },
      ...(media && visionURL && visionId
        ? {
            vision: {
              connection: "vision",
              providerModel: visionId,
              capabilities: {
                operations: ["generate"],
                inputMimeTypes: ["text/plain", "image/png"],
                needs: ["text", "visual"],
                structuredOutput: false,
                streaming: true,
              },
              parameters: { temperature: 0, maxOutputTokens: 256 },
            },
          }
        : {}),
    },
    tasks: {
      "document.summary": {
        model: "summary",
        ...(media && visionURL && visionId
          ? {
              preparation: {
                models: [
                  {
                    mediaType: "image/*",
                    recipe: "media.describe",
                    model: "vision",
                  },
                ],
              },
            }
          : {}),
      },
      ...(media && visionURL && visionId
        ? { "media.describe": { model: "vision" } }
        : {}),
    },
  },
};
const configPath = join(config, "installation.toml");
await Bun.write(configPath, Bun.TOML.stringify(modelConfig));
const portableFolder = process.argv
  .slice(2)
  .find((arg) => !arg.startsWith("--"));
const portable =
  portableFolder === undefined ? undefined : resolve(portableFolder);
const app =
  portable === undefined
    ? [
        process.execPath,
        "--no-install",
        join(repoRoot, "apps/workbench/dist/main.js"),
      ]
    : [
        join(
          portable,
          "runtime",
          process.platform === "win32" ? "bun.exe" : "bun",
        ),
        "--no-install",
        join(portable, "app", "launch.mjs"),
      ];

async function command(args: string[], json = true) {
  const child = Bun.spawn(
    [
      ...app,
      "--installation",
      installationRoot,
      ...(json ? ["--json"] : []),
      ...args,
    ],
    {
      cwd: sandbox,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, error, code };
}
async function cli(...args: string[]): Promise<string> {
  const { out, error, code } = await command(args);
  if (code !== 0)
    throw new Error(args.join(" ") + " failed (" + code + ")\n" + error.trim());
  return out;
}

const importFile = async (name: string) =>
  JSON.parse(await cli("material", "import", "--file", name)) as {
    ref: string;
  };
async function input(
  name: string,
  task: string,
  variables: unknown,
  selection: unknown,
) {
  await Bun.write(
    join(sandbox, name),
    JSON.stringify({ task, variables, materials: [{ source: selection }] }),
  );
}
const delivered = (raw: string) =>
  JSON.parse(raw) as {
    ref: string;
    value: unknown;
    inputs: {
      source: { ref: string; range?: unknown };
      delivered: { ref: string }[];
    }[];
  };
async function runPdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf
    .addPage()
    .drawText("PAGE ONE: inventory for March", { x: 50, y: 700, font });
  pdf
    .addPage()
    .drawText("PAGE TWO: three blue notebooks", { x: 50, y: 700, font });
  pdf.addPage();
  await Bun.write(join(sandbox, "two notes.pdf"), await pdf.save());
  const document = await importFile("two notes.pdf");
  const page = { ...document, range: { kind: "pages", start: 2, end: 3 } };
  await Bun.write(
    join(sandbox, "pdf-prompt.liquid"),
    'Summarize the attached PDF text in English. Return a title, one short Markdown sentence in sections, sourceKeys ["S1"], and an empty notes string. Keep the title and sentence under twelve words each.\n',
  );
  await cli(
    "prompt",
    "edit",
    "document.summary",
    "--part",
    "user",
    "--file",
    "pdf-prompt.liquid",
  );
  await input(
    "pdf.json",
    "document.summary",
    { language: "en", maxSections: 3 },
    page,
  );
  const preview = JSON.parse(
    await cli("task", "preview", "--input", "pdf.json"),
  ) as { pending: { action: string }[] };
  if (preview.pending[0]?.action !== "pdf.text")
    throw new Error("Expected PDF text extraction in preview.");
  const selected = delivered(
    await cli("task", "run", "--input", "pdf.json", "--save"),
  );
  const textRef = selected.inputs[0]?.delivered[0]?.ref;
  if (
    !textRef ||
    selected.inputs[0]?.source.ref !== document.ref ||
    !isDeepStrictEqual(selected.inputs[0].source.range, page.range)
  )
    throw new Error("Saved PDF span was lost.");
  const { text } = JSON.parse(await cli("material", "text", textRef)) as {
    text: string;
  };
  if (!text.includes("PAGE TWO") || text.includes("PAGE ONE"))
    throw new Error("Model input did not contain only the requested PDF page.");
  const reopenedPreview = JSON.parse(
    await cli("task", "preview", "--input", "pdf.json"),
  );
  if (reopenedPreview.pending.length)
    throw new Error("Saved PDF representation is unavailable after reopen.");
  const repeated = delivered(
    await cli("task", "run", "--input", "pdf.json", "--save"),
  );
  if (repeated.inputs[0]?.delivered[0]?.ref !== textRef)
    throw new Error(
      "Repeated execution did not reuse the exact delivered material.",
    );
  const rendered = await command(["task", "run", "--input", "pdf.json"], false);
  if (rendered.code || !rendered.out.includes("[S1](")) {
    throw new Error("Expected Markdown with a source link: " + rendered.error);
  }
  await input(
    "empty.json",
    "document.summary",
    { language: "en" },
    { ...document, range: { kind: "pages", start: 3, end: 4 } },
  );
  const empty = await command(["task", "run", "--input", "empty.json"]);
  if (
    empty.code === 0 ||
    !empty.error.includes('"code":"input.capability_missing"')
  ) {
    throw new Error("Expected the blank page to fail before a model request.");
  }
  await cli("prompt", "reset", "document.summary", "--part", "user");

  return selected.ref;
}

async function runVision() {
  const panel = (width: number, color: string) =>
    sharp({
      create: {
        width,
        height: 256,
        channels: 3,
        background: color,
      },
    })
      .png()
      .toBuffer();
  const blue = await panel(128, "#1b44ef");
  await Bun.write(
    join(sandbox, "red and blue.png"),
    await sharp(await panel(256, "#ef1616"))
      .composite([{ input: blue, left: 128, top: 0 }])
      .png()
      .toBuffer(),
  );
  const image = await importFile("red and blue.png");
  const crop = {
    ...image,
    range: { kind: "image", x: 128, y: 0, width: 128, height: 256 },
  };
  await input(
    "vision.json",
    "media.describe",
    {
      language: "en",
      instructions: "Name the dominant color of the selected image.",
    },
    crop,
  );
  const description = delivered(
    await cli("task", "run", "--input", "vision.json", "--save"),
  );
  const croppedRef = description.inputs[0]?.delivered[0]?.ref;
  if (
    !croppedRef ||
    typeof description.value !== "string" ||
    !/blue/i.test(description.value)
  ) {
    throw new Error(
      "Vision model did not describe the actual blue crop: " +
        JSON.stringify(description.value),
    );
  }
  await cli("material", "export", croppedRef, "crop.png");
  const cropped = await sharp(join(sandbox, "crop.png")).metadata();
  if (
    cropped.width !== crop.range.width ||
    cropped.height !== crop.range.height
  )
    throw new Error("Saved crop dimensions changed.");
  await input(
    "assisted.json",
    "document.summary",
    { language: "en", maxSections: 3 },
    crop,
  );
  const assisted = delivered(
    await cli("task", "run", "--input", "assisted.json", "--save"),
  );
  if (
    assisted.inputs[0]?.source.ref !== image.ref ||
    assisted.inputs[0].delivered[0]?.ref === image.ref
  ) {
    throw new Error(
      "Auxiliary model result did not become an actual summary input.",
    );
  }
  return { vision: description.ref, assisted: assisted.ref };
}

async function runMedia() {
  const pdf = await runPdf();
  return visionURL && visionId ? { pdf, ...(await runVision()) } : { pdf };
}

const exact =
  "Quinn placed five apples in the basket. The inventory note says there were no pears. 🍎\n";
try {
  await cli("instance", "init");
  const materialPath = join(sandbox, "original note.txt");
  await Bun.write(materialPath, exact);
  const source = JSON.parse(
    await cli("material", "import", "--file", "original note.txt"),
  ) as { ref: string };
  const input = {
    task: "document.summary",
    variables: { language: "en", maxSections: 3 },
    materials: [{ source }],
  };
  await Bun.write(join(sandbox, "request.json"), JSON.stringify(input));
  const template = JSON.parse(
    await cli("prompt", "read", input.task, "--part", "user"),
  ) as string;
  await Bun.write(
    join(sandbox, "edited.liquid"),
    template +
      '\nUse exactly one short section when a single source is supplied. Use sourceKeys ["S1"] for that section.\n',
  );
  await cli(
    "prompt",
    "edit",
    input.task,
    "--part",
    "user",
    "--file",
    "edited.liquid",
  );
  const before = JSON.parse(
    await cli("task", "preview", "--input", "request.json"),
  ) as {
    messages: { parts: { text: string }[] }[];
    sources: { entries: { key: string }[] };
    pending: unknown[];
  };
  const rendered = before.messages.flatMap((message) =>
    message.parts.map((part) => part.text),
  );
  if (
    !rendered.some((text) => text.includes("exactly one short section")) ||
    rendered.filter((text) => text === exact).length !== 1 ||
    before.sources.entries[0]?.key !== "S1" ||
    before.pending.length !== 0
  ) {
    throw new Error(
      "Preview did not use the edited template and exact material",
    );
  }
  const events = (
    await cli("task", "run", "--input", "request.json", "--save", "--stream")
  )
    .trim()
    .split(/\r?\n/)
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          value?: {
            ref: string;
            value: { sections: { sourceKeys: string[] }[] };
          };
        },
    );
  const result = events.at(-1)?.value;
  if (
    events.at(-1)?.type !== "result" ||
    !result?.ref ||
    !events.some((event) => event.type === "text-delta") ||
    !result.value.sections.some((section) => section.sourceKeys.includes("S1"))
  ) {
    throw new Error(
      "Expected a saved streaming summary with a material source.",
    );
  }
  const traced = JSON.parse(await cli("material", "sources", result.ref)) as {
    selection: { ref: string };
  }[];
  if (!traced.some((link) => link.selection.ref === source.ref))
    throw new Error("Saved result source was lost.");
  const mediaResults = media ? await runMedia() : undefined;
  modelConfig.models.connections.live.baseURL = "http://127.0.0.1:1/v1";
  await Bun.write(configPath, Bun.TOML.stringify(modelConfig));
  const read = JSON.parse(await cli("result", "read", result.ref));
  if (!isDeepStrictEqual(read, result))
    throw new Error("Reopened result differs from the saved result.");
  await cli("material", "export", source.ref, "exported.txt");
  if ((await Bun.file(join(sandbox, "exported.txt")).text()) !== exact)
    throw new Error("Export changed original bytes.");
  await cli("storage", "backup", "backup");
  await cli("--instance", "restored", "storage", "restore", "backup");
  await cli("--instance", "restored", "storage", "verify");
  const restored = JSON.parse(
    await cli("--instance", "restored", "result", "read", result.ref),
  );
  if (!isDeepStrictEqual(restored, result))
    throw new Error("Backup restoration changed the result.");
  console.log(
    JSON.stringify({
      version: Bun.version,
      providerModel: model,
      streamedEvents: events.length,
      reopened: result.ref,
      material: source.ref,
      backupRestored: true,
      installationRoot,
      media: mediaResults,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Workbench data: " + installationRoot);
  process.exitCode = 1;
}
