import { randomUUID } from "node:crypto";
import type { SpeakerIdentity } from "../shared/types";

interface IdentityGrant {
  identity: SpeakerIdentity;
  expiresAt: number;
}

export class IdentityGrantStore {
  private readonly grants = new Map<string, IdentityGrant>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now
  ) {}

  issue(identity: SpeakerIdentity): SpeakerIdentity {
    if (!identity.userId || !["verified", "identified"].includes(identity.source)) return identity;
    const identityToken = randomUUID();
    this.grants.set(identityToken, {
      identity: { ...identity, identityToken: undefined },
      expiresAt: this.now() + this.ttlMs
    });
    this.prune();
    return { ...identity, identityToken };
  }

  resolve(identityToken?: string, expectedUserId?: string): SpeakerIdentity | undefined {
    if (!identityToken || !expectedUserId) return undefined;
    const grant = this.grants.get(identityToken);
    if (!grant || grant.expiresAt <= this.now() || grant.identity.userId !== expectedUserId) {
      if (grant?.expiresAt && grant.expiresAt <= this.now()) this.grants.delete(identityToken);
      return undefined;
    }
    return { ...grant.identity, identityToken };
  }

  private prune() {
    const now = this.now();
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(token);
    }
  }
}
