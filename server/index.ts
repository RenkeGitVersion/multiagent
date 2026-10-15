import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import "dotenv/config";
import Fastify from "fastify";
import type { WebSocket } from "ws";
import { agents, getAgentById } from "./agents";
import { CozeAdapter, CozeApiError } from "./cozeAdapter";
import { FamilyMemory, getCurrentTimeSegment } from "./familyMemory";
import { IdentityGrantStore } from "./identityGrant";
import { ManualProfileProvider } from "./profileProvider";
import { routeAgent, routeStrongIntent } from "./router";
import { extractSpeakerEmbedding } from "./speakerRecognition";
import { SpeakerStore } from "./speakerStore";
import { extractReminder, TaskMemory } from "./taskMemory";
import { UserMemory } from "./userMemory";
import { analyzeVoiceProfile } from "./voiceProfile";
import { getRuntimeEnv } from "./runtimeEnv";
import type { ConverseRequest, CozeRealtimeAgentStatus, FamilyMemorySnapshot, FamilyRole, TaskFiredEvent, TimeSegment } from "../shared/types";

const server = Fastify({ logger: true });
const coze = new CozeAdapter();
const profiles = new ManualProfileProvider();
const tasks = new TaskMemory();
const speakerStore = new SpeakerStore();
const userMemory = new UserMemory();
const familyMemory = new FamilyMemory();
const sockets = new Set<WebSocket>();
const identityGrants = new IdentityGrantStore();

await server.register(cors, { origin: true });
await server.register(multipart, {
  limits: {
    fileSize: 1024 * 1024 * 8
  }
});
await server.register(websocket);

server.get("/api/agents", async () => ({ agents }));

server.get("/api/tasks", async () => ({ tasks: tasks.list() }));

server.get("/api/coze/voice-status", async () => ({
  ...coze.getVoiceRuntimeStatus(),
  realtimeAgents: agents
    .filter((agent) => agent.cozeRealtimeTokenEnv || agent.id === "little-fox")
    .map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      hasBotId: Boolean(agent.cozeBotId && !agent.cozeBotId.startsWith("replace_with_")),
      hasVoiceId: Boolean(agent.cozeVoiceId && !agent.cozeVoiceId.startsWith("replace_with_")),
      hasRealtimeTokenEnv: Boolean(agent.cozeRealtimeTokenEnv),
      hasRealtimeTokenValue: Boolean(agent.cozeRealtimeTokenEnv && getRuntimeEnv(agent.cozeRealtimeTokenEnv))
    }) satisfies CozeRealtimeAgentStatus),
  hasAnyRealtimeToken: agents.some((agent) => Boolean(agent.cozeRealtimeTokenEnv && getRuntimeEnv(agent.cozeRealtimeTokenEnv)))
}));

server.post<{ Body: { text: string; agentId?: string } }>("/api/speech", async (request, reply) => {
  const text = request.body.text?.trim();
  if (!text) {
    reply.code(400);
    return { error: "缺少要播放的文本" };
  }

  const agent = request.body.agentId ? getAgentById(request.body.agentId) : agents[0];
  try {
    const audio = await coze.synthesizeSpeech(text, agent.cozeVoiceId);
    if (!audio) {
      reply.code(424);
      return { error: "Coze 原生音色不可用：当前 agent 未配置可用 voiceId 或处于 mock 模式" };
    }

    reply.header("Content-Type", "audio/mpeg");
    reply.header("Cache-Control", "no-store");
    return reply.send(Buffer.from(audio));
  } catch (error) {
    reply.code(error instanceof CozeApiError && error.status === 403 ? 403 : 424);
    return { error: error instanceof Error ? error.message : "Coze 原生音色不可用" };
  }
});

