import { agents } from "./agents";
import type { AgentConfig, RouteInput, RouteOutput } from "../shared/types";

const sceneKeywords: Record<string, string[]> = {
  故事: ["故事", "童话", "睡前", "讲一个", "哄睡"],
  健康: ["健康", "医生", "症状", "发烧", "咳嗽", "用药", "体检", "疼"],
  学习: ["学习", "学", "英语", "英文", "单词", "口语", "语法", "数学", "语文", "作业", "考试", "题目", "复习", "课程", "计划", "辅导"],
  提醒: ["提醒", "监督", "看电视", "时间到", "日程", "定时"],
  陪伴: ["聊天", "心情", "难过", "无聊", "陪我", "孤独"]
};

export interface RouteCandidate {
  agent: AgentConfig;
  score: number;
  reason: string;
}

export async function routeAgent(input: RouteInput): Promise<RouteOutput> {
  const strong = routeStrongIntent(input.queryText.trim());
  if (strong) return strong;

  if (input.lockedAgentId && agents.some((agent) => agent.id === input.lockedAgentId)) {
    return {
      agentId: input.lockedAgentId,
      intentStrength: "weak",
      reason: "10 秒内连续对话，保持当前智能体",
      confidence: 0.94,
      source: "session-lock"
    };
  }

  const candidates = recallTopAgents(input);
  const modelRoute = await routeWithModel(input, candidates);
  if (modelRoute) return modelRoute;

  const best = candidates[0];
  return {
    agentId: best.agent.id,
    intentStrength: "weak",
    reason: `${best.reason}；TOP3 候选兜底选择 ${best.agent.displayName}`,
    confidence: Math.min(0.92, Math.max(0.52, best.score / 10)),
    source: "rule-fallback",
    candidates: toRouteCandidates(candidates)
  };
}

export function routeAgentByRules(input: RouteInput): RouteOutput {
  const query = input.queryText.trim();
  const strong = routeStrongIntent(query);
  if (strong) return strong;

  if (input.lockedAgentId && agents.some((agent) => agent.id === input.lockedAgentId)) {
    return {
      agentId: input.lockedAgentId,
      intentStrength: "weak",
      reason: "10 秒内连续对话，保持当前智能体",
      confidence: 0.94,
      source: "session-lock"
    };
  }

  const domain = matchDomainIntent(query);
  if (domain) {
    return {
      agentId: domain.agentId,
      intentStrength: "weak",
      reason: `命中${domain.scene}类需求关键词：${domain.keyword}`,
      confidence: 0.9,
      source: "rule-fallback"
    };
  }

  const scored = recallTopAgents(input);

  const best = scored[0];
  const confidence = Math.min(0.92, Math.max(0.52, best.score / 10));
  return {
    agentId: best.agent.id,
    intentStrength: "weak",
    reason: `${best.reason}；TOP3 候选兜底选择 ${best.agent.displayName}`,
    confidence,
    source: "rule-fallback",
    candidates: toRouteCandidates(scored)
  };
}

export function routeStrongIntent(query: string): RouteOutput | undefined {
  const strong = matchStrongIntent(query);
  if (!strong) return undefined;
  return {
    agentId: strong.id,
    intentStrength: "strong",
    reason: `命中智能体名称或唤醒词：${strong.displayName}`,
    confidence: 0.98,
    source: "strong-rule"
  };
}

export function recallTopAgents(input: RouteInput, limit = 3): RouteCandidate[] {
  return agents
    .map((agent) => {
      const score = scoreAgent(agent, input);
      return {
        agent,
        score,
        reason: buildCandidateReason(agent, input, score)
      };
    })
    .sort((a, b) => b.score - a.score || b.agent.priority - a.agent.priority)
    .slice(0, limit);
}

