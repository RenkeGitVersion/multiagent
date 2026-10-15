import { recallTopAgents } from "../server/router";

const cases = [
  { q: "每天早上提醒我量血压", scene: "健康咨询" },
  { q: "睡前想把卧室灯光调暗一点", scene: "智能家居" },
];
const profiles = ["child", "teen", "adult", "senior"];
for (const c of cases) {
  for (const ageGroup of profiles) {
    const input: any = { queryText: c.q, profile: { ageGroup, gender: "unknown" } };
    const cands = recallTopAgents(input, 3);
    console.log(`[${c.scene}] ${c.q} @${ageGroup}:`);
    cands.forEach((x) => console.log(`   ${x.agent.displayName} score=${x.score.toFixed(2)} | scenes=${x.agent.serviceScenes.join("/")} | reason=${x.reason}`));
  }
}
