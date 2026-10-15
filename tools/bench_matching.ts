/**
 * bench_matching.ts — 3.5 方法有效性验证离线匹配跑分（无 ground truth，只输出两方法各自匹配结果）
 *
 * 模式 A（本方法）: 先验召回 TOP3 + LLM 裁决（recallTopAgents + 同一 gpt-5.5 / responses 接口），输入 query + 用户画像
 * 模式 B（纯 LLM）: 全部 5 个智能体直接交给 LLM 裁决（对照组），仅输入 query，无用户画像
 *
 * 说明：本机 Node fetch 直连 openoneapi 的 TLS 握手被重置（ECONNRESET），而 curl 直连可用，
 *       故 LLM 调用统一走 curl 子进程（--noproxy '*' 绕过失效代理配置），接口与配置不变。
 *
 * 输入画像：四类用户（child / teen / adult / senior）× gender=unknown，仅用于本方法
 * 输出：JSON + CSV + 汇总（query、场景、画像、方法、agentId、reason、延迟、source）
 *
 * 用法：
 *   npx tsx tools/bench_matching.ts --quick     # 3 条 × (1 画像本方法 + 1 纯LLM)（自检）
 *   npx tsx tools/bench_matching.ts             # 全量 50 条 × (4 画像本方法 + 1 纯LLM) = 250 次调用
 */
import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { recallTopAgents } from "../server/router";
import { agents } from "../server/agents";
import type { AgeGroup, RouteInput, AgentConfig } from "../shared/types";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "bench-output");
const quick = process.argv.includes("--quick");
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 6);
const LLM_TIMEOUT_MS = Number(process.env.BENCH_LLM_TIMEOUT_MS ?? 30000);

interface BenchQuery {
  id: string;
  scene: string;
  source: string;
  text: string;
}

