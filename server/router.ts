import { agents } from "./agents";
import { PRIOR_MATRIX, priorStrength, saturate, detectScene, MARGINAL_PRIOR, MARGINAL_BETA } from "./prior";
import type { AgentConfig, RouteInput, RouteOutput } from "../shared/types";

const sceneKeywords: Record<string, string[]> = {
  故事: ["故事", "童话", "睡前", "讲一个", "哄睡"],
  健康: ["健康", "医生", "症状", "发烧", "咳嗽", "用药", "体检", "疼", "痛", "肚子", "腹痛", "不舒服", "血压", "血糖", "吃药", "药", "头晕", "有点晕", "胃胀", "胀", "做梦", "睡不好", "睡不着", "失眠"],
  学习: ["学习", "学", "英语", "英文", "单词", "口语", "语法", "数学", "语文", "作业", "考试", "题目", "复习", "课程", "计划", "辅导", "算", "口算", "分数"],
  英语学习: ["英语", "英文", "口语", "单词", "发音"],
  提醒: ["提醒", "监督", "看电视", "时间到", "日程", "定时"],
  智能家居: ["智能家居", "开灯", "关灯", "空调", "电视", "窗帘", "扫地机器人", "家居", "灯", "灯光", "调暗", "调亮", "亮度"],
  通用任务: ["设定任务", "设置任务", "安排任务", "帮我记", "记一下", "待办", "todo", "通用问题"],
  陪伴: ["聊天", "心情", "难过", "无聊", "陪我", "孤独"],
  儿童陪伴: ["小孩", "孩子", "小朋友", "儿童", "宝宝", "陪小孩", "陪孩子", "带小孩", "带孩子", "哄孩子", "哄小孩", "监督"]
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
      reason: "20 秒内连续对话，保持当前智能体",
      confidence: 0.94,
      source: "session-lock"
    };
  }

  const candidates = recallTopAgents(input);

  // 召回置信早停：Top1 显著领先 Top2 时直接采用 Top1，跳过远程 LLM 裁决（延迟优化的关键路径）
  const earlyExitMargin = Number(process.env.LLM_EARLY_EXIT_MARGIN ?? 0);
  if (earlyExitMargin > 0 && candidates.length >= 2 && candidates[0].score - candidates[1].score >= earlyExitMargin) {
    const best = candidates[0];
    return {
      agentId: best.agent.id,
      intentStrength: "weak",
      reason: `${best.reason}；召回置信领先，早停直出`,
      confidence: Math.min(0.95, Math.max(0.6, best.score / 10)),
      source: "early-exit",
      candidates: toRouteCandidates(candidates)
    };
  }

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
      reason: "20 秒内连续对话，保持当前智能体",
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

  const startedAt = Date.now();
  try {
    const content = wireApi === "chat"
      ? await callChatCompletionsRouter(baseUrl, apiKey, model, input, candidates)
      : await callResponsesRouter(baseUrl, apiKey, model, input, candidates);
    if (!content) return undefined;
    const parsed = JSON.parse(content) as { agentId?: string; reason?: string; confidence?: number };
    if (!parsed.agentId || !candidates.some((candidate) => candidate.agent.id === parsed.agentId)) return undefined;
    console.info(`[Router] model route ${parsed.agentId} in ${Date.now() - startedAt}ms`);

    return {
      agentId: parsed.agentId,
      intentStrength: "weak",
      reason: `TOP3 候选后模型判断：${parsed.reason ?? "根据 query、用户画像和偏好候选选择"}`,
      confidence: Math.max(0.5, Math.min(0.98, parsed.confidence ?? 0.75)),
      source: "model",
      candidates: toRouteCandidates(candidates)
    };
  } catch (error) {
    console.info(`[Router] model route fallback in ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function callResponsesRouter(baseUrl: string, apiKey: string, model: string, input: RouteInput, candidates: RouteCandidate[]): Promise<string | undefined> {
  const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: process.env.LLM_ROUTER_REASONING_EFFORT ?? "minimal" },
      temperature: 0,
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
  const response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
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

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const timeoutMs = Number(process.env.LLM_ROUTER_TIMEOUT_MS ?? 4000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildRouterSystemPrompt(candidates: RouteCandidate[]): string {
  const candidateIds = candidates.map((candidate) => candidate.agent.id).join(", ");
  return [
    "你是多智能体系统的弱意图路由器。只输出 JSON，不要输出 Markdown。",
    `候选 agentId 只有：${candidateIds}。不要选择候选外的 agentId。`,
    "强唤醒词已在外层处理；这里处理自然语言弱意图。",
    "五个智能体为：little-fox=虎子（儿童陪伴），doctor-chen=健康顾问，study-coach=英语外教，life-butler=孙悟空（闲聊陪伴），companion-lan=豆包（通用助手）。",
    "角色选择规则（按 query 语义优先于 score）：",
    "- 儿童用户（ageGroup=child）的健康咨询、症状描述、用药/血压/血糖提醒 → little-fox；成人/中老年（adult/senior）的健康咨询 → doctor-chen；",
    "- 算术、口算、数学、古诗、语文、作文、百科等一般学习/知识问答 → companion-lan；英语口语对话、发音训练、英语作文 → study-coach；'XX用英语怎么说'仅儿童用户 → study-coach，其余 → companion-lan；",
    "- 涉及小朋友/孩子的陪伴、监督、提醒（陪玩、写作业、看电视） → little-fox；教孩子学习、孩子学习/教育类咨询 → companion-lan；",
    "- 儿童用户（ageGroup=child）的闲聊、陪伴、故事 → little-fox；",
    "- 故事、睡前、童话类请求 → little-fox（不受年龄限制）；",
    "- 灯光、空调、电视等设备控制类 → companion-lan；",
    "- 音乐、点歌类 → companion-lan；",
    "- 成人/中老年的普通闲聊陪伴 → companion-lan；孙悟空仅承接冒险、解谜、鼓励、西游主题等陪伴；",
    "- 一般定时提醒、待办、通用问题 → companion-lan；",
    "- 冒险、解谜、鼓励、西游类陪伴 → life-butler。",
    "score 仅为召回参考，以 query 语义与上述规则为准。",
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
  // domain 关键词比 scene 循环更严格：裸"孩子/小朋友/英语"等词在"教孩子/写作业/单词查询"
  // 等语境下语义不同，domain 强加分（+7）只用组合/明确词，避免教学、查询类 query 误入陪伴/外教域。
  const domainKeywords: Record<string, string[]> = {
    健康: ["健康", "医生", "症状", "发烧", "咳嗽", "体检", "血压", "血糖", "吃药", "用药", "疼", "痛"],
    儿童陪伴: ["陪小孩", "陪孩子", "陪小朋友", "带小孩", "带孩子", "哄孩子", "哄小孩", "监督", "陪陪"],
    智能家居: ["智能家居", "开灯", "关灯", "空调", "电视", "窗帘", "扫地机器人", "灯", "灯光", "调暗", "调亮", "亮度"],
    通用任务: ["设定任务", "设置任务", "安排任务", "帮我记", "记一下", "待办"],
    故事: ["故事", "童话", "哄睡"],
    英语学习: ["英语口语", "英语作文", "英语发音", "学英语", "英语学习", "背单词"],
    陪伴: ["陪我", "聊天", "唠嗑", "无聊", "心情", "难过", "孤独"]
  };
  const domainPriority = [
    { scene: "健康", agentId: "doctor-chen" },
    { scene: "儿童陪伴", agentId: "little-fox" },
    { scene: "智能家居", agentId: "companion-lan" },
    { scene: "通用任务", agentId: "companion-lan" },
    { scene: "故事", agentId: "little-fox" },
    { scene: "英语学习", agentId: "study-coach" },
    { scene: "陪伴", agentId: "companion-lan" }
  ];

  for (const domain of domainPriority) {
    const keywords = domainKeywords[domain.scene] ?? sceneKeywords[domain.scene];
    const keyword = keywords.find((item) => query.includes(item));
    if (keyword) return { ...domain, keyword };
  }
  return undefined;
}

function matchStrongIntent(query: string): AgentConfig | undefined {
  return agents.find((agent) =>
    [agent.displayName, ...agent.aliases].some((alias) => query.includes(alias))
  );
}

// 分层贝叶斯：能力似然 L_cap(a,q) + 情境似然 L_ctx(a,input)
function bayesLikelihood(agent: AgentConfig, input: RouteInput): { cap: number; ctx: number } {
  const query = input.queryText;
  const domain = matchDomainIntent(query);
  let raw = 0;
  if (domain?.agentId === agent.id) raw += 7;
  // 通用助手兜底：domain 命中时减半（专业角色占优但通用助手仍在场）
  if (query && agent.id === "companion-lan") raw += domain ? 0.5 : 1;
  for (const scene of agent.serviceScenes) {
    const keywords = sceneKeywords[scene] ?? [scene];
    if (keywords.some((keyword) => query.includes(keyword))) raw += 3.2;
  }
  for (const tag of agent.personaTags) {
    if (query.includes(tag)) raw += 1.2;
  }
  if (agent.targetAgeGroups.includes(input.profile?.ageGroup)) raw += 0.65;
  if (agent.targetGenders.includes(input.profile?.gender) || agent.targetGenders.includes("unknown")) raw += 0.2;
  // 情境信号（家庭角色/时段/儿童健康等产品设计原则）概率化
  const ctx = saturate(scoreFamilyContext(agent, input) * 2);
  return { cap: saturate(raw), ctx };
}

function scoreAgent(agent: AgentConfig, input: RouteInput): number {
  const query = input.queryText;
  const mode = input.priorMode ?? "heuristic";
  const scene = input.scene ?? detectScene(query);

  // 分层贝叶斯模式：score = 能力似然 + 情境似然 + β·角色边际先验 + λ(g,c)·问卷群体先验
  // 参数全部来自问卷与领域知识（不针对测试集调参）
  if (mode === "bayesian") {
    const { cap, ctx } = bayesLikelihood(agent, input);
    const cell = PRIOR_MATRIX[input.profile?.ageGroup]?.[scene ?? ""];
    const P0 = cell ? (cell[agent.id] ?? 0) / 100 : 0;
    return cap + ctx + MARGINAL_BETA * MARGINAL_PRIOR[agent.id] + priorStrength(input.profile?.ageGroup, scene) * P0;
  }

  let score = agent.priority / 100;
  const domain = matchDomainIntent(query);
  if (domain?.agentId === agent.id) score += 7;
  if (!domain && query && agent.id === "companion-lan") score += 1;

  if (agent.targetAgeGroups.includes(input.profile?.ageGroup)) score += 0.65;
  if (agent.targetGenders.includes(input.profile?.gender) || agent.targetGenders.includes("unknown")) {
    score += 0.2;
  }

  // 召回层评分模式：heuristic（默认/v5）、prior（仅问卷群体先验）、hybrid（启发式+先验融合）
  if (mode === "prior") {
    score += scorePrior(agent, input.profile?.ageGroup, scene);
  } else {
    score += scoreFamilyContext(agent, input);
    if (mode === "hybrid") {
      score += scorePrior(agent, input.profile?.ageGroup, scene);
    }
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
  if (agent.targetAgeGroups.includes(input.profile?.ageGroup)) reasons.push(`年龄段 ${input.profile?.ageGroup}`);
  if (agent.targetGenders.includes(input.profile?.gender) || agent.targetGenders.includes("unknown")) reasons.push(`性别 ${input.profile?.gender}`);
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
  if (input.timeSegment === "morning" && /(安排|计划|提醒|日程|今天)/.test(query) && agent.id === "companion-lan") score += 0.9;
  if (/(孩子|小朋友)/.test(query) && agent.id === "little-fox") score += 1.4;
  // 教育类咨询：教孩子/辅导/孩子学习等 → 通用助手（与 LLM 裁决规则"教孩子学习→companion-lan"对齐）
  if (/(教孩子|怎么教|辅导孩子|孩子教育|教育孩子|孩子学习|孩子写作业|走神|厌学)/.test(query) && agent.id === "companion-lan") score += 1.2;
  if (input.profile?.ageGroup === "child" && /(聊天|陪我|无聊|唠嗑|烦)/.test(query) && agent.id === "little-fox") score += 1.2;
  if (input.profile?.ageGroup === "child" && /(健康|发烧|咳嗽|肚子|头晕|胃胀|睡不着|做梦|吃药|血压|疼|痛|不舒服|作业|算术|数学|语文|古诗|口算|分数|学习|辅导)/.test(query) && agent.id === "little-fox") score += 1.2;
  if (input.timeSegment === "evening" && /(作业|复习|学习|英语)/.test(query) && agent.id === "study-coach") score += 0.7;

  const currentUserFavorite = input.familyMemory?.members
    .find((member) => Boolean(input.resolvedUserId) && member.userId === input.resolvedUserId)
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
