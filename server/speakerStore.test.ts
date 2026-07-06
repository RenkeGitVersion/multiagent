import { strict as assert } from "node:assert";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeCentroid, cosineSimilarity, SpeakerStore } from "./speakerStore";
import type { VoiceQuality } from "../shared/types";
import type { SpeakerEmbeddingResult } from "./speakerRecognition";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = join(projectRoot, "server", ".data");
const storePath = join(dataDir, "speaker-profiles.json");

const okQuality: VoiceQuality = {
  ok: true,
  durationSeconds: 3,
  speechSeconds: 2.4,
  rms: 0.03,
  peak: 0.4,
  clippingRatio: 0,
  silenceRatio: 0.2,
  reasons: []
};

function embedding(values: number[], quality = okQuality): SpeakerEmbeddingResult {
  return {
    source: quality.ok ? "speaker" : "failed",
    model: "test-model",
    embeddingDim: values.length,
    embedding: values,
    quality,
    inferenceSeconds: 0,
    totalSeconds: 0
  };
}

async function withIsolatedStore(run: () => Promise<void>) {
  let backup: string | undefined;
  try {
    backup = await readFile(storePath, "utf8");
  } catch {
    backup = undefined;
  }

  await mkdir(dataDir, { recursive: true });
  await writeFile(storePath, JSON.stringify({ profiles: [] }, null, 2), "utf8");
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

assert.ok(cosineSimilarity([1, 0], [1, 0]) > cosineSimilarity([1, 0], [0, 1]));
const centroid = computeCentroid([[1, 0], [1, 0]]);
assert.equal(Math.round(centroid[0] * 1000) / 1000, 1);

await withIsolatedStore(async () => {
  const store = new SpeakerStore();
  let result = await store.registerSample({ userId: "user_a", displayName: "用户A", familyRole: "father", embeddingResult: embedding([1, 0, 0]) });
  assert.equal(result.centroidReady, false);
  assert.equal(result.familyRole, "father");
  result = await store.registerSample({ userId: "user_a", displayName: "用户A", familyRole: "father", embeddingResult: embedding([0.98, 0.1, 0]) });
  assert.equal(result.centroidReady, false);
  result = await store.registerSample({ userId: "user_a", displayName: "用户A", familyRole: "father", embeddingResult: embedding([0.99, -0.05, 0]) });
  assert.equal(result.centroidReady, true);

  const verified = await store.verify("user_a", embedding([0.99, 0.02, 0]));
  assert.equal(verified.source, "verified");
  assert.equal(verified.userId, "user_a");
  assert.equal(verified.familyRole, "father");

  const rejected = await store.verify("user_a", embedding([0, 1, 0]));
  assert.equal(rejected.source, "unknown");

  const identified = await store.identify(embedding([0.99, 0.01, 0]));
  assert.equal(identified.source, "identified");
  assert.equal(identified.userId, "user_a");
  assert.equal(identified.familyRole, "father");

  const lowQuality = await store.identify(embedding([1, 0, 0], { ...okQuality, ok: false, reasons: ["too_short"] }));
  assert.equal(lowQuality.source, "failed");
});

console.log("speaker store tests passed");