const QUERIES: BenchQuery[] = [
  // 休闲陪伴
  { id: "Q01", scene: "休闲陪伴", source: "访谈转写", text: "陪我聊会儿天吧" },
  { id: "Q02", scene: "休闲陪伴", source: "访谈转写", text: "我想听个故事" },
  { id: "Q03", scene: "休闲陪伴", source: "访谈转写", text: "今天有点烦，陪我一下" },
  { id: "Q04", scene: "休闲陪伴", source: "访谈转写", text: "我现在需要陪陪小孩" },
  { id: "Q05", scene: "休闲陪伴", source: "研究者R1", text: "有点睡不着，能陪我聊到困为止吗" },
  { id: "Q06", scene: "休闲陪伴", source: "研究者R1", text: "今天心情不太好，说点开心的" },
  { id: "Q07", scene: "休闲陪伴", source: "研究者R2", text: "一个人在家好无聊，随便说说话吧" },
  { id: "Q08", scene: "休闲陪伴", source: "研究者R2", text: "给我讲个笑话逗逗我" },
  { id: "Q09", scene: "休闲陪伴", source: "研究者R1", text: "今天想听点歌放松一下" },
  { id: "Q10", scene: "休闲陪伴", source: "研究者R2", text: "晚上没事干，陪我唠唠嗑" },
  // 健康咨询
  { id: "Q11", scene: "健康咨询", source: "访谈转写", text: "我今天肚子有点痛" },
  { id: "Q12", scene: "健康咨询", source: "访谈转写", text: "我最近老是睡不着，怎么回事" },
  { id: "Q13", scene: "健康咨询", source: "访谈转写", text: "每天早上提醒我量血压" },
  { id: "Q14", scene: "健康咨询", source: "访谈转写", text: "这几天头有点晕，要不要紧" },
  { id: "Q15", scene: "健康咨询", source: "研究者R1", text: "咳嗽好几天了，吃点什么好" },
  { id: "Q16", scene: "健康咨询", source: "研究者R1", text: "有点发烧，是不是感冒了" },
  { id: "Q17", scene: "健康咨询", source: "研究者R2", text: "吃完饭老是胃胀，正常吗" },
  { id: "Q18", scene: "健康咨询", source: "研究者R2", text: "降压药忘吃了怎么办" },
  { id: "Q19", scene: "健康咨询", source: "研究者R1", text: "夜里老做梦睡不好，有啥办法" },
  { id: "Q20", scene: "健康咨询", source: "研究者R2", text: "膝盖有点疼，能热敷缓解吗" },
  // 智能家居
  { id: "Q21", scene: "智能家居", source: "访谈转写", text: "屋里有点暗" },
  { id: "Q22", scene: "智能家居", source: "访谈转写", text: "有点热，想开会儿空调" },
  { id: "Q23", scene: "智能家居", source: "访谈转写", text: "我出门了，客厅灯好像还亮着" },
  { id: "Q24", scene: "智能家居", source: "访谈转写", text: "电视声音好像没关" },
  { id: "Q25", scene: "智能家居", source: "研究者R1", text: "睡前想把卧室灯光调暗一点" },
  { id: "Q26", scene: "智能家居", source: "研究者R2", text: "洗衣机洗完了吗" },
  { id: "Q27", scene: "智能家居", source: "研究者R1", text: "房间有点干，开下加湿器吧" },
  { id: "Q28", scene: "智能家居", source: "研究者R2", text: "扫地机器人去扫下客厅" },
  { id: "Q29", scene: "智能家居", source: "研究者R1", text: "烧水壶还有多久开" },
  { id: "Q30", scene: "智能家居", source: "研究者R2", text: "厨房灯忘关了" },
  // 信息查询
  { id: "Q31", scene: "信息查询", source: "访谈转写", text: "今天天气怎么样" },
  { id: "Q32", scene: "信息查询", source: "访谈转写", text: "明天早上路上堵不堵" },
  { id: "Q33", scene: "信息查询", source: "访谈转写", text: "现在有什么新闻" },
  { id: "Q34", scene: "信息查询", source: "访谈转写", text: "周末去杭州的高铁票还有吗" },
  { id: "Q35", scene: "信息查询", source: "研究者R1", text: "西红柿炒鸡蛋怎么做" },
  { id: "Q36", scene: "信息查询", source: "研究者R2", text: "离我最近的超市在哪" },
  { id: "Q37", scene: "信息查询", source: "研究者R1", text: "明天会下雨吗，要不要带伞" },
  { id: "Q38", scene: "信息查询", source: "研究者R2", text: "今年退休金上调了多少" },
  { id: "Q39", scene: "信息查询", source: "研究者R1", text: "帮我查下明天股市几点开盘" },
  { id: "Q40", scene: "信息查询", source: "研究者R2", text: "晚上做点什么菜好，推荐两个" },
  // 学习辅导
  { id: "Q41", scene: "学习辅导", source: "访谈转写", text: "三十五加二十七等于多少，我算不清" },
  { id: "Q42", scene: "学习辅导", source: "访谈转写", text: "英语作文开头怎么写好" },
  { id: "Q43", scene: "学习辅导", source: "访谈转写", text: "帮我监督小朋友看电视" },
  { id: "Q44", scene: "学习辅导", source: "访谈转写", text: "提醒小朋友 20 分钟后写作业" },
  { id: "Q45", scene: "学习辅导", source: "研究者R1", text: "英语口语老说不好，怎么练" },
  { id: "Q46", scene: "学习辅导", source: "研究者R2", text: "床前明月光这首诗是什么意思" },
  { id: "Q47", scene: "学习辅导", source: "研究者R1", text: "怎么教孩子理解分数" },
  { id: "Q48", scene: "学习辅导", source: "研究者R2", text: "帮我出几道口算题练练" },
  { id: "Q49", scene: "学习辅导", source: "研究者R1", text: "苹果的英语怎么说" },
  { id: "Q50", scene: "学习辅导", source: "研究者R2", text: "孩子写作业总走神，怎么办" }
];

