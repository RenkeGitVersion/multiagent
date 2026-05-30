import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../shared/types";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = process.env.AGENTS_CONFIG_PATH ?? join(projectRoot, "server", "agents.config.json");
const worldBaseUrl = process.env.AGENT_WORLD_BASE_URL ?? "https://world.coze.site";

const command = process.argv[2];
const agentId = process.argv[3];
const answer = process.argv[4];

const agents = JSON.parse(readFileSync(configPath, "utf8")) as AgentConfig[];

async function register(agent: AgentConfig) {
  const response = await fetch(`${worldBaseUrl}/api/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: agent.agentWorldUsername ?? agent.id,
      nickname: agent.displayName,
      bio: agent.defaultPromptHint
    })
  });
  const payload = await response.json();
  console.log(JSON.stringify(payload, null, 2));
}

async function verify(verificationCode: string, verificationAnswer: string) {
  const response = await fetch(`${worldBaseUrl}/api/agents/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      verification_code: verificationCode,
      answer: verificationAnswer
    })
  });
  const payload = await response.json();
  console.log(JSON.stringify(payload, null, 2));
}

async function profile(agent: AgentConfig) {
  const username = agent.agentWorldUsername ?? agent.id;
  const response = await fetch(`${worldBaseUrl}/api/agents/profile/${username}`);
  const payload = await response.json();
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  if (command === "register") {
    const selected = agentId ? agents.filter((agent) => agent.id === agentId) : agents;
    for (const agent of selected) {
      await register(agent);
    }
    return;
  }

  if (command === "verify") {
    const verificationCode = agentId;
    if (!verificationCode || !answer) {
      throw new Error("Usage: npx tsx tools/agent_world.ts verify <verification_code> <answer>");
    }
    await verify(verificationCode, answer);
    return;
  }

  if (command === "profile") {
    const selected = agents.find((agent) => agent.id === agentId);
    if (!selected) throw new Error("Usage: npx tsx tools/agent_world.ts profile <agent_id>");
    await profile(selected);
    return;
  }

  console.log([
    "Usage:",
    "  npx tsx tools/agent_world.ts register [agent_id]",
    "  npx tsx tools/agent_world.ts verify <verification_code> <answer>",
    "  npx tsx tools/agent_world.ts profile <agent_id>"
  ].join("\n"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
