import { strict as assert } from "node:assert";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserMemory } from "./userMemory";
import type { SpeakerIdentity } from "../shared/types";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(projectRoot, "server", ".data");
const storePath = join(dataDir, "user-memory.json");

const identity: SpeakerIdentity = {
  userId: "user_a",
  source: "identified",
  confidence: 0.9,
  quality: {
    ok: true,
    durationSeconds: 3,
    speechSeconds: 2.4,
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
  await writeFile(storePath, JSON.stringify({ records: [] }, null, 2), "utf8");
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

await withIsolatedStore(async () => {
  const memory = new UserMemory();
  const first = await memory.writeIfAllowed({
    userId: "user_a",
    queryText: "记住我喜欢科幻故事",
    speakerIdentity: identity
  });
  assert.equal(first?.userId, "user_a");
  assert.equal(first?.preferences.length, 1);

  const other = await memory.getSnapshot("user_b");
  assert.equal(other.preferences.length, 0);
  assert.equal(other.facts.length, 0);

  const blocked = await memory.writeIfAllowed({
    userId: "user_a",
    queryText: "记住我喜欢数学",
    speakerIdentity: { ...identity, source: "unknown", confidence: 0 },
  });
  assert.equal(blocked, undefined);

  const optOut = await memory.writeIfAllowed({
    userId: "user_a",
    queryText: "记住以后叫我阿仁",
    speakerIdentity: identity,
    memoryOptOut: true
  });
  assert.equal(optOut, undefined);

  const cleared = await memory.clear("user_a");
  assert.equal(cleared.preferences.length, 0);
  assert.equal(cleared.facts.length, 0);
});

console.log("user memory tests passed");
