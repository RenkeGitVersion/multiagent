import { agents } from "./agents";
import type { AgentConfig, RouteInput, RouteOutput } from "../shared/types";

const sceneKeywords: Record<string, string[]> = {
  故事: ["故事", "童话", "睡前", "讲一个", "哄睡"],
  健康: ["健康", "医生", "症状", "发烧", "咳嗽", "用药", "体检", "疼"],
  学习: ["学习", "学", "英语", "英文", "单词", "口语", "语法", "数学", "语文", "作业", "考试", "题目", "复习", "课程", "计划", "辅导"],
  提醒: ["提醒", "监督", "看电视", "时间到", "日程", "定时"],
  陪伴: ["聊天", "心情", "难过", "无聊", "陪我", "孤独"]
};

export async function routeAgent(input: RouteInput): Promise<RouteOutput> {
  const strong = routeStrongIntent(input.queryText.trim());
  if (strong) return strong;

  const modelRoute = await routeWithModel(input);
  if (modelRoute) return modelRoute;

  return routeAgentByRules(input);
}

export function routeAgentByRules(input: RouteInput): RouteOutput {
  const query = input.queryText.trim();
  const strong = routeStrongIntent(query);
  if (strong) return strong;

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

  const scored = agents
    .map((agent) => ({ agent, score: scoreAgent(agent, input) }))
    .sort((a, b) => b.score - a.score || b.agent.priority - a.agent.priority);

  const best = scored[0];
  const confidence = Math.min(0.92, Math.max(0.52, best.score / 10));
  return {
    agentId: best.agent.id,
    intentStrength: "weak",
    reason: buildWeakReason(best.agent, input.queryText),
    confidence,
    source: "rule-fallback"
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

async function routeWithModel(input: RouteInput): Promise<RouteOutput | undefined> {
  const apiKey = process.env.LLM_ROUTER_API_KEY;
  const baseUrl = process.env.LLM_ROUTER_BASE_URL;
  const model = process.env.LLM_ROUTER_MODEL;
  const wireApi = process.env.LLM_ROUTER_WIRE_API ?? "responses";
  if (!apiKey || !baseUrl || !model) return undefined;

  try {
    const content = wireApi === "chat"
      ? await callChatCompletionsRouter(baseUrl, apiKey, model, input)
      : await callResponsesRouter(baseUrl, apiKey, model, input);
    if (!content) return undefined;
    const parsed = JSON.parse(content) as { agentId?: string; reason?: string; confidence?: number };
    if (!parsed.agentId || !agents.some((agent) => agent.id === parsed.agentId)) return undefined;

    return {
      agentId: parsed.agentId,
      intentStrength: "weak",
      reason: `模型判断：${parsed.reason ?? "根据 query 和用户画像选择"}`,
      confidence: Math.max(0.5, Math.min(0.98, parsed.confidence ?? 0.75)),
      source: "model"
    };
  } catch {
    return undefined;
  }
}

async function callResponsesRouter(baseUrl: string, apiKey: string, model: string, input: RouteInput): Promise<string | undefined> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: process.env.LLM_ROUTER_REASONING_EFFORT ?? "high" },
      store: false,
      input: [
        {
          role: "system",
          content: buildRouterSystemPrompt()
        },
        {
          role: "user",
          content: JSON.stringify(buildRouterPayload(input))
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

async function callChatCompletionsRouter(baseUrl: string, apiKey: string, model: string, input: RouteInput): Promise<string | undefined> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildRouterSystemPrompt() },
        { role: "user", content: JSON.stringify(buildRouterPayload(input)) }
      ]
    })
  });
  if (!response.ok) return undefined;
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return payload.choices?.[0]?.message?.content;
}

function buildRouterSystemPrompt(): string {
  return [
    "你是多智能体系统的弱意图路由器。只输出 JSON，不要输出 Markdown。",
    "候选 agentId 只有：little-fox, doctor-chen, study-coach, life-butler, companion-lan。",
    "强唤醒词已在外层处理；这里处理自然语言弱意图。",
    "定时、监督、提醒类任务优先选择 life-butler。",
    "学习语言、作业、课程、考试、题目、学习计划选择 study-coach。",
    "症状、健康、用药、体检选择 doctor-chen。",
    "故事、睡前、儿童陪伴选择 little-fox。",
    "情绪、闲聊、陪伴选择 companion-lan。",
    "返回 JSON：{\"agentId\":\"...\",\"reason\":\"...\",\"confidence\":0.0}"
  ].join("\n");
}

function buildRouterPayload(input: RouteInput) {
  return {
    queryText: input.queryText,
    profile: input.profile,
    currentAgentId: input.currentAgentId,
    agents: agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      personaTags: agent.personaTags,
      serviceScenes: agent.serviceScenes,
      targetAgeGroups: agent.targetAgeGroups
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

  if (agent.targetAgeGroups.includes(input.profile.ageGroup)) score += 1.1;
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
