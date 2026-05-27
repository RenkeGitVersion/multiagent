import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VoiceProfileResult } from "../shared/types";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempDir = join(projectRoot, ".tmp-audio");
const pythonPath = join(projectRoot, ".venv-age", "bin", "python");
const scriptPath = join(projectRoot, "tools", "profile_voice.py");
const defaultModelPath = "/Users/renke/.cache/huggingface/hub/models--audeering--wav2vec2-large-robust-6-ft-age-gender/snapshots/a681b720dafd12b9dd7b6d13fb437c7b6b197fd3";

export async function analyzeVoiceProfile(audioBuffer: Buffer, mimeType: string): Promise<VoiceProfileResult> {
  const startedAt = Date.now();
  const id = randomUUID();
  const inputPath = join(tempDir, `${id}${extensionForMime(mimeType)}`);
  const wavPath = join(tempDir, `${id}.wav`);

  try {
    await mkdir(tempDir, { recursive: true });
    await writeFile(inputPath, audioBuffer);
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-t",
      "4",
      wavPath
    ]);

    const { stdout } = await execFileAsync(pythonPath, [
      scriptPath,
      wavPath,
      "--seconds",
      "1.5",
      "--model-path",
      process.env.VOICE_PROFILE_MODEL_PATH ?? defaultModelPath
    ], {
      maxBuffer: 1024 * 1024 * 4,
      env: {
        ...process.env,
        HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? "1",
        TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE ?? "1"
      }
    });

    const parsed = JSON.parse(stdout) as {
      ageYears: number;
      ageGroup: VoiceProfileResult["ageGroup"];
      gender: VoiceProfileResult["gender"] | "child";
      genderConfidence: number;
      inferenceSeconds: number;
      totalSeconds: number;
    };

    return {
      ageYears: parsed.ageYears,
      ageGroup: parsed.ageGroup,
      gender: parsed.gender === "child" ? "unknown" : parsed.gender,
      genderConfidence: parsed.genderConfidence,
      inferenceSeconds: parsed.inferenceSeconds,
      totalSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
      source: "voice"
    };
  } catch (error) {
    return {
      ageYears: 0,
      ageGroup: "adult",
      gender: "unknown",
      genderConfidence: 0,
      inferenceSeconds: 0,
      totalSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
      source: "failed",
      error: error instanceof Error ? error.message : "Unknown voice profile error"
    };
  } finally {
    await Promise.all([
      rm(inputPath, { force: true }),
      rm(wavPath, { force: true })
    ]);
  }
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes("mp4")) return ".mp4";
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("wav")) return ".wav";
  return ".webm";
}
