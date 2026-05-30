import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../shared/types";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = process.env.AGENTS_CONFIG_PATH ?? join(projectRoot, "server", "agents.config.json");

export const agents: AgentConfig[] = JSON.parse(readFileSync(configPath, "utf8")) as AgentConfig[];

export function getAgentById(agentId: string): AgentConfig {
  const agent = agents.find((item) => item.id === agentId);
  if (!agent) {
    throw new Error(`Unknown agent id: ${agentId}`);
  }
  return agent;
}