const PROFILES: Array<{ label: string; ageGroup: AgeGroup }> = [
  { label: "child(儿童<18)", ageGroup: "child" },
  { label: "teen(大学生18-24)", ageGroup: "teen" },
  { label: "adult(职场成人25-40)", ageGroup: "adult" },
  { label: "senior(中老年>40)", ageGroup: "senior" }
];

const GENDER = "unknown";

interface LLMResult {
  agentId: string;
  reason: string;
  confidence: number;
  latencyMs: number;
}

function buildRouterSystemPrompt(candidates: Array<{ agent: AgentConfig; score: number }>, mode: "guided" | "plain"): string {
  const candidateIds = candidates.map((c) => c.agent.id).join(", ");
  if (mode === "plain") {
    // 对照组（纯 LLM）：尽量干净的 prompt，不预置任何领域偏好规则；
    // 角色属性（displayName/personaTags/serviceScenes）由 user payload 提供，LLM 自行判断。
    return [
      "你是多智能体系统的弱意图路由器。只输出 JSON，不要输出 Markdown。",
      `候选 agentId 只有：${candidateIds}。不要选择候选外的 agentId。`,
      "强唤醒词已在外层处理；这里处理自然语言弱意图。",
      "根据用户 query 与候选角色描述（displayName、personaTags、serviceScenes、targetAgeGroups）选择最合适的角色。",
      "返回 JSON：{\"agentId\":\"...\",\"reason\":\"...\",\"confidence\":0.0}"
    ].join("\n");
  }
  return [
    "你是多智能体系统的弱意图路由器。只输出 JSON，不要输出 Markdown。",
    `候选 agentId 只有：${candidateIds}。不要选择候选外的 agentId。`,
    "强唤醒词已在外层处理；这里处理自然语言弱意图。",
    "五个智能体为：little-fox=虎子（儿童陪伴），doctor-chen=健康顾问，study-coach=英语外教，life-butler=孙悟空（闲聊陪伴），companion-lan=豆包（通用助手）。",
    "角色选择规则（按 query 语义优先于 score）：",
    "- 血压、血糖、吃药、症状、体检等健康管理类 → doctor-chen；",
    "- 灯光、空调、电视等设备控制类 → companion-lan；",
    "- 英语口语对话、发音训练、英语作文 → study-coach；'XX用英语怎么说'等单词查询、算术、语文、百科等一般学习/知识问答 → companion-lan；",
    "- 涉及小朋友/孩子的陪伴、监督、提醒（陪玩、写作业、看电视） → little-fox；教孩子学习、孩子学习/教育类咨询 → companion-lan；",
    "- 儿童用户（ageGroup=child）的闲聊、陪伴、故事 → little-fox；",
    "- 故事、睡前、童话类请求 → little-fox（不受年龄限制）；",
    "- 儿童用户（ageGroup=child）的健康咨询、睡眠问题、一般学习辅导（算术/语文/诗词/口算） → little-fox；英语口语类 → study-coach；",
    "- 音乐、点歌类 → companion-lan；",
    "- 成人/中老年的普通闲聊陪伴 → companion-lan；孙悟空仅承接冒险、解谜、鼓励、西游主题等陪伴；",
    "- 一般定时提醒、待办、通用问题 → companion-lan；",
    "- 冒险、解谜、鼓励、西游类陪伴 → life-butler。",
    "score 仅为召回参考，以 query 语义与上述规则为准。",
    "返回 JSON：{\"agentId\":\"...\",\"reason\":\"...\",\"confidence\":0.0}"
  ].join("\n");
}

