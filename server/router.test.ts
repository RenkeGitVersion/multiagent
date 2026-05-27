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

assert.equal(route("我要学英语").agentId, "study-coach");
assert.equal(route("我想练口语和背单词").agentId, "study-coach");
assert.equal(route("我有点咳嗽").agentId, "doctor-chen");
assert.equal(route("提醒小朋友一分钟后写作业").agentId, "life-butler");
assert.equal(route("叫小狐狸给我讲故事").agentId, "little-fox");

console.log("router tests passed");
