import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VoiceProfileResult } from "../shared/types";
import { convertUploadedAudioToWav } from "./audioUtils";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pythonPath = join(projectRoot, ".venv-age", "bin", "python");
const scriptPath = join(projectRoot, "tools", "profile_voice.py");
const defaultModelPath = "/Users/renke/.cache/huggingface/hub/models--audeering--wav2vec2-large-robust-6-ft-age-gender/snapshots/a681b720dafd12b9dd7b6d13fb437c7b6b197fd3";

export async function analyzeVoiceProfile(audioBuffer: Buffer, mimeType: string): Promise<VoiceProfileResult> {
  const startedAt = Date.now();
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const converted = await convertUploadedAudioToWav({ audioBuffer, mimeType, maxSeconds: 4 });
    cleanup = converted.cleanup;

    const { stdout } = await execFileAsync(pythonPath, [
      scriptPath,
      converted.wavPath,
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
    await cleanup?.();
  }
}