function buildRouterPayload(queryText: string, profile: RouteInput["profile"] | undefined, candidates: Array<{ agent: AgentConfig; score: number }>) {
  const payload: Record<string, unknown> = {
    queryText,
    candidateAgents: candidates.map((c, index) => ({
      rank: index + 1,
      score: Number(c.score.toFixed(3)),
      id: c.agent.id,
      displayName: c.agent.displayName,
      personaTags: c.agent.personaTags,
      serviceScenes: c.agent.serviceScenes,
      targetAgeGroups: c.agent.targetAgeGroups
    }))
  };
  // 对照组（纯 LLM）拿不到用户画像：payload 不含 profile 字段
  if (profile) payload.profile = profile;
  return payload;
}

/** LLM 裁决（curl 子进程，绕过 Node fetch 的 TLS 拦截；接口与 demo 的 Responses API 完全一致） */
async function callRouterLLM(queryText: string, profile: RouteInput["profile"] | undefined, candidates: Array<{ agent: AgentConfig; score: number }>, mode: "guided" | "plain" = "plain"): Promise<LLMResult | undefined> {
  const apiKey = process.env.LLM_ROUTER_API_KEY;
  const baseUrl = process.env.LLM_ROUTER_BASE_URL;
  const model = process.env.LLM_ROUTER_MODEL;
  if (!apiKey || !baseUrl || !model) throw new Error("缺少 LLM_ROUTER_API_KEY/BASE_URL/MODEL 配置");

  const body = JSON.stringify({
    model,
    reasoning: { effort: process.env.LLM_ROUTER_REASONING_EFFORT ?? "minimal" },
    max_output_tokens: Number(process.env.LLM_ROUTER_MAX_OUTPUT_TOKENS ?? 80),
    store: false,
    input: [
      { role: "system", content: buildRouterSystemPrompt(candidates, mode) },
      { role: "user", content: JSON.stringify(buildRouterPayload(queryText, profile, candidates)) }
    ]
  });
  const url = `${baseUrl.replace(/\/$/, "")}/responses`;

  const startedAt = Date.now();
  const { stdout, stderr } = await execFileP("curl", [
    "-sS",
    "--noproxy", "*",
    "--max-time", String(Math.ceil(LLM_TIMEOUT_MS / 1000)),
    "-X", "POST",
    url,
    "-H", `Authorization: Bearer ${apiKey}`,
    "-H", "Content-Type: application/json",
    "-d", body
  ], { maxBuffer: 2 * 1024 * 1024 }).catch((error: Error & { stderr?: string; stdout?: string }) => {
    if (error instanceof Error && "stdout" in error) {
      // curl 失败但可能有部分输出（如超时前返回 200 后连接中断）
      return { stdout: (error as { stdout?: string }).stdout ?? "", stderr: (error as { stderr?: string }).stderr ?? "" };
    }
    throw error;
  });
  const latencyMs = Date.now() - startedAt;
  if (!stdout) {
    console.warn(`[LLM] curl 无输出 (${latencyMs}ms): ${stderr.slice(0, 200)}`);
    return undefined;
  }
  try {
    const payload = JSON.parse(stdout) as { output_text?: string; output?: Array<{ content?: Array<{ text?: string; output_text?: string; type?: string }> }> };
    const content = payload.output?.flatMap((item) => item.content ?? []);
    const raw = payload.output_text ?? content?.find((item) => item.output_text)?.output_text ?? content?.find((item) => item.text)?.text;
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { agentId?: string; reason?: string; confidence?: number };
    if (!parsed.agentId || !candidates.some((c) => c.agent.id === parsed.agentId)) return undefined;
    return { agentId: parsed.agentId, reason: parsed.reason ?? "", confidence: parsed.confidence ?? 0.75, latencyMs };
  } catch {
    console.warn(`[LLM] 响应解析失败 (${latencyMs}ms): ${stdout.slice(0, 200)}`);
    return undefined;
  }
}

