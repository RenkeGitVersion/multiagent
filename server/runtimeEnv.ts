import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(projectRoot, ".env");

function readEnvFile(): Record<string, string> {
  try {
    if (!existsSync(envPath)) return {};
    return parse(readFileSync(envPath, "utf8"));
  } catch {
    return {};
  }
}

export function getRuntimeEnv(key: string): string | undefined {
  const fileEnv = readEnvFile()[key];
  if (typeof fileEnv === "string" && fileEnv.length > 0) return fileEnv;
  const processValue = process.env[key];
  return typeof processValue === "string" && processValue.length > 0 ? processValue : undefined;
}

export function hasRuntimeEnv(key: string): boolean {
  return Boolean(getRuntimeEnv(key));
}
