import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FamilyRole, SpeakerIdentity, SpeakerRegisterResponse, SpeakerUserSummary, VoiceQuality } from "../shared/types";
import type { SpeakerEmbeddingResult } from "./speakerRecognition";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(projectRoot, "server", ".data");
const storePath = join(dataDir, "speaker-profiles.json");

interface SpeakerSample {
  id: string;
  embedding: number[];
  quality: VoiceQuality;
  distanceToCentroid?: number;
  createdAt: string;
}

interface SpeakerProfile {
  userId: string;
  displayName?: string;
  familyRole: FamilyRole;
  centroid: number[];
  sampleCount: number;
  embeddingDim: number;
  model: string;
  createdAt: string;
  updatedAt: string;
  enrollmentUtterances: SpeakerSample[];
  status: "active" | "disabled";
  autoImproveVoiceprint: boolean;
}

interface SpeakerStoreFile {
  profiles: SpeakerProfile[];
}

export interface SpeakerResolveInput {
  embeddingResult: SpeakerEmbeddingResult;
  claimedUserId?: string;
  assistantPlaybackRecentlyEnded?: boolean;
}

export class SpeakerStore {
  async listUsers(): Promise<SpeakerUserSummary[]> {
    const data = await this.read();
    return data.profiles.map((profile) => this.toSummary(profile));
  }

  async registerSample(input: {
    userId?: string;
    displayName?: string;
    familyRole?: FamilyRole;
    embeddingResult: SpeakerEmbeddingResult;
  }): Promise<SpeakerRegisterResponse> {
    const data = await this.read();
    const now = new Date().toISOString();
    const userId = sanitizeUserId(input.userId) || `user_${randomUUID().slice(0, 8)}`;
    const quality = input.embeddingResult.quality;

    if (!quality.ok || input.embeddingResult.embedding.length === 0) {
      return {
        userId,
        displayName: input.displayName,
        familyRole: normalizeFamilyRole(input.familyRole),
        sampleCount: data.profiles.find((item) => item.userId === userId)?.sampleCount ?? 0,
        quality,
        centroidReady: false,
        message: `注册样本未通过质量检测：${quality.reasons.join("、") || input.embeddingResult.error || "未知错误"}`
      };
    }

    let profile = data.profiles.find((item) => item.userId === userId);
    if (!profile) {
      profile = {
        userId,
        displayName: input.displayName?.trim() || undefined,
        familyRole: normalizeFamilyRole(input.familyRole),
        centroid: [],
        sampleCount: 0,
        embeddingDim: input.embeddingResult.embeddingDim,
        model: input.embeddingResult.model,
        createdAt: now,
        updatedAt: now,
        enrollmentUtterances: [],
        status: "active",
        autoImproveVoiceprint: true
      };
      data.profiles.push(profile);
    }

    if (input.displayName?.trim()) profile.displayName = input.displayName.trim();
    if (input.familyRole) profile.familyRole = normalizeFamilyRole(input.familyRole);
    const normalized = l2Normalize(input.embeddingResult.embedding);
    const similarityToCentroid = profile.centroid.length > 0 ? cosineSimilarity(normalized, profile.centroid) : 1;
    const minAppendSimilarity = envNumber("SPEAKER_ENROLL_MIN_SIMILARITY", 0.72);

    if (profile.centroid.length > 0 && similarityToCentroid < minAppendSimilarity) {
      return {
        userId,
        displayName: profile.displayName,
        familyRole: profile.familyRole,
        sampleCount: profile.sampleCount,
        quality,
        centroidReady: profile.sampleCount >= 3,
        message: `样本与当前声纹差异较大，未写入：相似度 ${similarityToCentroid.toFixed(3)}`
      };
    }

    profile.enrollmentUtterances.push({
      id: randomUUID(),
      embedding: normalized,
      quality,
      distanceToCentroid: profile.centroid.length > 0 ? 1 - similarityToCentroid : undefined,
      createdAt: now
    });
    profile.centroid = computeCentroid(profile.enrollmentUtterances.map((item) => item.embedding));
    profile.sampleCount = profile.enrollmentUtterances.length;
    profile.embeddingDim = normalized.length;
    profile.model = input.embeddingResult.model;
    profile.updatedAt = now;
    profile.status = "active";

    await this.write(data);
    return {
      userId,
      displayName: profile.displayName,
      familyRole: profile.familyRole,
      sampleCount: profile.sampleCount,
      quality,
      centroidReady: profile.sampleCount >= 3,
      message: profile.sampleCount >= 3 ? "声纹注册样本已写入，centroid 已可用" : `样本已写入，还需要 ${3 - profile.sampleCount} 段有效语音`
    };
  }

