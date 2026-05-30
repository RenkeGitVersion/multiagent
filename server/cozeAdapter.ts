import type { AgentConfig, ChatMessage } from "../shared/types";
import { readFileSync } from "node:fs";

interface GenerateReplyInput {
  agent: AgentConfig;
  queryText: string;
  conversationContext: ChatMessage[];
}

export class CozeAdapter {
  private readonly useMock = process.env.COZE_USE_MOCK !== "false";

  async generateReply(input: GenerateReplyInput): Promise<string> {
    const token = this.getCozeToken();
    if (this.useMock || !token) {
      return this.generateMockReply(input);
    }

    const reply = await this.generateCozeReply(input, token);
    return reply ?? this.generateMockReply(input);
  }

  private getCozeToken(): string | undefined {
    if (process.env.COZE_USE_CLI_TOKEN === "true") {
      try {
        const config = JSON.parse(readFileSync(`${process.env.HOME}/.coze/config.json`, "utf8")) as { accessToken?: string };
        return config.accessToken;
      } catch {
        return undefined;
      }
    }
    return process.env.COZE_API_TOKEN;
  }

  private async generateCozeReply(input: GenerateReplyInput, token: string): Promise<string | undefined> {
    if (input.agent.cozeBotId.startsWith("replace_with_")) return undefined;

    const apiBase = process.env.COZE_API_BASE ?? "https://api.coze.cn";
    const apiRoot = apiBase.replace(/\/$/, "");
    const response = await fetch(`${apiRoot}/v3/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        bot_id: input.agent.cozeBotId,
        user_id: process.env.COZE_USER_ID ?? "multi-agent-demo-user",
        stream: false,
        auto_save_history: true,
        additional_messages: [
          {
            role: "user",
            content: input.queryText,
            content_type: "text"
          }
        ]
      })
    });

    if (!response.ok) return undefined;
    const payload = await response.json() as {
      code?: number;
      msg?: string;
      data?: {
        id?: string;
        conversation_id?: string;
        status?: string;
        messages?: Array<{ type?: string; content?: string }>;
      };
      messages?: Array<{ type?: string; content?: string }>;
    };
    if (payload.code && payload.code !== 0) {
      console.warn(`Coze API error for ${input.agent.displayName}: ${payload.code} ${payload.msg ?? ""}`);
      return undefined;
    }

    const chatId = payload.data?.id;
    const conversationId = payload.data?.conversation_id;
    if (chatId && conversationId) {
      await this.pollChat(apiRoot, chatId, conversationId, token);
      const answer = await this.getChatAnswer(apiRoot, chatId, conversationId, token);
      if (answer) return answer;
    }

    const messages = payload.data?.messages ?? payload.messages ?? [];
    return messages.find((message) => message.type === "answer" && message.content)?.content
      ?? messages.find((message) => message.content)?.content;
  }

  private async pollChat(apiRoot: string, chatId: string, conversationId: string, token: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`${apiRoot}/v3/chat/retrieve?chat_id=${chatId}&conversation_id=${conversationId}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      });
      if (response.ok) {
        const payload = await response.json() as { data?: { status?: string; last_error?: { code?: number; msg?: string } } };
        const status = payload.data?.status;
        if (status === "completed" || status === "failed" || status === "requires_action" || status === "canceled") return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  private async getChatAnswer(apiRoot: string, chatId: string, conversationId: string, token: string): Promise<string | undefined> {
    const response = await fetch(`${apiRoot}/v3/chat/message/list?chat_id=${chatId}&conversation_id=${conversationId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { data?: Array<{ type?: string; role?: string; content?: string }> };
    const messages = payload.data ?? [];
    return messages.find((message) => message.type === "answer" && message.content)?.content
      ?? messages.find((message) => message.role === "assistant" && message.content)?.content;
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