async function routeWithModel(input: RouteInput, candidates: RouteCandidate[]): Promise<RouteOutput | undefined> {
  const apiKey = process.env.LLM_ROUTER_API_KEY;
  const baseUrl = process.env.LLM_ROUTER_BASE_URL;
  const model = process.env.LLM_ROUTER_MODEL;
  const wireApi = process.env.LLM_ROUTER_WIRE_API ?? "responses";
  if (!apiKey || !baseUrl || !model) return undefined;

  try {
    const content = wireApi === "chat"
      ? await callChatCompletionsRouter(baseUrl, apiKey, model, input, candidates)
      : await callResponsesRouter(baseUrl, apiKey, model, input, candidates);
    if (!content) return undefined;
    const parsed = JSON.parse(content) as { agentId?: string; reason?: string; confidence?: number };
    if (!parsed.agentId || !candidates.some((candidate) => candidate.agent.id === parsed.agentId)) return undefined;

    return {
      agentId: parsed.agentId,
      intentStrength: "weak",
      reason: `TOP3 候选后模型判断：${parsed.reason ?? "根据 query、用户画像和偏好候选选择"}`,
      confidence: Math.max(0.5, Math.min(0.98, parsed.confidence ?? 0.75)),
      source: "model",
      candidates: toRouteCandidates(candidates)
    };
  } catch {
    return undefined;
  }
}

async function callResponsesRouter(baseUrl: string, apiKey: string, model: string, input: RouteInput, candidates: RouteCandidate[]): Promise<string | undefined> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: process.env.LLM_ROUTER_REASONING_EFFORT ?? "high" },
      max_output_tokens: Number(process.env.LLM_ROUTER_MAX_OUTPUT_TOKENS ?? 80),
      store: false,
      input: [
        {
          role: "system",
          content: buildRouterSystemPrompt(candidates)
        },
        {
          role: "user",
          content: JSON.stringify(buildRouterPayload(input, candidates))
        }
      ]
    })
  });
  if (!response.ok) return undefined;
  const payload = await response.json() as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; output_text?: string; type?: string }> }>;
  };
  const content = payload.output?.flatMap((item) => item.content ?? []);
  return payload.output_text
    ?? content?.find((item) => item.output_text)?.output_text
    ?? content?.find((item) => item.text)?.text;
}

async function callChatCompletionsRouter(baseUrl: string, apiKey: string, model: string, input: RouteInput, candidates: RouteCandidate[]): Promise<string | undefined> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: Number(process.env.LLM_ROUTER_MAX_OUTPUT_TOKENS ?? 80),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildRouterSystemPrompt(candidates) },
        { role: "user", content: JSON.stringify(buildRouterPayload(input, candidates)) }
      ]
    })
  });
  if (!response.ok) return undefined;
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return payload.choices?.[0]?.message?.content;
}

function buildRouterSystemPrompt(candidates: RouteCandidate[]): string {
  const candidateIds = candidates.map((candidate) => candidate.agent.id).join(", ");
  return [
    "你是多智能体系统的弱意图路由器。只输出 JSON，不要输出 Markdown。",
    `候选 agentId 只有：${candidateIds}。不要选择候选外的 agentId。`,
    "强唤醒词已在外层处理；这里处理自然语言弱意图。",
    "定时、监督、提醒类任务优先选择 life-butler。",
    "学习语言、作业、课程、考试、题目、学习计划选择 study-coach。",
    "症状、健康、用药、体检选择 doctor-chen。",
    "故事、睡前、儿童陪伴选择 little-fox。",
    "情绪、闲聊、陪伴选择 companion-lan。",
    "返回 JSON：{\"agentId\":\"...\",\"reason\":\"...\",\"confidence\":0.0}"
  ].join("\n");
}

function buildRouterPayload(input: RouteInput, candidates: RouteCandidate[]) {
  return {
    queryText: input.queryText,
    profile: input.profile,
    familyRole: input.familyRole,
    timeSegment: input.timeSegment,
    familyMemory: input.familyMemory,
    currentAgentId: input.currentAgentId,
    candidateAgents: candidates.map((candidate, index) => ({
      rank: index + 1,
      score: Number(candidate.score.toFixed(3)),
      reason: candidate.reason,
      id: candidate.agent.id,
      displayName: candidate.agent.displayName,
      personaTags: candidate.agent.personaTags,
      serviceScenes: candidate.agent.serviceScenes,
      targetAgeGroups: candidate.agent.targetAgeGroups
    }))
  };
}

