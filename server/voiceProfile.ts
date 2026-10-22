import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import type { VoiceProfileResult } from "../shared/types";
import { convertUploadedAudioToWav } from "./audioUtils";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pythonPath = join(projectRoot, ".venv-age", "bin", "python");
const scriptPath = join(projectRoot, "tools", "profile_voice.py");
const workerPath = join(projectRoot, "tools", "profile_voice_worker.py");
const defaultModelPath = "/Users/renke/.cache/huggingface/hub/models--audeering--wav2vec2-large-robust-6-ft-age-gender/snapshots/a681b720dafd12b9dd7b6d13fb437c7b6b197fd3";
const profileSeconds = process.env.VOICE_PROFILE_SECONDS ?? "3.0";

type WorkerResult = {
  ageYears: number;
  ageGroup: VoiceProfileResult["ageGroup"];
  gender: VoiceProfileResult["gender"] | "child";
  genderConfidence: number;
  inferenceSeconds: number;
  totalSeconds: number;
};

type PendingRequest = {
  resolve: (value: WorkerResult) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
};

let worker: ChildProcessWithoutNullStreams | undefined;
let workerReady: Promise<void> | undefined;
let workerBuffer = "";
const pending = new Map<string, PendingRequest>();

export async function analyzeVoiceProfile(audioBuffer: Buffer, mimeType: string): Promise<VoiceProfileResult> {
  const startedAt = Date.now();
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const converted = await convertUploadedAudioToWav({ audioBuffer, mimeType, maxSeconds: 3 });
    cleanup = converted.cleanup;

    const parsed = await analyzeWithWorker(converted.wavPath).catch(() => analyzeWithOneShot(converted.wavPath));

    return {
      ageYears: parsed.ageYears,
      ageGroup: parsed.ageGroup,
      gender: normalizeGender(parsed),
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

async function analyzeWithOneShot(wavPath: string): Promise<WorkerResult> {
  const { stdout } = await execFileAsync(pythonPath, [
    scriptPath,
    wavPath,
    "--seconds",
    profileSeconds,
    "--model-path",
    process.env.VOICE_PROFILE_MODEL_PATH ?? defaultModelPath
  ], {
    maxBuffer: 1024 * 1024 * 4,
    env: workerEnv()
  });

  return JSON.parse(stdout) as WorkerResult;
}

async function analyzeWithWorker(wavPath: string): Promise<WorkerResult> {
  await ensureWorker();
  if (!worker) throw new Error("Voice profile worker is not available");
  const id = randomUUID();
  const timeoutMs = Number(process.env.VOICE_PROFILE_SERVICE_TIMEOUT_MS ?? process.env.VOICE_PROFILE_TIMEOUT_MS ?? 30_000);
  const result = new Promise<WorkerResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Voice profile worker timed out"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
  worker.stdin.write(JSON.stringify({ id, audio: wavPath, seconds: Number(profileSeconds) }) + "\n");
  return result;
}

async function ensureWorker(): Promise<void> {
  if (worker && !worker.killed && workerReady) return workerReady;
  worker = spawn(pythonPath, [workerPath], {
    env: workerEnv(),
    stdio: "pipe"
  });
  workerBuffer = "";
  workerReady = new Promise((resolve, reject) => {
    const readyTimer = setTimeout(
      () => reject(new Error("Voice profile worker startup timed out")),
      Number(process.env.VOICE_PROFILE_SERVICE_STARTUP_TIMEOUT_MS ?? 60_000)
    );
    worker?.stdout.on("data", (chunk: Buffer) => {
      workerBuffer += chunk.toString("utf8");
      let lineEnd = workerBuffer.indexOf("\n");
      while (lineEnd >= 0) {
        const line = workerBuffer.slice(0, lineEnd).trim();
        workerBuffer = workerBuffer.slice(lineEnd + 1);
        handleWorkerLine(line, resolve, readyTimer);
        lineEnd = workerBuffer.indexOf("\n");
      }
    });
    worker?.once("error", reject);
    worker?.once("exit", () => {
      worker = undefined;
      workerReady = undefined;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Voice profile worker exited"));
      }
      pending.clear();
    });
  });
  return workerReady;
}

function handleWorkerLine(line: string, resolveReady: () => void, readyTimer: NodeJS.Timeout) {
  if (!line) return;
  const payload = JSON.parse(line) as { type?: string; id?: string; ok?: boolean; result?: WorkerResult; error?: string };
  if (payload.type === "ready") {
    clearTimeout(readyTimer);
    resolveReady();
    return;
  }
  if (!payload.id) return;
  const request = pending.get(payload.id);
  if (!request) return;
  pending.delete(payload.id);
  clearTimeout(request.timer);
  if (payload.ok && payload.result) {
    request.resolve(payload.result);
  } else {
    request.reject(new Error(payload.error ?? "Voice profile worker failed"));
  }
}

function workerEnv() {
  return {
    ...process.env,
    VOICE_PROFILE_MODEL_PATH: process.env.VOICE_PROFILE_MODEL_PATH ?? defaultModelPath,
    HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? "1",
    TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE ?? "1"
  };
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes("mp4")) return ".mp4";
  if (mimeType.includes("ogg")) return ".ogg";
  if (mimeType.includes("wav")) return ".wav";
  return ".webm";
}

function normalizeGender(parsed: WorkerResult): VoiceProfileResult["gender"] {
  const minConfidence = Number(process.env.VOICE_PROFILE_MIN_GENDER_CONFIDENCE ?? 0.68);
  if (parsed.gender === "child" || parsed.genderConfidence < minConfidence) return "unknown";
  return parsed.gender;
}
