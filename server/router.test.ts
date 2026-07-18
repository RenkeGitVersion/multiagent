import { strict as assert } from "node:assert";
import { recallTopAgents, routeAgentByRules } from "./router";
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

assert.equal(route("我要学英语").agentId, "study-coach");
assert.equal(route("我想练口语和背单词").agentId, "study-coach");
assert.equal(route("我有点咳嗽").agentId, "doctor-chen");
assert.equal(route("提醒小朋友一分钟后写作业").agentId, "life-butler");
assert.equal(route("叫虎子给我讲故事").agentId, "little-fox");
assert.equal(routeWithLock("再讲一个", "little-fox").agentId, "little-fox");
assert.equal(routeWithLock("我今天身体不舒服", "little-fox").agentId, "little-fox");

const reminderCandidates = recallTopAgents({
  queryText: "提醒小朋友一分钟后写作业",
  profile: { ageGroup: "adult", gender: "male" },
  conversationContext: []
});
assert.equal(reminderCandidates.length, 3);
assert.equal(reminderCandidates[0].agent.id, "life-butler");

const bedtimeCandidates = recallTopAgents({
  queryText: "睡前讲个故事",
  profile: { ageGroup: "child", gender: "unknown" },
  familyRole: "child",
  timeSegment: "night",
  conversationContext: []
});
assert.equal(bedtimeCandidates[0].agent.id, "little-fox");

console.log("router tests passed");
