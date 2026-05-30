import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import "dotenv/config";
import Fastify from "fastify";
import type { WebSocket } from "ws";
import { agents, getAgentById } from "./agents";
import { CozeAdapter } from "./cozeAdapter";
import { ManualProfileProvider } from "./profileProvider";
import { routeAgent, routeStrongIntent } from "./router";
import { extractReminder, TaskMemory } from "./taskMemory";
import { analyzeVoiceProfile } from "./voiceProfile";
import type { ConverseRequest, TaskFiredEvent } from "../shared/types";

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

server.post<{ Body: { text: string; agentId?: string } }>("/api/speech", async (request, reply) => {
  const text = request.body.text?.trim();
  if (!text) {
    reply.code(400);
    return { error: "缺少要播放的文本" };
  }

  const agent = request.body.agentId ? getAgentById(request.body.agentId) : agents[0];
  const audio = await coze.synthesizeSpeech(text, agent.cozeVoiceId);
  if (!audio) {
    reply.code(424);
    return { error: "Coze 原生音色不可用，已回退到浏览器朗读" };
  }

  reply.header("Content-Type", "audio/mpeg");
  reply.header("Cache-Control", "no-store");
  return reply.send(Buffer.from(audio));
});

server.post<{
  Body: {
    botId?: string;
    agentId?: string;
    connectorId?: string;
    voiceId?: string;
    conversationId?: string;
  };
}>("/api/coze/realtime-room", async (request, reply) => {
  const agent = request.body.agentId ? getAgentById(request.body.agentId) : undefined;
  const botId = request.body.botId ?? agent?.cozeBotId ?? process.env.COZE_REALTIME_BOT_ID;
  if (!botId) {
    reply.code(400);
    return { error: "缺少 botId，无法创建实时语音房间" };
  }

  try {
    const room = await coze.createRealtimeRoom({
      botId,
      connectorId: request.body.connectorId,
      voiceId: request.body.voiceId ?? agent?.cozeVoiceId,
      conversationId: request.body.conversationId
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

server.post("/api/profile/audio", async (request, reply) => {
  const audio = await request.file();
  if (!audio) {
    reply.code(400);
    return { error: "Missing audio file" };
  }

  const buffer = await audio.toBuffer();
  return analyzeVoiceProfile(buffer, audio.mimetype);
});

server.post<{ Body: ConverseRequest }>("/api/converse", async (request) => {
  const profile = await profiles.analyze({ metadata: request.body.profile });
  const route = await routeAgent({
    ...request.body,
    lockedAgentId: request.body.lockedAgentId,
    profile
  });
  const agent = getAgentById(route.agentId);
  const assistantText = await coze.generateReply({
    agent,
    queryText: request.body.queryText,
    conversationContext: request.body.conversationContext,
    clientSessionId: request.body.clientSessionId
  });

  const reminderDraft = extractReminder(request.body.queryText, agent.id);
  const task = reminderDraft ? tasks.schedule(reminderDraft) : undefined;

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
