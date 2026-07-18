import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { createInterface, type Interface } from "node:readline";
import type { VoiceProfileResult } from "../shared/types";
import { convertUploadedAudioToWav } from "./audioUtils";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pythonPath = join(projectRoot, ".venv-age", "bin", "python");
const scriptPath = join(projectRoot, "tools", "profile_voice.py");
const defaultModelPath = "/Users/renke/.cache/huggingface/hub/models--audeering--wav2vec2-large-robust-6-ft-age-gender/snapshots/a681b720dafd12b9dd7b6d13fb437c7b6b197fd3";
const profileSeconds = Number(process.env.VOICE_PROFILE_SECONDS ?? 1.5);
const modelPath = process.env.VOICE_PROFILE_MODEL_PATH ?? defaultModelPath;

interface PythonProfilePayload {
  ageYears: number;
  ageGroup: VoiceProfileResult["ageGroup"];
  gender: VoiceProfileResult["gender"] | "child";
  genderConfidence: number;
  inferenceSeconds: number;
  totalSeconds: number;
}

interface PendingProfileRequest {
  resolve: (payload: PythonProfilePayload) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export async function analyzeVoiceProfile(audioBuffer: Buffer, mimeType: string): Promise<VoiceProfileResult> {
  const startedAt = Date.now();
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const converted = await convertUploadedAudioToWav({ audioBuffer, mimeType, maxSeconds: 3 });
    cleanup = converted.cleanup;

    const parsed = await analyzeWithPersistentService(converted.wavPath);
    return toVoiceProfileResult(parsed, startedAt);
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

async function analyzeWithPersistentService(wavPath: string): Promise<PythonProfilePayload> {
  if (process.env.VOICE_PROFILE_USE_SERVICE === "false") {
    return analyzeWithOneShotProcess(wavPath);
  }

  try {
    return await VoiceProfilePythonService.instance().analyze(wavPath);
  } catch {
    return analyzeWithOneShotProcess(wavPath);
  }
}

async function analyzeWithOneShotProcess(wavPath: string): Promise<PythonProfilePayload> {
  const { stdout } = await execFileAsync(pythonPath, [
    scriptPath,
    wavPath,
    "--seconds",
    String(profileSeconds),
    "--model-path",
    modelPath
  ], {
    maxBuffer: 1024 * 1024 * 4,
    env: profileEnv()
  });
  return JSON.parse(stdout) as PythonProfilePayload;
}

function toVoiceProfileResult(parsed: PythonProfilePayload, startedAt: number): VoiceProfileResult {
  return {
    ageYears: parsed.ageYears,
    ageGroup: parsed.ageGroup,
    gender: parsed.gender === "child" ? "unknown" : parsed.gender,
    genderConfidence: parsed.genderConfidence,
    inferenceSeconds: parsed.inferenceSeconds,
    totalSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
    source: "voice"
  };
}

class VoiceProfilePythonService {
  private static service: VoiceProfilePythonService | undefined;
  private process?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private ready?: Promise<void>;
  private pending = new Map<string, PendingProfileRequest>();
  private stderrTail = "";
  private counter = 0;

  static instance(): VoiceProfilePythonService {
    this.service ??= new VoiceProfilePythonService();
    return this.service;
  }

  async analyze(wavPath: string): Promise<PythonProfilePayload> {
    await this.ensureStarted();
    const child = this.process;
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error("Voice profile service is not writable");
    }

    const id = `voice-${Date.now()}-${++this.counter}`;
    const timeoutMs = Number(process.env.VOICE_PROFILE_SERVICE_TIMEOUT_MS ?? 30_000);
    const request = new Promise<PythonProfilePayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Voice profile service timeout. ${this.stderrTail}`.trim()));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });

    child.stdin.write(JSON.stringify({ id, audio: wavPath, seconds: profileSeconds }) + "\n");
    return request;
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && !this.process.killed && this.ready) {
      await this.ready;
      return;
    }

    this.process = spawn(pythonPath, [
      scriptPath,
      "--serve",
      "--seconds",
      String(profileSeconds),
      "--model-path",
      modelPath
    ], {
      env: profileEnv(),
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    this.process.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000);
    });
    this.process.on("exit", () => this.rejectAll(new Error(`Voice profile service exited. ${this.stderrTail}`.trim())));
    this.process.on("error", (error) => this.rejectAll(error));

    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Voice profile service startup timeout. ${this.stderrTail}`.trim())), Number(process.env.VOICE_PROFILE_SERVICE_STARTUP_TIMEOUT_MS ?? 60_000));
      const onReady = (line: string) => {
        try {
          const message = JSON.parse(line) as { type?: string; error?: string };
          if (message.type === "ready") {
            clearTimeout(timeout);
            this.lines?.off("line", onReady);
            resolve();
          } else if (message.type === "error") {
            clearTimeout(timeout);
            this.lines?.off("line", onReady);
            reject(new Error(message.error ?? "Voice profile service startup failed"));
          }
        } catch {
          // Ignore non-JSON startup logs.
        }
      };
      this.lines?.on("line", onReady);
      this.process?.once("error", reject);
      this.process?.once("exit", () => reject(new Error(`Voice profile service exited during startup. ${this.stderrTail}`.trim())));
    });

    await this.ready;
  }

  private handleLine(line: string): void {
    let message: PythonProfilePayload & { id?: string; type?: string; error?: string };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const id = message.id;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    if (message.type === "error") {
      pending.reject(new Error(message.error ?? "Voice profile service request failed"));
    } else {
      pending.resolve(message);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.ready = undefined;
    this.lines?.close();
    this.lines = undefined;
    this.process = undefined;
  }
}

function profileEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? "1",
    TRANSFORMERS_OFFLINE: process.env.TRANSFORMERS_OFFLINE ?? "1"
  };
}
