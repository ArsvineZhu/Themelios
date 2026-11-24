import { delimiter, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createApplicationModule,
  describeTask,
  mediaDescription,
  type ApplicationDefinition,
} from "@themelios/application";
import { createImageAdapter, createWaveAdapter } from "@themelios/content";
import { locales as contentLocales } from "@themelios/content/locales";
import { createPrompts } from "@themelios/models/prompts";
import { createMediaAdapters } from "@themelios/media";
import { createPdfAdapters } from "@themelios/pdf";
import {
  createLocalizer,
  mergeLocales,
  type Dictionaries,
} from "@themelios/runtime/locales";
import { locales as storageLocales } from "@themelios/storage/locales";
import { locales as transportLocales } from "@themelios/transports/locales";
import { documentSummary } from "./document-summary.js";

const taskResources = fileURLToPath(
  new URL("../resources/tasks/", import.meta.url),
);
const tasks = [documentSummary, mediaDescription] as const;
const languages = ["zh-CN", "en"] as const;
const taskDictionaries = await Promise.all(
  tasks.map(
    async (task) =>
      Object.fromEntries(
        await Promise.all(
          languages.map(async (locale) => [
            locale,
            await Bun.file(
              taskResources + task.id + "/locales/" + locale + ".json",
            ).json(),
          ]),
        ),
      ) as Dictionaries,
  ),
);
const locales = mergeLocales(
  contentLocales,
  storageLocales,
  transportLocales,
  ...taskDictionaries,
);
export const releaseRecipes = [
  createImageAdapter(),
  createWaveAdapter(),
  ...createPdfAdapters(),
  ...createMediaAdapters(),
].map(({ description: { id, version } }) => ({ id, version }));

export const workbenchId = "themelios.workbench";

type Extension = Partial<
  Pick<ApplicationDefinition, "tasks" | "adapters" | "locales">
>;

async function loadExtension(path: string): Promise<Extension> {
  const extension = (await import(pathToFileURL(path).href))
    .default as Extension;
  if (!extension || typeof extension !== "object" || Array.isArray(extension))
    throw new Error(
      `Expected a Workbench extension as the default export of ${path}`,
    );
  return extension;
}

export async function createWorkbench(cwd: string) {
  const paths = (process.env.THEMELIOS_EXTENSIONS ?? "")
    .split(delimiter)
    .filter(Boolean);
  const extensions = await Promise.all(
    paths.map((path) => loadExtension(resolve(cwd, path))),
  );
  return createApplicationModule({
    id: workbenchId,
    formatId: workbenchId,
    resourceRoot: taskResources,
    tasks: [
      ...tasks,
      ...extensions.flatMap((extension) => extension.tasks ?? []),
    ],
    adapters: extensions.flatMap((extension) => extension.adapters ?? []),
    createAdapters: ({ maxMaterialBytes, image, media }) => {
      const limits = { maxBytes: maxMaterialBytes, maxPixels: image.maxPixels };
      return [
        ...createPdfAdapters(limits),
        ...createMediaAdapters({ ...limits, ...media }),
      ];
    },
    locales: mergeLocales(
      locales,
      ...extensions.flatMap((extension) =>
        extension.locales ? [extension.locales] : [],
      ),
    ),
  });
}

export async function workbenchTaskDescriptions(locale: string) {
  const prompts = createPrompts({ resourceRoot: taskResources, locale });
  const translate = await createLocalizer(locales);
  return [
    await describeTask(documentSummary, prompts, (key) =>
      translate(locale, key),
    ),
    await describeTask(mediaDescription, prompts, (key) =>
      translate(locale, key),
    ),
  ];
}
