import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { errno, failure } from "./failure.js";

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
      throw failure("secret.unavailable", {
        reference: String(ref),
        reason: "invalid_reference",
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
      throw failure(
        "secret.unavailable",
        { reference: ref, reason: errno(error) ?? "read_failed" },
        error,
      );
    }
    if (!value)
      throw failure("secret.unavailable", {
        reference: ref,
        reason: value === undefined ? "missing" : "empty",
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
