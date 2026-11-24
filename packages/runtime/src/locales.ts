import { appError } from "@themelios/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import i18next from "i18next";

export type Dictionaries = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

export function isLanguageTag(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function dictionary(language: string): Readonly<Record<string, string>> {
  const filename = join(
    import.meta.dir,
    "..",
    "resources",
    "locales",
    language,
    "runtime.json",
  );
  return Object.freeze(
    JSON.parse(readFileSync(filename, "utf8")) as Record<string, string>,
  );
}

export const locales = Object.freeze({
  en: dictionary("en"),
  "zh-CN": dictionary("zh-CN"),
});

export function mergeLocales(
  ...dictionaries: readonly Dictionaries[]
): Dictionaries {
  const result: Record<string, Record<string, string>> = Object.create(null);
  for (const dictionary of dictionaries) {
    for (const [language, values] of Object.entries(dictionary)) {
      const locale = (result[language] ??= Object.create(null) as Record<
        string,
        string
      >);
      for (const [key, value] of Object.entries(values)) {
        if (Object.hasOwn(locale, key) && locale[key] !== value) {
          throw appError("config.invalid", {
            details: {
              issues: [
                {
                  path: key,
                  messageKey: "config.locale_conflict",
                  params: { language },
                },
              ],
            },
          });
        }
        locale[key] = value;
      }
    }
  }
  return result;
}

export async function createLocalizer(additions?: Dictionaries) {
  const merged = mergeLocales(locales, additions ?? {});
  const instance = i18next.createInstance();
  await instance.init({
    resources: Object.fromEntries(
      Object.entries(merged).map(([language, translation]) => [
        language,
        { translation },
      ]),
    ),
    fallbackLng: "en",
    keySeparator: false,
    nsSeparator: false,
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const translate = (
    locale: string,
    key: string,
    params?: Readonly<Record<string, string | number | boolean>>,
  ) => instance.getFixedT(locale, "translation")(key, params ?? {});
  return Object.assign(translate, {
    languages: Object.freeze(Object.keys(merged)),
  });
}
