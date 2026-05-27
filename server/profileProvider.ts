import type { UserProfile } from "../shared/types";

export interface ProfileProvider {
  analyze(input: { audio?: ArrayBuffer; metadata?: Partial<UserProfile> }): Promise<UserProfile>;
}

export class ManualProfileProvider implements ProfileProvider {
  async analyze(input: { metadata?: Partial<UserProfile> }): Promise<UserProfile> {
    return {
      ageGroup: input.metadata?.ageGroup ?? "adult",
      gender: input.metadata?.gender ?? "unknown"
    };
  }
}
