import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { VoiceQuality } from "../shared/types";
import { convertUploadedAudioToWav } from "./audioUtils";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultPythonPath = join(projectRoot, ".venv-speaker", "bin", "python");
const scriptPath = join(projectRoot, "tools", "speaker_embed.py");

export interface SpeakerEmbeddingResult {
  source: "speaker" | "failed";
  model: string;
  embeddingDim: number;
  embedding: number[];
  quality: VoiceQuality;
  inferenceSeconds: number;
  totalSeconds: number;
  error?: string;
}

export async function extractSpeakerEmbedding(audioBuffer: Buffer, mimeType: string): Promise<SpeakerEmbeddingResult> {
  const startedAt = Date.now();
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const converted = await convertUploadedAudioToWav({
      audioBuffer,
      mimeType,
      maxSeconds: Number(process.env.SPEAKER_MAX_DURATION_SECONDS ?? 8)
    });
    cleanup = converted.cleanup;

    const pythonPath = process.env.SPEAKER_PYTHON_PATH ?? defaultPythonPath;
    const modelPath = process.env.SPEAKER_MODEL_PATH ?? "speechbrain/spkrec-ecapa-voxceleb";
    const { stdout } = await execFileAsync(pythonPath, [
      scriptPath,
      converted.wavPath,
      "--model-path",
      modelPath
    ], {
      maxBuffer: 1024 * 1024 * 16,
      env: {
        ...process.env,
        SPEAKER_MODEL_PATH: modelPath
      }
    });

    return normalizeEmbeddingResult(JSON.parse(stdout) as Partial<SpeakerEmbeddingResult>, startedAt);
  } catch (error) {
    return failedEmbeddingResult(error instanceof Error ? error.message : "Unknown speaker embedding error", startedAt);
  } finally {
    await cleanup?.();
  }
}

function normalizeEmbeddingResult(result: Partial<SpeakerEmbeddingResult>, startedAt: number): SpeakerEmbeddingResult {
  return {
    source: result.source === "speaker" ? "speaker" : "failed",
    model: result.model ?? process.env.SPEAKER_MODEL_PATH ?? "speechbrain/spkrec-ecapa-voxceleb",
    embeddingDim: Number(result.embeddingDim ?? 0),
    embedding: Array.isArray(result.embedding) ? result.embedding.map(Number) : [],
    quality: result.quality ?? defaultFailedQuality(["model_failed"]),
    inferenceSeconds: Number(result.inferenceSeconds ?? 0),
    totalSeconds: Number(result.totalSeconds ?? ((Date.now() - startedAt) / 1000).toFixed(3)),
    error: result.error
  };
}

function failedEmbeddingResult(error: string, startedAt: number): SpeakerEmbeddingResult {
  return {
    source: "failed",
    model: process.env.SPEAKER_MODEL_PATH ?? "speechbrain/spkrec-ecapa-voxceleb",
    embeddingDim: 0,
    embedding: [],
    quality: defaultFailedQuality(["model_failed"]),
    inferenceSeconds: 0,
    totalSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
    error
  };
}

function defaultFailedQuality(reasons: string[]): VoiceQuality {
  return {
    ok: false,
    durationSeconds: 0,
    speechSeconds: 0,
    rms: 0,
    peak: 0,
    clippingRatio: 0,
    silenceRatio: 1,
    reasons
  };
}
