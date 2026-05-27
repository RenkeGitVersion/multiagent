import { agents } from "./agents";
import type { AgentConfig, RouteInput, RouteOutput } from "../shared/types";

const sceneKeywords: Record<string, string[]> = {
  故事: ["故事", "童话", "睡前", "讲一个", "哄睡"],
  健康: ["健康", "医生", "症状", "发烧", "咳嗽", "用药", "体检", "疼"],
  学习: ["学习", "作业", "考试", "题目", "复习", "课程"],
  提醒: ["提醒", "监督", "看电视", "时间到", "日程", "定时"],
  陪伴: ["聊天", "心情", "难过", "无聊", "陪我", "孤独"]
};

export function routeAgent(input: RouteInput): RouteOutput {
  const query = input.queryText.trim();
  const strong = matchStrongIntent(query);
  if (strong) {
    return {
      agentId: strong.id,
      intentStrength: "strong",
      reason: `命中智能体名称或唤醒词：${strong.displayName}`,
      confidence: 0.98
    };
  }

  const scored = agents
    .map((agent) => ({ agent, score: scoreAgent(agent, input) }))
    .sort((a, b) => b.score - a.score || b.agent.priority - a.agent.priority);

  const best = scored[0];
  const confidence = Math.min(0.92, Math.max(0.52, best.score / 10));
  return {
    agentId: best.agent.id,
    intentStrength: "weak",
    reason: buildWeakReason(best.agent, input.queryText),
    confidence
  };
}

function matchStrongIntent(query: string): AgentConfig | undefined {
  return agents.find((agent) =>
    [agent.displayName, ...agent.aliases].some((alias) => query.includes(alias))
  );
}

function scoreAgent(agent: AgentConfig, input: RouteInput): number {
  let score = agent.priority / 100;
  const query = input.queryText;

  if (agent.targetAgeGroups.includes(input.profile.ageGroup)) score += 2.3;
  if (agent.targetGenders.includes(input.profile.gender) || agent.targetGenders.includes("unknown")) {
    score += 0.4;
  }

  for (const scene of agent.serviceScenes) {
    const keywords = sceneKeywords[scene] ?? [scene];
    if (keywords.some((keyword) => query.includes(keyword))) {
      score += 3.2;
    }
  }

  for (const tag of agent.personaTags) {
    if (query.includes(tag)) score += 1.2;
  }

  if (input.currentAgentId === agent.id) score += 0.3;
  return score;
}

function buildWeakReason(agent: AgentConfig, queryText: string): string {
  const matchedScenes = agent.serviceScenes.filter((scene) => {
    const keywords = sceneKeywords[scene] ?? [scene];
    return keywords.some((keyword) => queryText.includes(keyword));
  });
  if (matchedScenes.length > 0) {
    return `根据 query 场景「${matchedScenes.join("、")}」和用户画像选择 ${agent.displayName}`;
  }
  return `未命中强意图，按用户画像和默认优先级选择 ${agent.displayName}`;
}
