import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const mutationQueues = new Map<string, Promise<void>>();

export async function readJsonFile<T>(filePath: string, createEmpty: () => T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmpty();
    }
    throw error;
  }
  return JSON.parse(raw) as T;
}

export async function writeJsonFileAtomic(filePath: string, data: unknown): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );

  try {
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function serializeFileMutation<T>(
  filePath: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = mutationQueues.get(filePath) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  mutationQueues.set(filePath, settled);
  void settled.then(() => {
    if (mutationQueues.get(filePath) === settled) {
      mutationQueues.delete(filePath);
    }
  });
  return result;
}
