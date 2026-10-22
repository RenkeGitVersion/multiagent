import { strict as assert } from "node:assert";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FamilyMemory, getTimeSegment } from "./familyMemory";
import type { ReminderTask, SpeakerIdentity } from "../shared/types";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(projectRoot, "server", ".data");
const storePath = join(dataDir, "family-memory.json");

const identity: SpeakerIdentity = {
  userId: "family_user",
  displayName: "家庭用户",
  source: "identified",
  confidence: 0.92,
  quality: {
    ok: true,
    durationSeconds: 3,
    speechSeconds: 2.5,
    rms: 0.03,
    peak: 0.4,
    clippingRatio: 0,
    silenceRatio: 0.2,
    reasons: []
  }
};

async function withIsolatedStore(run: () => Promise<void>) {
  let backup: string | undefined;
  try {
    backup = await readFile(storePath, "utf8");
  } catch {
    backup = undefined;
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(storePath, JSON.stringify({ familyId: "local-family", members: [], sharedFacts: [], agentUsage: [], reminderHabits: [] }, null, 2), "utf8");
  try {
    await run();
  } finally {
    if (backup === undefined) {
      await rm(storePath, { force: true });
    } else {
      await writeFile(storePath, backup, "utf8");
    }
  }
}

assert.equal(getTimeSegment(new Date("2026-01-01T08:00:00")), "morning");
assert.equal(getTimeSegment(new Date("2026-01-01T21:00:00")), "evening");

await withIsolatedStore(async () => {
  const memory = new FamilyMemory();
  let snapshot = await memory.recordAgentUse({
    userId: "family_user",
    displayName: "家庭用户",
    familyRole: "father",
    agentId: "life-butler",
    memoryCount: 2
  });
  assert.equal(snapshot.members[0].familyRole, "father");
  assert.equal(snapshot.agentUsage[0].agentId, "life-butler");

  const task: ReminderTask = {
    taskId: "task-1",
    createdByAgentId: "life-butler",
    userId: "family_user",
    familyRole: "father",
    timeSegment: "evening",
    triggerAt: new Date().toISOString(),
    audience: "小朋友",
    message: "电视时间到啦，我们一起收好心情去写作业吧。",
    reminderAgentId: "little-fox",
    status: "scheduled"
  };
  await memory.recordReminderHabit(task);
  snapshot = await memory.getSnapshot("evening");
  assert.equal(snapshot.reminderHabits.length, 1);
  assert.equal(snapshot.reminderHabits[0].familyRole, "father");

  await memory.writeSharedIfAllowed({
    queryText: "记住我们家晚上要少看电视",
    speakerIdentity: identity
  });
  snapshot = await memory.getSnapshot("evening");
  assert.equal(snapshot.sharedFacts[0].text, "晚上要少看电视");

  await memory.recordAgentUse({
    userId: "other_user",
    displayName: "其他成员",
    familyRole: "mother",
    agentId: "companion-lan"
  });
  await memory.recordReminderHabit({
    ...task,
    taskId: "task-2",
    userId: "other_user",
    familyRole: "mother",
    audience: "其他成员"
  });
  const scopedSnapshot = await memory.getSnapshotForUser("family_user", "evening");
  assert.deepEqual(scopedSnapshot.members.map((member) => member.userId), ["family_user"]);
  assert.deepEqual(scopedSnapshot.reminderHabits.map((habit) => habit.userId), ["family_user"]);
});

await withIsolatedStore(async () => {
  const memory = new FamilyMemory();
  await Promise.all(Array.from({ length: 20 }, () => memory.recordAgentUse({
    userId: "concurrent_user",
    agentId: "life-butler"
  })));

  const snapshot = await memory.getSnapshot();
  assert.equal(snapshot.agentUsage.find((item) => item.agentId === "life-butler")?.count, 20);
  assert.equal(snapshot.members[0].favoriteAgents[0].count, 20);
});

await withIsolatedStore(async () => {
  const damaged = "{not valid json";
  await writeFile(storePath, damaged, "utf8");
  const memory = new FamilyMemory();

  await assert.rejects(() => memory.getSnapshot(), SyntaxError);
  await assert.rejects(() => memory.recordAgentUse({ agentId: "must-not-replace-damaged-data" }), SyntaxError);
  assert.equal(await readFile(storePath, "utf8"), damaged);
});

console.log("family memory tests passed");