function matchDomainIntent(query: string): { agentId: string; scene: string; keyword: string } | undefined {
  const domainPriority = [
    { scene: "提醒", agentId: "life-butler" },
    { scene: "学习", agentId: "study-coach" },
    { scene: "健康", agentId: "doctor-chen" },
    { scene: "故事", agentId: "little-fox" },
    { scene: "陪伴", agentId: "companion-lan" }
  ];

  for (const domain of domainPriority) {
    const keyword = sceneKeywords[domain.scene]?.find((item) => query.includes(item));
    if (keyword) return { ...domain, keyword };
  }
  return undefined;
}

function matchStrongIntent(query: string): AgentConfig | undefined {
  return agents.find((agent) =>
    [agent.displayName, ...agent.aliases].some((alias) => query.includes(alias))
  );
}

function scoreAgent(agent: AgentConfig, input: RouteInput): number {
  let score = agent.priority / 100;
  const query = input.queryText;
  const domain = matchDomainIntent(query);
  if (domain?.agentId === agent.id) score += 5.5;

  if (agent.targetAgeGroups.includes(input.profile.ageGroup)) score += 1.1;
  if (agent.targetGenders.includes(input.profile.gender) || agent.targetGenders.includes("unknown")) {
    score += 0.4;
  }
  score += scoreFamilyContext(agent, input);

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

function buildCandidateReason(agent: AgentConfig, input: RouteInput, score: number): string {
  const reasons: string[] = [];
  const queryText = input.queryText;
  const matchedScenes = agent.serviceScenes.filter((scene) => {
    const keywords = sceneKeywords[scene] ?? [scene];
    return keywords.some((keyword) => queryText.includes(keyword));
  });
  if (matchedScenes.length > 0) {
    reasons.push(`query 场景「${matchedScenes.join("、")}」`);
  }
  if (agent.targetAgeGroups.includes(input.profile.ageGroup)) reasons.push(`年龄段 ${input.profile.ageGroup}`);
  if (agent.targetGenders.includes(input.profile.gender) || agent.targetGenders.includes("unknown")) reasons.push(`性别 ${input.profile.gender}`);
  if (input.familyRole && input.familyRole !== "unknown") reasons.push(`家庭角色 ${input.familyRole}`);
  if (input.timeSegment) reasons.push(`时间段 ${input.timeSegment}`);
  if (input.familyMemory?.agentUsage.some((item) => item.agentId === agent.id)) reasons.push("家庭常用 agent");
  return `${reasons.length ? reasons.join("、") : "默认优先级"}，召回 ${agent.displayName}，score=${score.toFixed(2)}`;
}

function scoreFamilyContext(agent: AgentConfig, input: RouteInput): number {
  let score = 0;
  const query = input.queryText;

  if (input.familyRole === "child" && agent.id === "little-fox") score += 0.9;
  if (["father", "mother", "elder"].includes(input.familyRole ?? "") && agent.id === "life-butler") score += 0.35;
  if (input.timeSegment === "night" && /(睡前|哄睡|故事|晚安)/.test(query) && agent.id === "little-fox") score += 1.4;
  if (input.timeSegment === "morning" && /(安排|计划|提醒|日程|今天)/.test(query) && agent.id === "life-butler") score += 0.9;
  if (input.timeSegment === "evening" && /(作业|复习|学习|英语)/.test(query) && agent.id === "study-coach") score += 0.7;

  const currentUserFavorite = input.familyMemory?.members
    .find((member) => member.userId && member.familyRole === input.familyRole)
    ?.favoriteAgents[0];
  if (currentUserFavorite?.agentId === agent.id) score += Math.min(0.6, currentUserFavorite.count * 0.08);

  const familyFavorite = input.familyMemory?.agentUsage[0];
  if (familyFavorite?.agentId === agent.id) score += Math.min(0.35, familyFavorite.count * 0.04);

  return score;
}

function toRouteCandidates(candidates: RouteCandidate[]): RouteOutput["candidates"] {
  return candidates.map((candidate) => ({
    agentId: candidate.agent.id,
    score: Number(candidate.score.toFixed(3)),
    reason: candidate.reason
  }));
}