server.post<{
  Body: {
    botId?: string;
    agentId?: string;
    connectorId?: string;
    voiceId?: string;
    conversationId?: string;
    roomMode?: "default" | "s2s";
  };
}>("/api/coze/realtime-room", async (request, reply) => {
  const agent = request.body.agentId ? getAgentById(request.body.agentId) : undefined;
  const botId = request.body.botId ?? agent?.cozeBotId ?? getRuntimeEnv("COZE_REALTIME_BOT_ID");
  if (!botId) {
    reply.code(400);
    return { error: "缺少 botId，无法创建实时语音房间" };
  }

  try {
    const room = await coze.createRealtimeRoom({
      botId,
      connectorId: request.body.connectorId,
      voiceId: request.body.voiceId ?? agent?.cozeVoiceId,
      realtimeToken: agent?.cozeRealtimeTokenEnv ? getRuntimeEnv(agent.cozeRealtimeTokenEnv) : undefined,
      conversationId: request.body.conversationId,
      roomMode: request.body.roomMode
    });
    return { room };
  } catch (error) {
    reply.code(502);
    return { error: error instanceof Error ? error.message : "创建实时语音房间失败" };
  }
});

server.post<{ Body: { queryText: string } }>("/api/route/strong", async (request) => ({
  route: routeStrongIntent(request.body.queryText.trim()) ?? null
}));

server.post<{ Body: { event?: string; detail?: Record<string, unknown> } }>("/api/debug/client-event", async (request) => {
  request.log.info({
    event: request.body.event,
    detail: request.body.detail
  }, "client speech debug");
  return { ok: true };
});

server.post("/api/profile/audio", async (request, reply) => {
  const audio = await request.file();
  if (!audio) {
    reply.code(400);
    return { error: "Missing audio file" };
  }

  const buffer = await audio.toBuffer();
  return analyzeVoiceProfile(buffer, audio.mimetype);
});

server.post("/api/transcribe/audio", async (request, reply) => {
  const audio = await request.file();
  if (!audio) {
    reply.code(400);
    return { error: "Missing audio file" };
  }

  const buffer = await audio.toBuffer();
  if (buffer.length < 1200) {
    return { text: "", source: "empty" };
  }

  try {
    return await transcribeAudio(buffer, audio.mimetype, audio.filename);
  } catch (error) {
    request.log.error({ error }, "audio transcription failed");
    reply.code(502);
    return { error: error instanceof Error ? error.message : "语音转写失败" };
  }
});

server.get("/api/speaker/users", async () => ({ users: await speakerStore.listUsers() }));

server.post("/api/speaker/register", async (request, reply) => {
  const audio = await request.file();
  if (!audio) {
    reply.code(400);
    return { error: "Missing audio file" };
  }

  const buffer = await audio.toBuffer();
  const embeddingResult = await extractSpeakerEmbedding(buffer, audio.mimetype);
  return speakerStore.registerSample({
    userId: formFieldValue(audio.fields, "userId"),
    displayName: formFieldValue(audio.fields, "displayName"),
    familyRole: normalizeFamilyRole(formFieldValue(audio.fields, "familyRole") as FamilyRole | undefined),
    embeddingResult
  });
});

server.post("/api/speaker/verify", async (request, reply) => {
  const audio = await request.file();
  if (!audio) {
    reply.code(400);
    return { error: "Missing audio file" };
  }
  const userId = formFieldValue(audio.fields, "userId");
  if (!userId) {
    reply.code(400);
    return { error: "Missing userId" };
  }

  const buffer = await audio.toBuffer();
  const embeddingResult = await extractSpeakerEmbedding(buffer, audio.mimetype);
  return identityGrants.issue(await speakerStore.verify(userId, embeddingResult));
});

server.post("/api/speaker/identify", async (request, reply) => {
  const audio = await request.file();
  if (!audio) {
    reply.code(400);
    return { error: "Missing audio file" };
  }

  const buffer = await audio.toBuffer();
  const embeddingResult = await extractSpeakerEmbedding(buffer, audio.mimetype);
  return identityGrants.issue(await speakerStore.identify(embeddingResult));
});

server.post("/api/speaker/resolve", async (request, reply) => {
  const audio = await request.file();
  if (!audio) {
    reply.code(400);
    return { error: "Missing audio file" };
  }

  const buffer = await audio.toBuffer();
  const embeddingResult = await extractSpeakerEmbedding(buffer, audio.mimetype);
  return identityGrants.issue(await speakerStore.resolve({
    embeddingResult,
    claimedUserId: formFieldValue(audio.fields, "claimedUserId"),
    assistantPlaybackRecentlyEnded: formFieldValue(audio.fields, "assistantPlaybackRecentlyEnded") === "true"
  }));
});

