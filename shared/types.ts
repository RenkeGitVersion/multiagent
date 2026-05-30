export type AgeGroup = "child" | "teen" | "adult" | "senior";
export type Gender = "female" | "male" | "unknown";
export type IntentStrength = "strong" | "weak";
export type TaskStatus = "scheduled" | "fired" | "cancelled";

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
  profile: UserProfile;
  conversationContext: ChatMessage[];
}

export interface RouteOutput {
  agentId: string;
  intentStrength: IntentStrength;
  reason: string;
  confidence: number;
  source: "strong-rule" | "model" | "rule-fallback";
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
  triggerAt: string;
  audience: string;
  message: string;
  reminderAgentId: string;
  status: TaskStatus;
}

export interface ConverseRequest {
  queryText: string;
  currentAgentId?: string;
  profile: UserProfile;
  conversationContext: ChatMessage[];
}

export interface ConverseResponse {
  agent: AgentConfig;
  route: RouteOutput;
  assistantText: string;
  task?: ReminderTask;
}

export interface TaskFiredEvent {
  type: "task:fired";
  task: ReminderTask;
  agent: AgentConfig;
  assistantText: string;
}
