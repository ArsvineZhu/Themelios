import { appError, errorCode } from "@themelios/core";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const environmentPrefix = "env:";
const filePrefix = "file:";
export const credentialSchema = z
  .union([
    z.templateLiteral([
      environmentPrefix,
      z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
    ]),
    z.templateLiteral([filePrefix, z.string().regex(/^[^\r\n\u2028\u2029]+$/)]),
  ])
  .refine((value) => !value.includes("\0"));
export type CredentialRef = z.output<typeof credentialSchema>;

/** Resolves a credential reference relative to the configuration file that declared it. */
export function resolveCredentialReference(
  ref: CredentialRef,
  baseDir: string,
): CredentialRef {
  return ref.startsWith(filePrefix)
    ? `${filePrefix}${resolve(baseDir, ref.slice(filePrefix.length))}`
    : ref;
}

export interface Secrets {
  resolve(ref: CredentialRef): Promise<string>;
  available(ref: CredentialRef): Promise<boolean>;
}

export function createSecrets(options: { baseDir: string }): Secrets {
  const baseDir = resolve(options.baseDir);
  const read = async (ref: CredentialRef): Promise<string> => {
    const parsed = credentialSchema.safeParse(ref);
    if (!parsed.success) {
      throw appError("secret.unavailable", {
        details: {
          reference: String(ref),
          reason: "invalid_reference",
        },
      });
    }
    const canonical = resolveCredentialReference(parsed.data, baseDir);
    let value: string | undefined;
    try {
      value = canonical.startsWith(environmentPrefix)
        ? process.env[canonical.slice(environmentPrefix.length)]
        : (await readFile(canonical.slice(filePrefix.length), "utf8")).replace(
            /\r?\n$/,
            "",
          );
    } catch (error) {
      throw appError("secret.unavailable", {
        details: { reference: ref, reason: errorCode(error) ?? "read_failed" },
        cause: error,
      });
    }
    if (!value)
      throw appError("secret.unavailable", {
        details: {
          reference: ref,
          reason: value === undefined ? "missing" : "empty",
        },
      });
    return value;
  };
  return {
    resolve: read,
    async available(ref) {
      try {
        await read(ref);
        return true;
      } catch {
        return false;
      }
    },
  };
}
