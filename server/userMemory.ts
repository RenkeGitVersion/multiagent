import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FamilyRole, SpeakerIdentity, UserMemorySnapshot } from "../shared/types";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(projectRoot, "server", ".data");
const storePath = join(dataDir, "user-memory.json");

interface MemoryFact {
  id: string;
  text: string;
  source: "explicit" | "conversation" | "task";
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

interface MemoryPreference {
  key: string;
  value: string;
  confidence: number;
  updatedAt: string;
}

interface UserMemoryRecord {
  userId: string;
  familyRole: FamilyRole;
  displayName?: string;
  facts: MemoryFact[];
  preferences: MemoryPreference[];
  recentSummaries: Array<{
    id: string;
    text: string;
    createdAt: string;
  }>;
}

interface UserMemoryFile {
  records: UserMemoryRecord[];
}

interface MemoryCandidate {
  kind: "fact" | "preference";
  text: string;
  key?: string;
  value?: string;
  confidence: number;
}

export class UserMemory {
  async getSnapshot(userId: string): Promise<UserMemorySnapshot> {
    const record = await this.getRecord(userId);
    return this.toSnapshot(record);
  }

  async formatForPrompt(userId: string): Promise<string> {
    const snapshot = await this.getSnapshot(userId);
    const lines = [
      `家庭角色：${familyRoleLabel(snapshot.familyRole)}`,
      ...(snapshot.displayName ? [`称呼：${snapshot.displayName}`] : []),
      ...snapshot.preferences.map((item) => `偏好：${item.key} = ${item.value}`),
      ...snapshot.facts.map((item) => `事实：${item.text}`)
    ];
    return lines.length > 0 ? lines.join("\n") : "";
  }

  extractMemoryCandidate(queryText: string): MemoryCandidate | undefined {
    const text = queryText.trim();
    if (!/(记住|以后|我喜欢|我不喜欢|叫我)/.test(text)) return undefined;
    if (/(病历|身份证|银行卡|密码|手机号|住址)/.test(text) && !/记住/.test(text)) return undefined;

    const nicknameMatch = text.match(/(?:以后)?(?:叫我|称呼我)([^，。！？\s]+)/);
    if (nicknameMatch?.[1]) {
      return {
        kind: "preference",
        key: "称呼",
        value: nicknameMatch[1].trim(),
        text: `用户希望被称呼为 ${nicknameMatch[1].trim()}`,
        confidence: 0.95
      };
    }

    const likeMatch = text.match(/我(喜欢|不喜欢)([^，。！？]+)/);
    if (likeMatch?.[2]) {
      const key = likeMatch[1] === "喜欢" ? "喜欢" : "不喜欢";
      const value = likeMatch[2].trim();
      return {
        kind: "preference",
        key,
        value,
        text: `用户${key}${value}`,
        confidence: 0.9
      };
    }

    const rememberMatch = text.match(/记住(?:一下)?(.+)/);
    if (rememberMatch?.[1]) {
      return {
        kind: "fact",
        text: rememberMatch[1].trim().replace(/[。！!？?]$/, ""),
        confidence: 0.88
      };
    }

    const futureMatch = text.match(/以后(.+)/);
    if (futureMatch?.[1]) {
      return {
        kind: "fact",
        text: `以后${futureMatch[1].trim().replace(/[。！!？?]$/, "")}`,
        confidence: 0.82
      };
    }

    return undefined;
  }

  async writeIfAllowed(input: {
    userId?: string;
    familyRole?: FamilyRole;
    displayName?: string;
    queryText: string;
    speakerIdentity?: SpeakerIdentity;
    memoryOptOut?: boolean;
  }): Promise<UserMemorySnapshot | undefined> {
    if (!input.userId || input.memoryOptOut) return undefined;
    if (!input.speakerIdentity || !["verified", "identified"].includes(input.speakerIdentity.source)) return undefined;
    if (input.speakerIdentity.confidence < envNumber("MEMORY_WRITE_MIN_CONFIDENCE", 0.82)) return undefined;
    if (input.speakerIdentity.quality && !input.speakerIdentity.quality.ok) return undefined;

    const candidate = this.extractMemoryCandidate(input.queryText);
    if (!candidate) return this.getSnapshot(input.userId);

    const data = await this.read();
    const record = getOrCreateRecord(data, input.userId);
    const now = new Date().toISOString();
    if (input.familyRole) record.familyRole = input.familyRole;
    if (input.displayName?.trim()) record.displayName = input.displayName.trim();

    if (candidate.kind === "preference" && candidate.key && candidate.value) {
      const existing = record.preferences.find((item) => item.key === candidate.key);
      if (existing) {
        existing.value = candidate.value;
        existing.confidence = candidate.confidence;
        existing.updatedAt = now;
      } else {
        record.preferences.push({
          key: candidate.key,
          value: candidate.value,
          confidence: candidate.confidence,
          updatedAt: now
        });
      }
    } else {
      record.facts.push({
        id: randomUUID(),
        text: candidate.text,
        source: "explicit",
        confidence: candidate.confidence,
        createdAt: now,
        updatedAt: now
      });
      record.facts = record.facts.slice(-30);
    }

    await this.write(data);
    return this.toSnapshot(record);
  }

  async clear(userId: string): Promise<UserMemorySnapshot> {
    const data = await this.read();
    const existing = data.records.find((record) => record.userId === userId);
    if (existing) {
      existing.facts = [];
      existing.preferences = [];
      existing.recentSummaries = [];
    } else {
      data.records.push(createRecord(userId));
    }
    await this.write(data);
    return this.getSnapshot(userId);
  }

  private async getRecord(userId: string): Promise<UserMemoryRecord> {
    const data = await this.read();
    return getOrCreateRecord(data, userId);
  }

  private toSnapshot(record: UserMemoryRecord): UserMemorySnapshot {
    return {
      userId: record.userId,
      familyRole: record.familyRole,
      displayName: record.displayName,
      facts: record.facts.map((item) => ({
        id: item.id,
        text: item.text,
        confidence: item.confidence,
        updatedAt: item.updatedAt
      })),
      preferences: record.preferences.map((item) => ({
        key: item.key,
        value: item.value,
        confidence: item.confidence,
        updatedAt: item.updatedAt
      }))
    };
  }

  private async read(): Promise<UserMemoryFile> {
    try {
      const raw = await readFile(storePath, "utf8");
      const parsed = JSON.parse(raw) as UserMemoryFile;
      return { records: parsed.records ?? [] };
    } catch {
      return { records: [] };
    }
  }

  private async write(data: UserMemoryFile): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    await writeFile(storePath, JSON.stringify(data, null, 2), "utf8");
  }
}

function getOrCreateRecord(data: UserMemoryFile, userId: string): UserMemoryRecord {
  let record = data.records.find((item) => item.userId === userId);
  if (!record) {
    record = createRecord(userId);
    data.records.push(record);
  }
  return record;
}

function createRecord(userId: string): UserMemoryRecord {
  return {
    userId,
    familyRole: "unknown",
    facts: [],
    preferences: [],
    recentSummaries: []
  };
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function familyRoleLabel(role: FamilyRole): string {
  const labels: Record<FamilyRole, string> = {
    father: "爸爸",
    mother: "妈妈",
    child: "孩子",
    elder: "长辈",
    guest: "访客",
    unknown: "未知"
  };
  return labels[role];
}