/** 模式 A：本方法 = 先验召回 TOP3 + LLM 裁决；LLM 失败回退 TOP3 首位 */
async function runOwnMethod(query: BenchQuery, ageGroup: AgeGroup): Promise<{ agentId: string; reason: string; latencyMs: number; source: string }> {
  const input: RouteInput = {
    queryText: query.text,
    profile: { ageGroup, gender: GENDER },
    conversationContext: []
  };
  const candidates = recallTopAgents(input, 3);
  const modelRoute = await callRouterLLM(query.text, { ageGroup, gender: GENDER }, candidates, "guided");
  if (modelRoute) {
    return { agentId: modelRoute.agentId, reason: modelRoute.reason, latencyMs: modelRoute.latencyMs, source: "model" };
  }
  const best = candidates[0];
  return {
    agentId: best.agent.id,
    reason: `${best.reason}；LLM 不可用，TOP3 候选兜底选择 ${best.agent.displayName}`,
    latencyMs: 0,
    source: "rule-fallback"
  };
}

/** 模式 B：纯 LLM = 全部 5 个智能体直接交给 LLM 裁决，仅输入 query（无用户画像，无领域规则） */
async function runPureLLM(query: BenchQuery): Promise<{ agentId: string; reason: string; latencyMs: number; source: string }> {
  const allCandidates = agents.map((agent) => ({ agent, score: 0 }));
  const result = await callRouterLLM(query.text, undefined, allCandidates, "plain");
  if (!result) throw new Error(`纯 LLM 裁决失败：${query.id}`);
  return { agentId: result.agentId, reason: result.reason, latencyMs: result.latencyMs, source: "pure-llm" };
}

