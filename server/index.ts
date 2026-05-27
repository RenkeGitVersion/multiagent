import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import "dotenv/config";
import Fastify from "fastify";
import type { WebSocket } from "ws";
import { agents, getAgentById } from "./agents";
import { CozeAdapter } from "./cozeAdapter";
import { ManualProfileProvider } from "./profileProvider";
import { routeAgent } from "./router";
import { extractReminder, TaskMemory } from "./taskMemory";
import type { ConverseRequest, TaskFiredEvent } from "../shared/types";

const server = Fastify({ logger: true });
const coze = new CozeAdapter();
const profiles = new ManualProfileProvider();
const tasks = new TaskMemory();
const sockets = new Set<WebSocket>();

await server.register(cors, { origin: true });
await server.register(websocket);

server.get("/api/agents", async () => ({ agents }));

server.get("/api/tasks", async () => ({ tasks: tasks.list() }));

server.post<{ Body: ConverseRequest }>("/api/converse", async (request) => {
  const profile = await profiles.analyze({ metadata: request.body.profile });
  const route = routeAgent({
    ...request.body,
    profile
  });
  const agent = getAgentById(route.agentId);
  const assistantText = await coze.generateReply({
    agent,
    queryText: request.body.queryText,
    conversationContext: request.body.conversationContext
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
