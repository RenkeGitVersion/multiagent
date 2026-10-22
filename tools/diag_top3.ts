import { recallTopAgents } from "../server/router";
import type { RouteInput } from "../shared/types";

import { readFileSync } from "fs";
const gt = JSON.parse(readFileSync("/tmp/gt_real.json", "utf-8"));
const cases: Array<[string, string, string]> = [
  ["Q05", "teen", "有点睡不着，能陪我聊到困为止吗"],
  ["Q08", "teen", "给我讲个笑话逗逗我"],
  ["Q13", "child", "每天早上提醒我量血压"],
  ["Q18", "child", "降压药忘吃了怎么办"],
  ["Q38", "child", "今年退休金上调了多少"],
  ["Q41", "child", "三十五加二十七等于多少，我算不清"],
  ["Q41", "teen", "三十五加二十七等于多少，我算不清"],
  ["Q46", "child", "床前明月光这首诗是什么意思"],
  ["Q49", "child", "苹果的英语怎么说"],
  ["Q49", "adult", "苹果的英语怎么说"],
  ["Q50", "child", "孩子写作业总走神，怎么办"],
  ["Q50", "teen", "孩子写作业总走神，怎么办"],
  ["Q50", "adult", "孩子写作业总走神，怎么办"],
  ["Q01", "child", "陪我聊会儿天吧"],
];
for (const [qid, g, text] of cases) {
  const input: RouteInput = { queryText: text, profile: { ageGroup: g as any, gender: "unknown" }, conversationContext: [], scene: "", priorMode: "bayesian" };
  const bayes = recallTopAgents(input, 3).map(c => `${c.agent.id}:${c.score.toFixed(2)}`);
  input.priorMode = "heuristic";
  const heur = recallTopAgents(input, 3).map(c => `${c.agent.id}:${c.score.toFixed(2)}`);
  const gtRole = (gt.gt[qid] as any)[g]?.gt ?? "?";
  console.log(`${qid}@${g} GT=${gtRole}\n  bayes: ${bayes.join("  |  ")}\n  heur : ${heur.join("  |  ")}`);
}