server.patch<{ Body: { userId: string; enabled: boolean } }>("/api/speaker/auto-improve", async (request, reply) => {
  if (!identityGrants.resolve(headerValue(request.headers["x-speaker-identity-token"]), request.body.userId)) {
    reply.code(403);
    return { error: "缺少有效的声纹身份凭证" };
  }
  const updated = await speakerStore.setAutoImprove(request.body.userId, request.body.enabled);
  if (!updated) {
    reply.code(404);
    return { error: "Speaker user not found" };
  }
  return { user: updated };
});

server.delete<{ Params: { userId: string } }>("/api/speaker/users/:userId", async (request, reply) => {
  if (!identityGrants.resolve(headerValue(request.headers["x-speaker-identity-token"]), request.params.userId)) {
    reply.code(403);
    return { error: "缺少有效的声纹身份凭证" };
  }
  const updated = await speakerStore.disableUser(request.params.userId);
  if (!updated) {
    reply.code(404);
    return { error: "Speaker user not found" };
  }
  return { user: updated };
});

server.get<{ Params: { userId: string } }>("/api/memory/:userId", async (request, reply) => {
  if (!identityGrants.resolve(headerValue(request.headers["x-speaker-identity-token"]), request.params.userId)) {
    reply.code(403);
    return { error: "缺少有效的声纹身份凭证" };
  }
  return { memory: await userMemory.getSnapshot(request.params.userId) };
});

server.delete<{ Params: { userId: string } }>("/api/memory/:userId", async (request, reply) => {
  if (!identityGrants.resolve(headerValue(request.headers["x-speaker-identity-token"]), request.params.userId)) {
    reply.code(403);
    return { error: "缺少有效的声纹身份凭证" };
  }
  return { memory: await userMemory.clear(request.params.userId) };
});

server.get("/api/family-memory", async (_request, reply) => {
  reply.code(403);
  return { error: "家庭记忆只在已验证的对话上下文中返回" };
});

server.post<{ Body: ConverseRequest }>("/api/converse", async (request) => {
  const startedAt = Date.now();
  const profile = await profiles.analyze({ metadata: request.body.profile });
  const timeSegment = normalizeTimeSegment(request.body.timeSegment) ?? getCurrentTimeSegment();
  const trustedSpeakerIdentity = identityGrants.resolve(request.body.identityToken, request.body.resolvedUserId);
  const trustedUserId = trustedSpeakerIdentity?.userId;
  const familyRole = normalizeFamilyRole(trustedSpeakerIdentity?.familyRole);
  const canUseMemory = Boolean(trustedUserId);
  const personalMemoryContext = trustedUserId
    ? await userMemory.formatForPrompt(trustedUserId)
    : "";
  const familyMemorySnapshot = trustedUserId
    ? await familyMemory.getSnapshotForUser(trustedUserId, timeSegment)
    : undefined;
  const familyMemoryContext = canUseMemory ? await familyMemory.formatForPrompt(trustedUserId, timeSegment) : "";
  const memoryContext = [personalMemoryContext, familyMemoryContext].filter(Boolean).join("\n\n");
  const route = await routeAgent({
    ...request.body,
    resolvedUserId: trustedUserId,
    lockedAgentId: request.body.lockedAgentId,
    profile,
    familyRole,
    timeSegment,
    familyMemory: familyMemorySnapshot
  });
  const routedAt = Date.now();
  const agent = getAgentById(route.agentId);
  const assistantText = await coze.generateReply({
    agent,
    queryText: request.body.queryText,
    conversationContext: request.body.conversationContext,
    clientSessionId: request.body.clientSessionId,
    resolvedUserId: trustedUserId,
    memoryContext
  });

  const reminderDraft = extractReminder(request.body.queryText, agent.id);
  const task = reminderDraft
    ? tasks.schedule({
      ...reminderDraft,
      userId: trustedUserId,
      familyRole,
      timeSegment
    })
    : undefined;
  if (task && canUseMemory) await familyMemory.recordReminderHabit(task);

  const memory = trustedUserId
    ? await userMemory.writeIfAllowed({
      userId: trustedUserId,
      familyRole,
      displayName: trustedSpeakerIdentity?.displayName,
      queryText: request.body.queryText,
      speakerIdentity: trustedSpeakerIdentity,
      memoryOptOut: request.body.memoryOptOut
    })
    : undefined;
  if (canUseMemory) {
    await familyMemory.writeSharedIfAllowed({
      queryText: request.body.queryText,
      speakerIdentity: trustedSpeakerIdentity,
      memoryOptOut: request.body.memoryOptOut
    });
  }
  let updatedFamilyMemory: FamilyMemorySnapshot | undefined;
  if (trustedUserId) {
    await familyMemory.recordAgentUse({
      userId: trustedUserId,
      displayName: trustedSpeakerIdentity?.displayName,
      familyRole,
      agentId: agent.id,
      memoryCount: (memory?.facts.length ?? 0) + (memory?.preferences.length ?? 0)
    });
    updatedFamilyMemory = await familyMemory.getSnapshotForUser(trustedUserId, timeSegment);
  }
  request.log.info({
    queryText: request.body.queryText,
    routeSource: route.source,
    routeAgentId: route.agentId,
    routeMs: routedAt - startedAt,
    totalMs: Date.now() - startedAt
  }, "converse timing");

  return {
    agent,
    route,
    assistantText,
    task,
    speakerIdentity: trustedSpeakerIdentity ?? {
      source: "unknown",
      confidence: 0,
      reason: "身份凭证缺失或已过期，本轮不使用长期记忆"
    },
    memory,
    familyMemory: updatedFamilyMemory,
    timeSegment
  };
});

