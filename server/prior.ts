import type { AgentConfig } from "../shared/types";

// 问卷群体先验 P(角色|用户组, 场景)：来自 125 份量表数据（Clean_Data_125），
// 5 型人格偏好评分 → softmax(T=0.5) → 角色标签加权映射。值为整数百分数。
// 注意：该先验仅描述“人格特质偏好”，GT 标注主要基于能力/功能匹配，两者语义不同，
// 因此本模块只作为附加信号（hybrid 模式）使用，不应单独替代能力/场景信号。
export const PRIOR_MATRIX: Record<string, Record<string, Record<string, number>>> = {
  child: {
    "休闲陪伴": { "little-fox": 48, "doctor-chen": 0, "study-coach": 14, "life-butler": 38, "companion-lan": 0 },
    "健康咨询": { "little-fox": 16, "doctor-chen": 36, "study-coach": 22, "life-butler": 19, "companion-lan": 7 },
    "智能家居": { "little-fox": 21, "doctor-chen": 15, "study-coach": 21, "life-butler": 21, "companion-lan": 21 },
    "信息查询": { "little-fox": 31, "doctor-chen": 3, "study-coach": 22, "life-butler": 32, "companion-lan": 12 },
    "学习辅导": { "little-fox": 26, "doctor-chen": 0, "study-coach": 35, "life-butler": 38, "companion-lan": 0 },
  },
  teen: {
    "休闲陪伴": { "little-fox": 60, "doctor-chen": 0, "study-coach": 2, "life-butler": 37, "companion-lan": 0 },
    "健康咨询": { "little-fox": 1, "doctor-chen": 48, "study-coach": 27, "life-butler": 1, "companion-lan": 23 },
    "智能家居": { "little-fox": 3, "doctor-chen": 39, "study-coach": 24, "life-butler": 2, "companion-lan": 32 },
    "信息查询": { "little-fox": 6, "doctor-chen": 33, "study-coach": 21, "life-butler": 5, "companion-lan": 34 },
    "学习辅导": { "little-fox": 8, "doctor-chen": 36, "study-coach": 28, "life-butler": 9, "companion-lan": 18 },
  },
  adult: {
    "休闲陪伴": { "little-fox": 61, "doctor-chen": 1, "study-coach": 1, "life-butler": 37, "companion-lan": 1 },
    "健康咨询": { "little-fox": 0, "doctor-chen": 48, "study-coach": 28, "life-butler": 0, "companion-lan": 24 },
    "智能家居": { "little-fox": 0, "doctor-chen": 46, "study-coach": 28, "life-butler": 0, "companion-lan": 26 },
    "信息查询": { "little-fox": 2, "doctor-chen": 33, "study-coach": 20, "life-butler": 1, "companion-lan": 44 },
    "学习辅导": { "little-fox": 4, "doctor-chen": 43, "study-coach": 27, "life-butler": 4, "companion-lan": 22 },
  },
  senior: {
    "休闲陪伴": { "little-fox": 24, "doctor-chen": 38, "study-coach": 8, "life-butler": 18, "companion-lan": 12 },
    "健康咨询": { "little-fox": 0, "doctor-chen": 84, "study-coach": 6, "life-butler": 0, "companion-lan": 9 },
    "智能家居": { "little-fox": 0, "doctor-chen": 37, "study-coach": 17, "life-butler": 0, "companion-lan": 46 },
    "信息查询": { "little-fox": 0, "doctor-chen": 11, "study-coach": 2, "life-butler": 0, "companion-lan": 87 },
    "学习辅导": { "little-fox": 7, "doctor-chen": 41, "study-coach": 22, "life-butler": 10, "companion-lan": 20 },
  },
};

// 先验分缩放：概率(0-1)×3，量级与 scoreFamilyContext 的可比（最大 3 分）
const PRIOR_SCALE = 3;

