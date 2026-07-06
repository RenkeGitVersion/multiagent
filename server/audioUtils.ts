import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempDir = join(projectRoot, ".tmp-audio");

export async function convertUploadedAudioToWav(input: {
  audioBuffer: Buffer;
  mimeType: string;
  maxSeconds: number;
}): Promise<{
  wavPath: string;
  cleanup: () => Promise<void>;
}> {
  const id = randomUUID();
  const inputPath = join(tempDir, `${id}${extensionForMime(input.mimeType)}`);
  const wavPath = join(tempDir, `${id}.wav`);

  await mkdir(tempDir, { recursive: true });
  await writeFile(inputPath, input.audioBuffer);
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-ac",
    "1",
    "-ar",
    "16000",
    "-t",
    String(input.maxSeconds),
    wavPath
  ]);

  return {
    wavPath,
    cleanup: async () => {
      await Promise.all([
        rm(inputPath, { force: true }),
        rm(wavPath, { force: true })
      ]);
    }
  };
}

export function extensionForMime(mimeType: string): string {
  if (mimeType.includes("mp4")) return ".mp4";
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("wav")) return ".wav";
  return ".webm";
}
