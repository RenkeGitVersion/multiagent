import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentUsageStat,
  FamilyMemorySnapshot,
  FamilyMemberSummary,
  FamilyRole,
  ReminderHabit,
  ReminderTask,
  SpeakerIdentity,
  TimeSegment
} from "../shared/types";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(projectRoot, "server", ".data");
const storePath = join(dataDir, "family-memory.json");

interface SharedFact {
  id: string;
  text: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

interface FamilyMemberRecord {
  userId: string;
  displayName?: string;
  familyRole: FamilyRole;
  favoriteAgents: AgentUsageStat[];
  memoryCount: number;
  updatedAt: string;
}

interface FamilyMemoryFile {
  familyId: string;
  members: FamilyMemberRecord[];
  sharedFacts: SharedFact[];
  agentUsage: AgentUsageStat[];
  reminderHabits: ReminderHabit[];
}

export class FamilyMemory {
  async getSnapshot(timeSegment: TimeSegment = getCurrentTimeSegment()): Promise<FamilyMemorySnapshot> {
    const data = await this.read();
    return {
      familyId: data.familyId,
      currentTimeSegment: timeSegment,
      members: data.members.map(toMemberSummary),
      sharedFacts: data.sharedFacts.map((item) => ({
        id: item.id,
        text: item.text,
        confidence: item.confidence,
        updatedAt: item.updatedAt
      })),
      agentUsage: data.agentUsage,
      reminderHabits: data.reminderHabits
    };
  }

  async formatForPrompt(userId: string | undefined, timeSegment: TimeSegment): Promise<string> {
    const snapshot = await this.getSnapshot(timeSegment);
    const member = userId ? snapshot.members.find((item) => item.userId === userId) : undefined;
    const lines = [
      `当前时间段：${timeSegmentLabel(timeSegment)}`,
      ...(member ? [`当前家庭成员：${member.displayName ?? member.userId}，角色：${familyRoleLabel(member.familyRole)}`] : []),
      ...snapshot.sharedFacts.map((item) => `家庭事实：${item.text}`),
      ...snapshot.agentUsage.slice(0, 3).map((item) => `家庭常用智能体：${item.agentId} 使用 ${item.count} 次`),
      ...snapshot.reminderHabits.slice(0, 3).map((item) => `提醒习惯：${familyRoleLabel(item.familyRole)} / ${item.audience} / ${timeSegmentLabel(item.timeSegment)} / ${item.message}`)
    ];
    return lines.join("\n");
  }

  async recordAgentUse(input: {
    userId?: string;
    displayName?: string;
    familyRole?: FamilyRole;
    agentId: string;
    memoryCount?: number;
  }): Promise<FamilyMemorySnapshot> {
    const data = await this.read();
    const now = new Date().toISOString();
    incrementAgentUsage(data.agentUsage, input.agentId, now);

    if (input.userId) {
      const member = getOrCreateMember(data, input.userId);
      if (input.displayName?.trim()) member.displayName = input.displayName.trim();
      member.familyRole = input.familyRole ?? member.familyRole;
      member.memoryCount = input.memoryCount ?? member.memoryCount;
      member.updatedAt = now;
      incrementAgentUsage(member.favoriteAgents, input.agentId, now);
    }

    await this.write(data);
    return this.getSnapshot();
  }

  async recordReminderHabit(task: ReminderTask): Promise<void> {
    const data = await this.read();
    const timeSegment = task.timeSegment ?? getTimeSegment(new Date(task.triggerAt));
    const familyRole = task.familyRole ?? "unknown";
    const existing = data.reminderHabits.find((item) =>
      item.userId === task.userId
      && item.familyRole === familyRole
      && item.audience === task.audience
      && item.message === task.message
      && item.timeSegment === timeSegment
    );

    if (existing) {
      existing.count += 1;
      existing.lastTriggeredAt = task.triggerAt;
    } else {
      data.reminderHabits.push({
        id: randomUUID(),
        userId: task.userId,
        familyRole,
        audience: task.audience,
        message: task.message,
        timeSegment,
        agentId: task.reminderAgentId,
        count: 1,
        lastTriggeredAt: task.triggerAt
      });
    }
    data.reminderHabits = data.reminderHabits
      .sort((a, b) => b.lastTriggeredAt.localeCompare(a.lastTriggeredAt))
      .slice(0, 30);
    await this.write(data);
  }