server.get("/api/events", { websocket: true }, (socket) => {
  sockets.add(socket);
  socket.send(JSON.stringify({ type: "connected" }));
  socket.on("close", () => sockets.delete(socket));
});

tasks.on("fired", async (task) => {
  const agent = getAgentById(task.reminderAgentId);
  const assistantText = await coze.generateReply({
    agent,
    queryText: task.message,
    conversationContext: []
  });
  const event: TaskFiredEvent = {
    type: "task:fired",
    task,
    agent,
    assistantText: `${agent.displayName}提醒：${task.message}`
  };

  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  }
});

const port = Number(process.env.PORT ?? 8787);
server.listen({ port, host: "0.0.0.0" }).catch((error) => {
  server.log.error(error);
  process.exit(1);
});

async function transcribeAudio(buffer: Buffer, mimetype?: string, filename?: string) {
  const baseUrl = getRuntimeEnv("STT_BASE_URL") ?? getRuntimeEnv("LLM_ROUTER_BASE_URL");
  const apiKey = getRuntimeEnv("STT_API_KEY") ?? getRuntimeEnv("LLM_ROUTER_API_KEY");
  const model = getRuntimeEnv("STT_MODEL") ?? "whisper-1";
  if (!baseUrl || !apiKey) {
    throw new Error("未配置 STT_BASE_URL/STT_API_KEY 或 LLM_ROUTER_BASE_URL/LLM_ROUTER_API_KEY");
  }

  const form = new FormData();
  const audioBlob = new Blob([new Uint8Array(buffer)], { type: mimetype || "audio/webm" });
  form.append("file", audioBlob, filename || "speech.webm");
  form.append("model", model);
  form.append("response_format", "json");
  const language = getRuntimeEnv("STT_LANGUAGE");
  if (language) form.append("language", language);
  const prompt = getRuntimeEnv("STT_PROMPT") ?? "请准确转写用户语音，可能包含中文、英文、智能体名称和儿童陪伴、健康咨询、英语学习等场景词。";
  if (prompt) form.append("prompt", prompt);

  const startedAt = Date.now();
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });
  const payload = await response.json().catch(() => ({})) as { text?: string; error?: { message?: string } };
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `STT HTTP ${response.status}`);
  }

  return {
    text: (payload.text ?? "").trim(),
    source: "backend-stt",
    model,
    elapsedMs: Date.now() - startedAt
  };
}

function formFieldValue(fields: unknown, key: string): string | undefined {
  const field = (fields as Record<string, { value?: unknown } | undefined> | undefined)?.[key];
  return typeof field?.value === "string" ? field.value.trim() || undefined : undefined;
}

function normalizeFamilyRole(role?: FamilyRole): FamilyRole {
  return role && ["father", "mother", "child", "elder", "guest", "unknown"].includes(role) ? role : "unknown";
}

function normalizeTimeSegment(segment?: TimeSegment): TimeSegment | undefined {
  return segment && ["morning", "noon", "afternoon", "evening", "night"].includes(segment) ? segment : undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
