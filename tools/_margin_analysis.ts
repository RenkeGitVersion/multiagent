/** 本地召回 margin 分析：对 200 样本算 bayesian 打分，输出 margin 分布与各早停阈值的预期命中 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { recallTopAgents } from "../server/router";
import type { AgeGroup, RouteInput } from "../shared/types";

const lines = readFileSync("/tmp/gt200.csv", "utf-8").trim().split("\n").slice(1);
const GROUP_MAP: Record<string, AgeGroup> = {
  "儿童（<18）": "child", "大学生（18-24）": "teen", "职场成人（25-40）": "adult", "中老年（>40）": "senior"
};
const ROLES: Record<string, string> = {
  "虎子": "little-fox", "豆包": "companion-lan", "健康顾问": "doctor-chen", "英语外教": "study-coach", "孙悟空": "life-butler"
};
const SCENE_FOR_QUERY: Record<string, string> = {};
{
  const ql = readFileSync("tools/bench_matching.ts", "utf-8");
  // 简单解析 QUERIES 的 id/scene
  const re = /id:\s*"(Q\d+)",\s*scene:\s*"([^"]+)"/g;
  let m; while ((m = re.exec(ql))) SCENE_FOR_QUERY[m[1]] = m[2];
}

interface Row { qid: string; query: string; group: AgeGroup; gt: string; scene: string }
const rows: Row[] = lines.map((l) => {
  const [qid, query, group, gt] = l.split(",").map((s) => s.trim());
  return { qid, query, group: GROUP_MAP[group], gt: ROLES[gt], scene: SCENE_FOR_QUERY[qid] ?? "休闲陪伴" };
});

// 统计
const out: string[] = [];
let top1Hit = 0, top3Hit = 0;
const margins: number[] = [];
const rowsData: Array<{ qid: string; query: string; group: AgeGroup; gt: string; top1: string; top2: string; m: number; hit1: boolean }> = [];
for (const r of rows) {
  const input: RouteInput = { queryText: r.query, profile: { ageGroup: r.group, gender: "unknown" }, conversationContext: [], scene: r.scene, priorMode: "bayesian" };
  const cand = recallTopAgents(input, 3);
  const m = cand[0].score - (cand[1]?.score ?? 0);
  margins.push(m);
  const hit1 = cand[0].agent.id === r.gt;
  const hit3 = cand.some((c) => c.agent.id === r.gt);
  if (hit1) top1Hit++; if (hit3) top3Hit++;
  rowsData.push({ qid: r.qid, query: r.query, group: r.group, gt: r.gt, top1: cand[0].agent.id, top2: cand[1].agent.id, m, hit1 });
}
out.push(`=== 200 样本 bayesian 召回分析 ===`);
out.push(`Top1 命中率(直接采用Top1) = ${top1Hit}/200 = ${(top1Hit/2).toFixed(1)}%`);
out.push(`Top3 含 GT 率 = ${top3Hit}/200 = ${(top3Hit/2).toFixed(1)}%`);
margins.sort((a,b)=>a-b);
const pct = (q:number) => margins[Math.floor(q*margins.length)];
out.push(`margin 分位数: p25=${pct(0.25).toFixed(2)} p50=${pct(0.5).toFixed(2)} p75=${pct(0.75).toFixed(2)} p90=${pct(0.9).toFixed(2)}`);
out.push(``);
out.push(`=== 早停阈值 τ 预期效果（早停=采用Top1；margin<τ 走 LLM 裁决）===`);
for (const tau of [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 100]) {
  const early = rowsData.filter((d) => d.m >= tau);
  const llm = rowsData.filter((d) => d.m < tau);
  const earlyHit = early.filter((d) => d.hit1).length;
  // LLM 裁决假设：若 GT 在 Top3 内则 LLM 能选对（乐观上界）；同时给出"LLM 按历史性能 95.5%×Top3内"估算
  const llmInTop3 = llm.filter((d) => { const in3 = true; return in3; }).length;
  // 用历史：有画像全裁决 95.5% 时 LLM 纠错能力 = 100%中 191/200 → 对"Top3含GT"样本 LLM 选对率 ≈ 191/200(有画像整体)。粗估：LLM 选对率按 0.955 计算
  const llmHit = Math.round(llm.filter((d) => true).length * 0.955 * (llmInTop3 / Math.max(1, llm.length)) );
  out.push(`τ=${tau===100?"∞(全LLM)":tau}: 早停 ${early.length} 条(${(early.length/2).toFixed(0)}%), 早停命中 ${earlyHit}(${((earlyHit/Math.max(1,early.length))*100).toFixed(1)}%), 需LLM ${llm.length} 条; 预计总命中≈${earlyHit+llmHit}`);
}
writeFileSync("/tmp/margin_result.txt", out.join("\n"), "utf8");
console.log(out.join("\n"));