interface BenchRow {
  编号: string;
  场景: string;
  来源: string;
  query: string;
  画像: string;
  方法: string;
  agentId: string;
  延迟ms: string;
  source: string;
  reason: string;
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<Array<{ ok: true; value: T } | { ok: false; error: string }>> {
  const results: Array<{ ok: true; value: T } | { ok: false; error: string }> = new Array(tasks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { ok: true, value: await tasks[index]() };
      } catch (error) {
        results[index] = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

async function main() {
  const runQueries = quick ? QUERIES.slice(0, 3) : QUERIES;
  const runProfiles = quick ? PROFILES.slice(0, 1) : PROFILES;

  const tasks: Array<() => Promise<void>> = [];
  const rows: BenchRow[] = [];
  // 本方法：query × 画像；纯 LLM：query（无画像，每 query 1 次）
  const total = runQueries.length * (runProfiles.length + 1);

  let i = 0;
  const startedAt = Date.now();
  for (const query of runQueries) {
    for (const profile of runProfiles) {
      const idx = i;
      i += 1;
      tasks.push(async () => {
        try {
          const out = await runOwnMethod(query, profile.ageGroup);
          rows.push({
            编号: query.id, 场景: query.scene, 来源: query.source, query: query.text, 画像: profile.label,
            方法: "本方法(先验TOP3+LLM)",
            agentId: out.agentId, 延迟ms: String(out.latencyMs), source: out.source, reason: out.reason
          });
          console.log(`[${idx + 1}/${total}] ${query.id} ${profile.label} 本方法 -> ${out.agentId} (${out.latencyMs}ms)`);
        } catch (error) {
          rows.push({
            编号: query.id, 场景: query.scene, 来源: query.source, query: query.text, 画像: profile.label,
            方法: "本方法(先验TOP3+LLM)",
            agentId: "ERROR", 延迟ms: "", source: "error",
            reason: error instanceof Error ? error.message : String(error)
          });
          console.error(`[${idx + 1}/${total}] ${query.id} ${profile.label} 本方法 FAILED: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
    // 纯 LLM：仅 query，无画像
    const idx = i;
    i += 1;
    tasks.push(async () => {
      try {
        const out = await runPureLLM(query);
        rows.push({
          编号: query.id, 场景: query.scene, 来源: query.source, query: query.text, 画像: "无画像输入",
          方法: "纯LLM(全部角色)",
          agentId: out.agentId, 延迟ms: String(out.latencyMs), source: out.source, reason: out.reason
        });
        console.log(`[${idx + 1}/${total}] ${query.id} 无画像 纯LLM -> ${out.agentId} (${out.latencyMs}ms)`);
      } catch (error) {
        rows.push({
          编号: query.id, 场景: query.scene, 来源: query.source, query: query.text, 画像: "无画像输入",
          方法: "纯LLM(全部角色)",
          agentId: "ERROR", 延迟ms: "", source: "error",
          reason: error instanceof Error ? error.message : String(error)
        });
        console.error(`[${idx + 1}/${total}] ${query.id} 无画像 纯LLM FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  await runWithConcurrency(tasks, CONCURRENCY);
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n全部完成，耗时 ${elapsedSec}s`);

  const failed = rows.filter((r) => r.agentId === "ERROR").length;
  const summary = summarize(rows);
  const payload = { generatedAt: new Date().toISOString(), total, failed, elapsedSec, results: rows, summary };
  const jsonPath = join(OUT_DIR, `matching-${quick ? "quick" : "full"}.json`);
  const csvPath = join(OUT_DIR, `matching-${quick ? "quick" : "full"}.csv`);
  const summaryPath = join(OUT_DIR, `summary-${quick ? "quick" : "full"}.txt`);
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  writeFileSync(csvPath, toCsv(rows), "utf8");
  writeFileSync(summaryPath, summary, "utf8");
  console.log(`\n结果已写出：\n${jsonPath}\n${csvPath}\n${summaryPath}\n`);
  console.log(summary);
}

function summarize(rows: BenchRow[]): string {
  const byMethod = new Map<string, Map<string, number>>();
  const byQuery = new Map<string, Set<string>>();
  const methodLatency = new Map<string, number[]>();
  for (const row of rows) {
    if (row.agentId === "ERROR") continue;
    if (!byMethod.has(row.方法)) byMethod.set(row.方法, new Map());
    const m = byMethod.get(row.方法)!;
    m.set(row.agentId, (m.get(row.agentId) ?? 0) + 1);
    if (!byQuery.has(row.编号)) byQuery.set(row.编号, new Set());
    byQuery.get(row.编号)!.add(row.agentId);
    if (!methodLatency.has(row.方法)) methodLatency.set(row.方法, []);
    if (row.延迟ms) methodLatency.get(row.方法)!.push(Number(row.延迟ms));
  }
  const lines: string[] = ["===== 匹配结果汇总（无 ground truth，仅供参考）====="];
  for (const [method, counts] of byMethod) {
    const totalN = [...counts.values()].reduce((a, b) => a + b, 0);
    const lat = methodLatency.get(method) ?? [];
    const avgLat = lat.length ? (lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(0) : "-";
    const p50 = lat.length ? [...lat].sort((a, b) => a - b)[Math.floor(lat.length / 2)] : "-";
    lines.push(`\n[${method}] 有效判定 ${totalN} 次，平均延迟 ${avgLat}ms，P50 ${p50}ms：`);
    for (const [agent, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${agent}: ${count} (${((count / totalN) * 100).toFixed(1)}%)`);
    }
  }
  const diffQueries = [...byQuery.entries()].filter(([, set]) => set.size > 1).map(([qid]) => qid);
  lines.push(`\n同一 query 在不同画像下出现不同匹配结果的 query 数：${diffQueries.length}`);
  if (diffQueries.length) lines.push(`  编号：${diffQueries.join(", ")}`);
  return lines.join("\n");
}

function toCsv(rows: BenchRow[]): string {
  const header: Array<keyof BenchRow> = ["编号", "场景", "来源", "query", "画像", "方法", "agentId", "延迟ms", "source", "reason"];
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return [header.join(","), ...rows.map((r) => header.map((h) => escape(r[h])).join(","))].join("\n");
}

main().catch((error) => {
  console.error("bench 失败：", error);
  process.exit(1);
});
