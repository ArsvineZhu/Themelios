import { appError, errorCode } from "@themelios/core";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export type CredentialRef = `env:${string}` | `file:${string}`;
export const credentialSchema = z
  .string()
  .regex(/^(?:env:[a-zA-Z_][a-zA-Z0-9_]*|file:.+)$/)
  .refine(
    (value) => !value.includes(String.fromCharCode(0)),
  ) as z.ZodType<CredentialRef>;

export interface Secrets {
  resolve(ref: CredentialRef): Promise<string>;
  available(ref: CredentialRef): Promise<boolean>;
}

export function createSecrets(options: { baseDir: string }): Secrets {
  const baseDir = resolve(options.baseDir);
  const read = async (ref: CredentialRef): Promise<string> => {
    if (!credentialSchema.safeParse(ref).success) {
      throw appError("secret.unavailable", {
        details: {
          reference: String(ref),
          reason: "invalid_reference",
        },
      });
    }
    let value: string | undefined;
    try {
      value = ref.startsWith("env:")
        ? process.env[ref.slice(4)]
        : (await readFile(resolve(baseDir, ref.slice(5)), "utf8")).replace(
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
