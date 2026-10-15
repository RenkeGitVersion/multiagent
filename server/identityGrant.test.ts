import assert from "node:assert/strict";
import test from "node:test";
import { IdentityGrantStore } from "./identityGrant";

test("只为可信声纹身份签发凭证", () => {
  const store = new IdentityGrantStore();
  const unknown = store.issue({ source: "manual", confidence: 0.5, userId: "user-1" });
  assert.equal(unknown.identityToken, undefined);

  const verified = store.issue({ source: "verified", confidence: 0.93, userId: "user-1" });
  assert.ok(verified.identityToken);
  assert.equal(store.resolve(verified.identityToken, "user-1")?.userId, "user-1");
});

test("身份凭证不能用于其他用户", () => {
  const store = new IdentityGrantStore();
  const identity = store.issue({ source: "identified", confidence: 0.9, userId: "user-1" });
  assert.equal(store.resolve(identity.identityToken, "user-2"), undefined);
});

test("过期身份凭证会被拒绝", () => {
  let now = 1000;
  const store = new IdentityGrantStore(100, () => now);
  const identity = store.issue({ source: "verified", confidence: 0.95, userId: "user-1" });
  now = 1101;
  assert.equal(store.resolve(identity.identityToken, "user-1"), undefined);
});