  async verify(userId: string, embeddingResult: SpeakerEmbeddingResult): Promise<SpeakerIdentity> {
    const data = await this.read();
    const profile = data.profiles.find((item) => item.userId === userId && item.status === "active");
    if (!profile || profile.centroid.length === 0 || profile.sampleCount < 3) {
      return this.unknown(embeddingResult.quality, "指定用户不存在或声纹尚未注册完成");
    }
    if (!embeddingResult.quality.ok || embeddingResult.embedding.length === 0) {
      return this.failed(embeddingResult.quality, embeddingResult.error ?? "音频质量未通过");
    }
    const similarity = cosineSimilarity(l2Normalize(embeddingResult.embedding), profile.centroid);
    const threshold = envNumber("SPEAKER_VERIFY_MIN_SIMILARITY", 0.72);
    const verified = similarity >= threshold;
    return {
      userId: verified ? profile.userId : undefined,
      displayName: verified ? profile.displayName : undefined,
      familyRole: verified ? profile.familyRole : undefined,
      source: verified ? "verified" : "unknown",
      confidence: similarity,
      similarity,
      quality: embeddingResult.quality,
      reason: verified ? "指定用户声纹验证通过" : `声纹相似度低于验证阈值 ${threshold}`
    };
  }

  async identify(embeddingResult: SpeakerEmbeddingResult): Promise<SpeakerIdentity> {
    const data = await this.read();
    if (!embeddingResult.quality.ok || embeddingResult.embedding.length === 0) {
      return this.failed(embeddingResult.quality, embeddingResult.error ?? "音频质量未通过");
    }
    const candidates = data.profiles
      .filter((profile) => profile.status === "active" && profile.centroid.length > 0 && profile.sampleCount >= 3)
      .map((profile) => ({
        profile,
        similarity: cosineSimilarity(l2Normalize(embeddingResult.embedding), profile.centroid)
      }))
      .sort((a, b) => b.similarity - a.similarity);

    if (candidates.length === 0) {
      return this.unknown(embeddingResult.quality, "暂无可识别的已注册声纹");
    }

    const best = candidates[0];
    const second = candidates[1];
    const threshold = envNumber("SPEAKER_IDENTIFY_MIN_SIMILARITY", 0.76);
    const marginThreshold = envNumber("SPEAKER_IDENTIFY_MIN_MARGIN", 0.05);
    const secondBestSimilarity = second?.similarity ?? 0;
    const margin = best.similarity - secondBestSimilarity;

    if (best.similarity < threshold) {
      return {
        source: "unknown",
        confidence: best.similarity,
        similarity: best.similarity,
        secondBestSimilarity,
        margin,
        quality: embeddingResult.quality,
        reason: `最高相似度低于识别阈值 ${threshold}`
      };
    }
    if (second && margin < marginThreshold) {
      return {
        source: "unknown",
        confidence: best.similarity,
        similarity: best.similarity,
        secondBestSimilarity,
        margin,
        quality: embeddingResult.quality,
        reason: `候选用户差距低于 margin 阈值 ${marginThreshold}`
      };
    }

    return {
      userId: best.profile.userId,
      displayName: best.profile.displayName,
      familyRole: best.profile.familyRole,
      source: "identified",
      confidence: best.similarity,
      similarity: best.similarity,
      secondBestSimilarity,
      margin,
      quality: embeddingResult.quality,
      reason: "已从声纹库识别当前说话人"
    };
  }

  async resolve(input: SpeakerResolveInput): Promise<SpeakerIdentity> {
    const identity = input.claimedUserId
      ? await this.verify(input.claimedUserId, input.embeddingResult)
      : await this.identify(input.embeddingResult);

    if (identity.source === "verified" && !input.assistantPlaybackRecentlyEnded) {
      await this.maybeUpdateCentroid({
        userId: identity.userId,
        embeddingResult: input.embeddingResult,
        similarity: identity.similarity ?? identity.confidence
      });
    }
    return identity;
  }

