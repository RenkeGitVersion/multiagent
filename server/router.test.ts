import { strict as assert } from "node:assert";
import { routeAgentByRules } from "./router";
import type { RouteInput } from "../shared/types";

function route(queryText: string, ageGroup: RouteInput["profile"]["ageGroup"] = "adult") {
  return routeAgentByRules({
    queryText,
    profile: { ageGroup, gender: "male" },
    conversationContext: []
  });
}

function routeWithLock(queryText: string, lockedAgentId: string) {
  return routeAgentByRules({
    queryText,
    lockedAgentId,
    profile: { ageGroup: "adult", gender: "male" },
    conversationContext: []
  });
}

function routeFromCurrent(queryText: string, currentAgentId: string) {
  return routeAgentByRules({
    queryText,
    currentAgentId,
    profile: { ageGroup: "adult", gender: "male" },
    conversationContext: []
  });
}

assert.equal(route("我要学英语").agentId, "study-coach");
assert.equal(route("我想练口语和背单词").agentId, "study-coach");
assert.equal(route("我有点咳嗽").agentId, "doctor-chen");
assert.equal(route("我今天肚子有点痛。").agentId, "doctor-chen");
assert.equal(routeFromCurrent("我今天肚子有点痛。", "study-coach").agentId, "doctor-chen");
assert.equal(routeWithLock("我今天肚子有点痛。", "study-coach").agentId, "study-coach");
assert.equal(route("提醒小朋友一分钟后写作业").agentId, "life-butler");
assert.equal(route("帮我设定任务明天检查智能家居").agentId, "companion-lan");
assert.equal(route("把客厅空调打开").agentId, "companion-lan");
assert.equal(route("叫虎子给我讲故事").agentId, "little-fox");
assert.equal(route("我现在需要陪小孩").agentId, "little-fox");
assert.equal(routeWithLock("再讲一个", "little-fox").agentId, "little-fox");
assert.equal(routeWithLock("我今天身体不舒服", "little-fox").agentId, "little-fox");
assert.equal(routeWithLock("我今天身体不舒服", "study-coach").agentId, "study-coach");

console.log("router tests passed");
