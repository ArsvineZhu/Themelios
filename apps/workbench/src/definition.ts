import { fileURLToPath } from "node:url";
import { createApplicationModule, describeTask } from "@themelios/application";
import { createImageAdapter } from "@themelios/application/inputs";
import { mediaDescription } from "@themelios/application/tasks";
import { locales as contentLocales } from "@themelios/content/locales";
import { createPrompts } from "@themelios/models/prompts";
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
const adapters = createPdfAdapters();
export const releaseRecipes = [createImageAdapter(), ...adapters].map(
  ({ description: { id, version } }) => ({ id, version }),
);

export const workbenchApplication = createApplicationModule({
  id: "themelios.workbench",
  formatId: "themelios.workbench/1",
  resourceRoot: taskResources,
  tasks,
  adapters,
  locales,
});

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