  async maybeUpdateCentroid(input: {
    userId?: string;
    embeddingResult: SpeakerEmbeddingResult;
    similarity: number;
  }): Promise<void> {
    if (!input.userId) return;
    if (!input.embeddingResult.quality.ok || input.embeddingResult.embedding.length === 0) return;
    if (input.similarity < envNumber("SPEAKER_AUTO_UPDATE_MIN_SIMILARITY", 0.84)) return;

    const data = await this.read();
    const profile = data.profiles.find((item) => item.userId === input.userId && item.status === "active");
    if (!profile?.autoImproveVoiceprint) return;

    const embedding = l2Normalize(input.embeddingResult.embedding);
    profile.enrollmentUtterances.push({
      id: randomUUID(),
      embedding,
      quality: input.embeddingResult.quality,
      distanceToCentroid: 1 - input.similarity,
      createdAt: new Date().toISOString()
    });
    profile.enrollmentUtterances = profile.enrollmentUtterances.slice(-20);
    profile.centroid = computeCentroid(profile.enrollmentUtterances.map((item) => item.embedding));
    profile.sampleCount = profile.enrollmentUtterances.length;
    profile.updatedAt = new Date().toISOString();
    await this.write(data);
  }

  async setAutoImprove(userId: string, enabled: boolean): Promise<SpeakerUserSummary | undefined> {
    const data = await this.read();
    const profile = data.profiles.find((item) => item.userId === userId);
    if (!profile) return undefined;
    profile.autoImproveVoiceprint = enabled;
    profile.updatedAt = new Date().toISOString();
    await this.write(data);
    return this.toSummary(profile);
  }

  async disableUser(userId: string): Promise<SpeakerUserSummary | undefined> {
    const data = await this.read();
    const profile = data.profiles.find((item) => item.userId === userId);
    if (!profile) return undefined;
    profile.status = "disabled";
    profile.updatedAt = new Date().toISOString();
    await this.write(data);
    return this.toSummary(profile);
  }

  private unknown(quality: VoiceQuality, reason: string): SpeakerIdentity {
    return { source: "unknown", confidence: 0, quality, reason };
  }

  private failed(quality: VoiceQuality, reason: string): SpeakerIdentity {
    return { source: "failed", confidence: 0, quality, reason };
  }

  private toSummary(profile: SpeakerProfile): SpeakerUserSummary {
    return {
      userId: profile.userId,
      displayName: profile.displayName,
      familyRole: profile.familyRole,
      sampleCount: profile.sampleCount,
      centroidReady: profile.sampleCount >= 3 && profile.centroid.length > 0,
      status: profile.status,
      autoImproveVoiceprint: profile.autoImproveVoiceprint,
      updatedAt: profile.updatedAt
    };
  }

  private async read(): Promise<SpeakerStoreFile> {
    try {
      const raw = await readFile(storePath, "utf8");
      const parsed = JSON.parse(raw) as SpeakerStoreFile;
      return {
        profiles: (parsed.profiles ?? []).map((profile) => ({
          ...profile,
          familyRole: normalizeFamilyRole(profile.familyRole)
        }))
      };
    } catch {
      return { profiles: [] };
    }
  }

  private async write(data: SpeakerStoreFile): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    await writeFile(storePath, JSON.stringify(data, null, 2), "utf8");
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  const dim = embeddings[0].length;
  const mean = Array.from({ length: dim }, (_, index) => (
    embeddings.reduce((sum, embedding) => sum + (embedding[index] ?? 0), 0) / embeddings.length
  ));
  return l2Normalize(mean);
}

export function l2Normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (norm <= 0) return values;
  return values.map((value) => value / norm);
}

function sanitizeUserId(userId?: string): string | undefined {
  const safe = userId?.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return safe || undefined;
}

function normalizeFamilyRole(role?: FamilyRole): FamilyRole {
  return role && ["father", "mother", "child", "elder", "guest", "unknown"].includes(role) ? role : "unknown";
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
