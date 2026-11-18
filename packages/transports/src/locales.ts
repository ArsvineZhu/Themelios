import { readFileSync } from "node:fs";
import { join } from "node:path";

function dictionary(language: string): Readonly<Record<string, string>> {
  const path = join(
    import.meta.dir,
    "..",
    "resources",
    "locales",
    language,
    "transports.json",
  );
  return Object.freeze(
    JSON.parse(readFileSync(path, "utf8")) as Record<string, string>,
  );
}

export const locales = Object.freeze({
  en: dictionary("en"),
  "zh-CN": dictionary("zh-CN"),
});
