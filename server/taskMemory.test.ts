import { strict as assert } from "node:assert";
import { extractReminder } from "./taskMemory";

const digitReminder = extractReminder("提醒小朋友1分钟后写作业", "life-butler");
assert.ok(digitReminder);
assert.equal(digitReminder.audience, "小朋友");
assert.equal(digitReminder.reminderAgentId, "little-fox");

const chineseReminder = extractReminder("提醒小朋友一分钟后写作业", "life-butler");
assert.ok(chineseReminder);
assert.equal(chineseReminder.audience, "小朋友");
assert.equal(chineseReminder.reminderAgentId, "little-fox");

const secondReminder = extractReminder("提醒我三秒后看一下", "life-butler");
assert.ok(secondReminder);
assert.equal(secondReminder.audience, "用户");

console.log("task memory tests passed");
