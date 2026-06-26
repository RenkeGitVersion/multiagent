import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import "dotenv/config";
import Fastify from "fastify";
import type { WebSocket } from "ws";
import { agents, getAgentById } from "./agents";
import { CozeAdapter, CozeApiError } from "./cozeAdapter";
import { ManualProfileProvider } from "./profileProvider";
import { routeAgent, routeStrongIntent } from "./router";
import { extractReminder, TaskMemory } from "./taskMemory";
import { analyzeVoiceProfile } from "./voiceProfile";
import { getRuntimeEnv } from "./runtimeEnv";
import type { ConverseRequest, CozeRealtimeAgentStatus, TaskFiredEvent } from "../shared/types";

const server = Fastify({ logger: true });
const coze = new CozeAdapter();
const profiles = new ManualProfileProvider();
const tasks = new TaskMemory();
const sockets = new Set<WebSocket>();

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

server.post<{ Body: ConverseRequest }>("/api/converse", async (request) => {
  const startedAt = Date.now();
  const profile = await profiles.analyze({ metadata: request.body.profile });
  const route = await routeAgent({
    ...request.body,
    lockedAgentId: request.body.lockedAgentId,
    profile
  });
  const routedAt = Date.now();
  const agent = getAgentById(route.agentId);
  const assistantText = await coze.generateReply({
    agent,
    queryText: request.body.queryText,
    conversationContext: request.body.conversationContext,
    clientSessionId: request.body.clientSessionId
  });

  const reminderDraft = extractReminder(request.body.queryText, agent.id);
  const task = reminderDraft ? tasks.schedule(reminderDraft) : undefined;
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
    task
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
