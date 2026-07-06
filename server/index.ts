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
import { extractSpeakerEmbedding } from "./speakerRecognition";
import { SpeakerStore } from "./speakerStore";
import { extractReminder, TaskMemory } from "./taskMemory";
import { UserMemory } from "./userMemory";
import { analyzeVoiceProfile } from "./voiceProfile";
import type { ConverseRequest, TaskFiredEvent } from "../shared/types";

const server = Fastify({ logger: true });
const coze = new CozeAdapter();
const profiles = new ManualProfileProvider();
const tasks = new TaskMemory();
const speakerStore = new SpeakerStore();
const userMemory = new UserMemory();
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
  return speakerStore.verify(userId, embeddingResult);
});

server.post("/api/speaker/identify", async (request, reply) => {
  const audio = await request.file();
  if (!audio) {
    reply.code(400);
    return { error: "Missing audio file" };
  }

  const buffer = await audio.toBuffer();
  const embeddingResult = await extractSpeakerEmbedding(buffer, audio.mimetype);
  return speakerStore.identify(embeddingResult);
});

server.post("/api/speaker/resolve", async (request, reply) => {
  const audio = await request.file();
  if (!audio) {
    reply.code(400);
    return { error: "Missing audio file" };
  }

  const buffer = await audio.toBuffer();
  const embeddingResult = await extractSpeakerEmbedding(buffer, audio.mimetype);
  return speakerStore.resolve({
    embeddingResult,
    claimedUserId: formFieldValue(audio.fields, "claimedUserId"),
    assistantPlaybackRecentlyEnded: formFieldValue(audio.fields, "assistantPlaybackRecentlyEnded") === "true"
  });
});

server.patch<{ Body: { userId: string; enabled: boolean } }>("/api/speaker/auto-improve", async (request, reply) => {
  const updated = await speakerStore.setAutoImprove(request.body.userId, request.body.enabled);
  if (!updated) {
    reply.code(404);
    return { error: "Speaker user not found" };
  }
  return { user: updated };
});

server.delete<{ Params: { userId: string } }>("/api/speaker/users/:userId", async (request, reply) => {
  const updated = await speakerStore.disableUser(request.params.userId);
  if (!updated) {
    reply.code(404);
    return { error: "Speaker user not found" };
  }
  return { user: updated };
});

server.get<{ Params: { userId: string } }>("/api/memory/:userId", async (request) => ({
  memory: await userMemory.getSnapshot(request.params.userId)
}));

server.delete<{ Params: { userId: string } }>("/api/memory/:userId", async (request) => ({
  memory: await userMemory.clear(request.params.userId)
}));

server.post<{ Body: ConverseRequest }>("/api/converse", async (request) => {
  const profile = await profiles.analyze({ metadata: request.body.profile });
  const canUseMemory = Boolean(
    request.body.resolvedUserId
    && request.body.speakerIdentity
    && ["verified", "identified"].includes(request.body.speakerIdentity.source)
  );
  const memoryContext = canUseMemory && request.body.resolvedUserId
    ? await userMemory.formatForPrompt(request.body.resolvedUserId)
    : "";
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
    clientSessionId: request.body.clientSessionId,
    resolvedUserId: request.body.resolvedUserId,
    memoryContext
  });

  const reminderDraft = extractReminder(request.body.queryText, agent.id);
  const task = reminderDraft ? tasks.schedule(reminderDraft) : undefined;

  return {
    agent,
    route,
    assistantText,
    task,
    speakerIdentity: request.body.speakerIdentity,
    memory: request.body.resolvedUserId
      ? await userMemory.writeIfAllowed({
        userId: request.body.resolvedUserId,
        queryText: request.body.queryText,
        speakerIdentity: request.body.speakerIdentity,
        memoryOptOut: request.body.memoryOptOut
      })
      : undefined
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

function formFieldValue(fields: unknown, key: string): string | undefined {
  const field = (fields as Record<string, { value?: unknown } | undefined> | undefined)?.[key];
  return typeof field?.value === "string" ? field.value.trim() || undefined : undefined;
}