const SCENE_KEYWORDS: Record<string, string[]> = {
  休闲陪伴: ["聊", "陪", "故事", "睡不着", "无聊", "烦", "开心", "笑话", "歌", "唠"],
  健康咨询: ["健康", "血压", "血糖", "药", "症状", "疼", "痛", "发烧", "咳嗽", "胃", "头晕", "有点晕", "做梦", "不舒服", "体检", "医生", "膝盖"],
  智能家居: ["灯", "空调", "电视", "洗衣机", "加湿", "扫地", "烧水", "厨房", "卧室", "窗帘"],
  信息查询: ["天气", "堵", "新闻", "高铁", "票", "怎么", "超市", "雨", "伞", "退休", "股市", "菜"],
  学习辅导: ["作业", "学习", "英语", "口语", "作文", "辅导", "算", "口算", "分数", "古诗", "单词", "拼音", "数学", "语文", "复习"],
};

export function detectScene(query: string): string | undefined {
  let best: string | undefined;
  let bestHits = 0;
  let bestLen = 0;
  for (const [scene, kws] of Object.entries(SCENE_KEYWORDS)) {
    const hits = kws.filter((k) => query.includes(k)).length;
    const len = kws.reduce((s, k) => (query.includes(k) ? s + k.length : s), 0);
    // 命中数优先；同命中数取“命中关键词总长度更长”（更具体的场景）
    if (hits > bestHits || (hits === bestHits && hits > 0 && len > bestLen)) {
      best = scene; bestHits = hits; bestLen = len;
    }
  }
  return bestHits > 0 ? best : undefined;
}

export function scorePrior(agent: AgentConfig, ageGroup: string, scene?: string): number {
  const cell = PRIOR_MATRIX[ageGroup]?.[scene ?? ""];
  if (!cell) return 0;
  return (cell[agent.id] ?? 0) / 100 * PRIOR_SCALE;
}

// ===== 分层贝叶斯路由（HBPAR）=====
// score(a) = 能力似然 L(a,q) + λ(g,c)·问卷群体先验 P0(a|g,c)
// L ∈ [0,1) 由 v5 已验证的能力信号（领域/场景/persona/画像）概率化饱和得到；
// P0 ∈ [0,1] 来自 125 份问卷；λ(g,c) ∈ [0,1] 为先验证据强度（熵越低越可信）。
// 参数全部来自问卷与领域知识，不针对测试集调参。

// 先验证据强度 λ(g,c)：1 − 归一化熵（熵低=问卷一致=先验可信）
export function priorStrength(ageGroup: string, scene?: string): number {
  const cell = PRIOR_MATRIX[ageGroup]?.[scene ?? ""];
  if (!cell) return 0;
  const probs = Object.values(cell).map((v) => v / 100).filter((v) => v > 0);
  if (probs.length === 0) return 0;
  const entropy = -probs.reduce((s, p) => s + p * Math.log(p), 0);
  const maxEntropy = Math.log(probs.length);
  return 1 - entropy / maxEntropy; // 0~1
}

// 概率化饱和：raw 为能力信号原始分，映射到 [0,1)
// raw=0→0, 2→0.5, 4→0.75, 7→0.88, 11→0.94
export function saturate(raw: number): number {
  return 1 - Math.pow(0.5, raw / 2);
}

// ===== 分层贝叶斯第三层：角色边际先验 P(a) =====
// P(a) 为无条件角色边际先验，刻画“系统对各角色的默认领域定位与启用倾向”，
// 来自角色设计优先级（领域知识，非测试集数据），softmax(priority/50) 归一化：
//   虎子 0.287 / 健康顾问 0.235 / 英语外教 0.192 / 孙悟空 0.157 / 豆包 0.129
// 分层贝叶斯全式：score(a) = L(a,q) + L_ctx(a,input) + β·log P(a) + λ(g,c)·P0(a|g,c)
// 该层在能力信号与情境信号并列时提供稳定的默认排序（等价于 v5 中 priority 的概率化）。
export const MARGINAL_PRIOR: Record<string, number> = {
  "little-fox": 0.287,
  "doctor-chen": 0.235,
  "study-coach": 0.192,
  "life-butler": 0.157,
  "companion-lan": 0.129,
};
export const MARGINAL_BETA = 0.2;