  async writeSharedIfAllowed(input: {
    queryText: string;
    speakerIdentity?: SpeakerIdentity;
    memoryOptOut?: boolean;
  }): Promise<FamilyMemorySnapshot | undefined> {
    if (input.memoryOptOut) return undefined;
    if (!input.speakerIdentity || !["verified", "identified"].includes(input.speakerIdentity.source)) return undefined;
    if (input.speakerIdentity.confidence < envNumber("MEMORY_WRITE_MIN_CONFIDENCE", 0.82)) return undefined;

    const text = extractSharedFamilyFact(input.queryText);
    if (!text) return undefined;

    const data = await this.read();
    const now = new Date().toISOString();
    data.sharedFacts.push({
      id: randomUUID(),
      text,
      confidence: 0.88,
      createdAt: now,
      updatedAt: now
    });
    data.sharedFacts = data.sharedFacts.slice(-30);
    await this.write(data);
    return this.getSnapshot();
  }

  private async read(): Promise<FamilyMemoryFile> {
    try {
      const raw = await readFile(storePath, "utf8");
      const parsed = JSON.parse(raw) as FamilyMemoryFile;
      return {
        familyId: parsed.familyId ?? "local-family",
        members: parsed.members ?? [],
        sharedFacts: parsed.sharedFacts ?? [],
        agentUsage: parsed.agentUsage ?? [],
        reminderHabits: parsed.reminderHabits ?? []
      };
    } catch {
      return {
        familyId: "local-family",
        members: [],
        sharedFacts: [],
        agentUsage: [],
        reminderHabits: []
      };
    }
  }

  private async write(data: FamilyMemoryFile): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    await writeFile(storePath, JSON.stringify(data, null, 2), "utf8");
  }
}

export function getCurrentTimeSegment(): TimeSegment {
  return getTimeSegment(new Date());
}

export function getTimeSegment(date: Date): TimeSegment {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "noon";
  if (hour >= 14 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

function incrementAgentUsage(items: AgentUsageStat[], agentId: string, now: string): void {
  const existing = items.find((item) => item.agentId === agentId);
  if (existing) {
    existing.count += 1;
    existing.lastUsedAt = now;
  } else {
    items.push({ agentId, count: 1, lastUsedAt: now });
  }
  items.sort((a, b) => b.count - a.count || b.lastUsedAt.localeCompare(a.lastUsedAt));
}

function getOrCreateMember(data: FamilyMemoryFile, userId: string): FamilyMemberRecord {
  let member = data.members.find((item) => item.userId === userId);
  if (!member) {
    member = {
      userId,
      familyRole: "unknown",
      favoriteAgents: [],
      memoryCount: 0,
      updatedAt: new Date().toISOString()
    };
    data.members.push(member);
  }
  return member;
}

function toMemberSummary(member: FamilyMemberRecord): FamilyMemberSummary {
  return {
    userId: member.userId,
    displayName: member.displayName,
    familyRole: member.familyRole,
    favoriteAgents: member.favoriteAgents,
    memoryCount: member.memoryCount,
    updatedAt: member.updatedAt
  };
}

function extractSharedFamilyFact(queryText: string): string | undefined {
  const text = queryText.trim();
  const match = text.match(/(?:记住|记一下)(?:我们家|家里|全家|家庭)(.+)/);
  return match?.[1]?.trim().replace(/[。！!？?]$/, "");
}

function timeSegmentLabel(segment: TimeSegment): string {
  const labels: Record<TimeSegment, string> = {
    morning: "早上",
    noon: "中午",
    afternoon: "下午",
    evening: "晚上",
    night: "夜间"
  };
  return labels[segment];
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

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
