import type { AgentConfig, ChatMessage } from "../shared/types";

interface GenerateReplyInput {
  agent: AgentConfig;
  queryText: string;
  conversationContext: ChatMessage[];
}

export class CozeAdapter {
  private readonly useMock = process.env.COZE_USE_MOCK !== "false";

  async generateReply(input: GenerateReplyInput): Promise<string> {
    if (this.useMock || !process.env.COZE_API_TOKEN) {
      return this.generateMockReply(input);
    }

    return [
      `已选择 ${input.agent.displayName}。`,
      "真实 Coze 实时语音 API 需要按当前账号开通能力补齐事件流接入；当前后端已保证 token 不会暴露到前端。"
    ].join("");
  }

  private generateMockReply(input: GenerateReplyInput): string {
    const query = input.queryText;
    if (input.agent.id === "doctor-chen") {
      return "我先帮你做一般健康信息梳理。如果症状明显、持续加重或涉及急症，请及时去线下医疗机构。";
    }
    if (input.agent.id === "little-fox") {
      if (/提醒|监督|写作业|看电视/.test(query)) {
        return "好呀，我会记住这件事。时间一到，我会用温柔的声音提醒小朋友去写作业。";
      }
      return "好呀好呀，我来陪你。我们可以讲一个暖暖的小故事，也可以聊聊今天发生的开心事。";
    }
    if (input.agent.id === "study-coach") {
      return "我们先把任务拆小一点：先做最容易开始的一题，再慢慢进入状态。";
    }
    if (input.agent.id === "life-butler") {
      return "我已经理解你的安排，会帮你把提醒时间和提醒对象确认清楚。";
    }
    return "我在这里，先陪你把这件事慢慢说清楚。";
  }
}
