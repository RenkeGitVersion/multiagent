export type AgeGroup = "child" | "teen" | "adult" | "senior";
export type Gender = "female" | "male" | "unknown";
export type IntentStrength = "strong" | "weak";
export type TaskStatus = "scheduled" | "fired" | "cancelled";
export type FamilyRole = "father" | "mother" | "child" | "elder" | "guest" | "unknown";
export type TimeSegment = "morning" | "noon" | "afternoon" | "evening" | "night";

export interface UserProfile {
  ageGroup: AgeGroup;
  gender: Gender;
}

export interface VoiceProfileResult extends UserProfile {
  ageYears: number;
  genderConfidence: number;
  inferenceSeconds: number;
  totalSeconds: number;
  source: "voice" | "manual" | "failed" | "skipped";
  error?: string;
}

export interface VoiceQuality {
  ok: boolean;
  durationSeconds: number;
  speechSeconds: number;
  rms: number;
  peak: number;
  clippingRatio: number;
  silenceRatio: number;
  reasons: string[];
}

export interface SpeakerIdentity {
  userId?: string;
  displayName?: string;
  familyRole?: FamilyRole;
  source: "verified" | "identified" | "manual" | "unknown" | "failed";
  confidence: number;
  similarity?: number;
  secondBestSimilarity?: number;
  margin?: number;
  quality?: VoiceQuality;
  reason?: string;
}

export interface SpeakerUserSummary {
  userId: string;
  displayName?: string;
  familyRole: FamilyRole;
  sampleCount: number;
  centroidReady: boolean;
  status: "active" | "disabled";
  autoImproveVoiceprint: boolean;
  updatedAt: string;
}

export interface SpeakerRegisterResponse {
  userId: string;
  displayName?: string;
  familyRole: FamilyRole;
  sampleCount: number;
  quality: VoiceQuality;
  centroidReady: boolean;
  message: string;
}

export interface UserMemorySnapshot {
  userId: string;
  familyRole: FamilyRole;
  displayName?: string;
  facts: Array<{
    id: string;
    text: string;
    confidence: number;
    updatedAt: string;
  }>;
  preferences: Array<{
    key: string;
    value: string;
    confidence: number;
    updatedAt: string;
  }>;
}

export interface AgentUsageStat {
  agentId: string;
  count: number;
  lastUsedAt: string;
}

export interface ReminderHabit {
  id: string;
  userId?: string;
  familyRole: FamilyRole;
  audience: string;
  message: string;
  timeSegment: TimeSegment;
  agentId: string;
  count: number;
  lastTriggeredAt: string;
}

export interface FamilyMemberSummary {
  userId: string;
  displayName?: string;
  familyRole: FamilyRole;
  favoriteAgents: AgentUsageStat[];
  memoryCount: number;
  updatedAt: string;
}

export interface FamilyMemorySnapshot {
  familyId: string;
  currentTimeSegment: TimeSegment;
  members: FamilyMemberSummary[];
  sharedFacts: Array<{
    id: string;
    text: string;
    confidence: number;
    updatedAt: string;
  }>;
  agentUsage: AgentUsageStat[];
  reminderHabits: ReminderHabit[];
}

export interface AgentConfig {
  id: string;
  cozeBotId: string;
  cozeVoiceId?: string;
  cozeConversationId?: string;
  agentWorldUsername?: string;
  agentWorldApiKey?: string;
  agentWorldProfileUrl?: string;
  displayName: string;
  aliases: string[];
  personaTags: string[];
  targetAgeGroups: AgeGroup[];
  targetGenders: Gender[];
  serviceScenes: string[];
  gifPath: string;
  defaultPromptHint: string;
  priority: number;
}

export interface RouteInput {
  queryText: string;
  currentAgentId?: string;
  lockedAgentId?: string;
  profile: UserProfile;
  familyRole?: FamilyRole;
  timeSegment?: TimeSegment;
  familyMemory?: FamilyMemorySnapshot;
  conversationContext: ChatMessage[];
}

export interface RouteOutput {
  agentId: string;
  intentStrength: IntentStrength;
  reason: string;
  confidence: number;
  source: "strong-rule" | "model" | "rule-fallback" | "session-lock";
  candidates?: Array<{
    agentId: string;
    score: number;
    reason: string;
  }>;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  agentId?: string;
  createdAt: string;
}

export interface ReminderTask {
  taskId: string;
  createdByAgentId: string;
  userId?: string;
  familyRole?: FamilyRole;
  timeSegment?: TimeSegment;
  triggerAt: string;
  audience: string;
  message: string;
  reminderAgentId: string;
  status: TaskStatus;
}

export interface ConverseRequest {
  queryText: string;
  currentAgentId?: string;
  lockedAgentId?: string;
  clientSessionId?: string;
  resolvedUserId?: string;
  speakerIdentity?: SpeakerIdentity;
  memoryOptOut?: boolean;
  timeSegment?: TimeSegment;
  profile: UserProfile;
  conversationContext: ChatMessage[];
}

export interface ConverseResponse {
  agent: AgentConfig;
  route: RouteOutput;
  assistantText: string;
  task?: ReminderTask;
  memory?: UserMemorySnapshot;
  familyMemory?: FamilyMemorySnapshot;
  timeSegment?: TimeSegment;
  speakerIdentity?: SpeakerIdentity;
}

export interface TaskFiredEvent {
  type: "task:fired";
  task: ReminderTask;
  agent: AgentConfig;
  assistantText: string;
}
