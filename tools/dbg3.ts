import { agents } from "../server/agents";
import { detectScene } from "../server/prior";
// 复制 router.ts 的 sceneKeywords 与 matchDomainIntent 核心逻辑做单步验证
const sceneKeywords: Record<string, string[]> = {
  故事: ["故事", "童话", "睡前", "讲一个", "哄睡"],
  健康: ["健康", "医生", "症状", "发烧", "咳嗽", "用药", "体检", "疼", "痛", "肚子", "腹痛", "不舒服", "血压", "血糖", "吃药", "药", "头晕", "胃胀", "胀", "做梦", "睡不好", "睡不着", "失眠"],
  学习: ["学习", "学", "英语", "英文", "单词", "口语", "语法", "数学", "语文", "作业", "考试", "题目", "复习", "课程", "计划", "辅导"],
  英语学习: ["英语", "英文", "口语", "单词", "发音"],
  提醒: ["提醒", "监督", "看电视", "时间到", "日程", "定时"],
  智能家居: ["智能家居", "开灯", "关灯", "空调", "电视", "窗帘", "扫地机器人", "家居", "灯", "灯光", "调暗", "调亮", "亮度"],
  通用任务: ["设定任务", "设置任务", "安排任务", "帮我记", "记一下", "待办", "todo", "通用问题"],
  陪伴: ["聊天", "心情", "难过", "无聊", "陪我", "孤独"],
  儿童陪伴: ["小孩", "孩子", "小朋友", "儿童", "宝宝", "陪小孩", "陪孩子", "带小孩", "带孩子", "哄孩子", "哄小孩", "监督"]
};
const q = "早上起来头有点晕";
const dc = agents.find((a) => a.id === "doctor-chen")!;
console.log("doctor-chen serviceScenes:", dc.serviceScenes);
console.log("头晕 in query:", q.includes("头晕"));
for (const scene of dc.serviceScenes) {
  const kws = sceneKeywords[scene] ?? [scene];
  const hit = kws.filter((k) => q.includes(k));
  console.log(`  scene=${scene}: hits=${hit.length} [${hit.join(",")}]`);
}
const lf = agents.find((a) => a.id === "little-fox")!;
console.log("\nlittle-fox serviceScenes:", lf.serviceScenes);
for (const scene of lf.serviceScenes) {
  const kws = sceneKeywords[scene] ?? [scene];
  const hit = kws.filter((k) => q.includes(k));
  console.log(`  scene=${scene}: hits=${hit.length} [${hit.join(",")}]`);
}
console.log("\ndetectScene:", detectScene(q));
