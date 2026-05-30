import type { AgentConfig, ChatMessage } from "../shared/types";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface GenerateReplyInput {
  agent: AgentConfig;
  queryText: string;
  conversationContext: ChatMessage[];
  clientSessionId?: string;
}

interface CreateRealtimeRoomInput {
  botId: string;
  connectorId?: string;
  voiceId?: string;
  conversationId?: string;
}

interface CozeMessage {
  type?: string;
  role?: string;
  content?: string;
  content_type?: string;
}

export interface RealtimeRoomInfo {
  token: string;
  uid: string;
  room_id: string;
  app_id: string;
}

export class CozeAdapter {
  private readonly useMock = process.env.COZE_USE_MOCK !== "false";

  async generateReply(input: GenerateReplyInput): Promise<string> {
    const startedAt = Date.now();
    const token = this.getCozeToken();
    if (this.useMock || !token) {
      const reply = this.generateMockReply(input);
      console.info(`[CozeAdapter] mock reply ${input.agent.displayName} in ${Date.now() - startedAt}ms`);
      return reply;
    }

    const reply = await this.generateCozeReply(input, token);
    const finalReply = reply ?? this.generateMockReply(input);
    console.info(`[CozeAdapter] reply ${input.agent.displayName} in ${Date.now() - startedAt}ms`);
    return finalReply;
  }

  async createRealtimeRoom(input: CreateRealtimeRoomInput): Promise<RealtimeRoomInfo> {
    const token = this.getCozeToken();
    if (!token) {
      throw new Error("缺少 Coze OpenAPI/OAuth token，无法创建实时语音房间");
    }

    const apiBase = process.env.COZE_API_BASE ?? "https://api.coze.cn";
    const apiRoot = apiBase.replace(/\/$/, "");
    const response = await fetch(`${apiRoot}/v1/audio/rooms`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        bot_id: input.botId,
        connector_id: input.connectorId ?? process.env.COZE_REALTIME_CONNECTOR_ID ?? "1024",
        voice_id: input.voiceId || undefined,
        conversation_id: input.conversationId || undefined,
        uid: process.env.COZE_REALTIME_UID || undefined
      })
    });

    if (!response.ok) {
      throw new Error(`Coze 实时语音房间创建失败：HTTP ${response.status}`);
    }

    const payload = await response.json() as { code?: number; msg?: string; data?: RealtimeRoomInfo };
    if (payload.code && payload.code !== 0) {
      throw new Error(`Coze 实时语音房间创建失败：${payload.code} ${payload.msg ?? ""}`);
    }
    if (!payload.data?.token || !payload.data.room_id || !payload.data.app_id || !payload.data.uid) {
      throw new Error("Coze 实时语音房间创建失败：返回数据不完整");
    }

    return payload.data;
  }

  async synthesizeSpeech(text: string, voiceId?: string, retryAuth = true): Promise<ArrayBuffer | undefined> {
    const startedAt = Date.now();
    const token = this.getCozeToken();
    if (this.useMock || !token || !voiceId || voiceId.startsWith("replace_with_")) {
      return undefined;
    }

    const apiBase = process.env.COZE_API_BASE ?? "https://api.coze.cn";
    const apiRoot = apiBase.replace(/\/$/, "");
    const response = await fetch(`${apiRoot}/v1/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: text.slice(0, 1024),
        voice_id: voiceId,
        response_format: "mp3",
        sample_rate: 16000,
        speed: 1
      })
    });

    if (!response.ok) {
      if ((response.status === 401 || response.status === 403) && retryAuth && this.refreshCliToken()) {
        return this.synthesizeSpeech(text, voiceId, false);
      }
      console.warn(`Coze speech API error: HTTP ${response.status}`);
      return undefined;
    }

    const audio = await response.arrayBuffer();
    console.info(`[CozeAdapter] speech voice=${voiceId} bytes=${audio.byteLength} in ${Date.now() - startedAt}ms`);
    return audio;
  }

  private getCozeToken(): string | undefined {
    if (process.env.COZE_USE_CLI_TOKEN === "true") {
      this.refreshCliTokenIfNeeded();
      return this.readCliToken();
    }
    return process.env.COZE_API_TOKEN;
  }

  private readCliToken(): string | undefined {
    try {
      const config = JSON.parse(readFileSync(`${process.env.HOME}/.coze/config.json`, "utf8")) as { accessToken?: string };
      return config.accessToken;
    } catch {
      return undefined;
    }
  }

  private refreshCliTokenIfNeeded(): void {
    try {
      const config = JSON.parse(readFileSync(`${process.env.HOME}/.coze/config.json`, "utf8")) as { tokenExpiresAt?: number | string };
      const expiresAt = typeof config.tokenExpiresAt === "number"
        ? config.tokenExpiresAt
        : config.tokenExpiresAt ? Date.parse(config.tokenExpiresAt) : 0;
      if (expiresAt && expiresAt - Date.now() > 120_000) return;
    } catch {
      // Fall through and let the CLI try to restore auth state.
    }
    this.refreshCliToken();
  }

  private refreshCliToken(): boolean {
    if (process.env.COZE_USE_CLI_TOKEN !== "true") return false;
    try {
      execFileSync("coze", ["auth", "status", "--format", "json"], {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 15_000
      });
      return Boolean(this.readCliToken());
    } catch (error) {
      console.warn(`Coze CLI token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private getRefreshedCozeToken(): string | undefined {
    if (this.refreshCliToken()) return this.readCliToken();
    return undefined;
  }

  private async generateCozeReply(input: GenerateReplyInput, token: string, retryAuth = true): Promise<string | undefined> {
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
        user_id: this.getUserId(input.clientSessionId),
        stream: false,
        auto_save_history: true,
        additional_messages: [
          {
            role: "user",
            content: input.queryText,
            content_type: "text",
            type: "question"
          }
        ]
      })
    });

    if (!response.ok) {
      if ((response.status === 401 || response.status === 403) && retryAuth) {
        const refreshedToken = this.getRefreshedCozeToken();
        if (refreshedToken) return this.generateCozeReply(input, refreshedToken, false);
      }
      return undefined;
    }
    const payload = await response.json() as {
      code?: number;
      msg?: string;
      data?: {
        id?: string;
        conversation_id?: string;
        status?: string;
        messages?: CozeMessage[];
      };
      messages?: CozeMessage[];
    };
    if (payload.code && payload.code !== 0) {
      if ((payload.code === 4101 || payload.code === 4100) && retryAuth) {
        const refreshedToken = this.getRefreshedCozeToken();
        if (refreshedToken) return this.generateCozeReply(input, refreshedToken, false);
      }
      console.warn(`Coze API error for ${input.agent.displayName}: ${payload.code} ${payload.msg ?? ""}`);
      return undefined;
    }

    const chatId = payload.data?.id;
    const conversationId = payload.data?.conversation_id;
    if (chatId && conversationId) {
      const chatStatus = await this.pollChat(apiRoot, chatId, conversationId, token);
      if (chatStatus && chatStatus !== "completed") {
        console.warn(`Coze chat ended with status ${chatStatus} for ${input.agent.displayName}`);
      }
      const answer = chatStatus === "completed"
        ? await this.getChatAnswer(apiRoot, chatId, conversationId, token)
        : undefined;
      if (answer) return answer;
    }

    const messages = payload.data?.messages ?? payload.messages ?? [];
    return this.extractBestAnswer(messages);
  }

  private async pollChat(apiRoot: string, chatId: string, conversationId: string, token: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
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
        if (status === "completed" || status === "failed" || status === "requires_action" || status === "canceled") return status;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return "timeout";
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
    const payload = await response.json() as { data?: CozeMessage[] };
    const messages = payload.data ?? [];
    return this.extractBestAnswer(messages);
  }

  private extractBestAnswer(messages: CozeMessage[]): string | undefined {
    const clean = (content?: string) => content?.trim();
    const hasTextContent = (message: CozeMessage) => {
      const contentType = message.content_type?.toLowerCase();
      return !contentType || contentType === "text" || contentType === "object_string";
    };
    const isUserFacingText = (content: string) => {
      if (!content) return false;
      if (/^\s*[{[]/.test(content)) return false;
      if (/\"msg_type\"\s*:/.test(content)) return false;
      if (/generate_answer_finish|empty result|from_module|from_unit/.test(content)) return false;
      return true;
    };
    const isValidAnswerText = (content: string | undefined): content is string => {
      return typeof content === "string" && content.length > 0 && isUserFacingText(content);
    };
    const answerMessages = messages
      .filter((message) => message.type === "answer" && hasTextContent(message))
      .map((message) => clean(message.content))
      .filter(isValidAnswerText);

    if (answerMessages.length === 0) {
      return undefined;
    }

    const substantialAnswers = answerMessages.filter((content) => this.answerScore(content) >= 3);
    const candidates = substantialAnswers.length > 0 ? substantialAnswers : answerMessages;
    return candidates.reduce((best, current) => (
      this.answerScore(current) >= this.answerScore(best) ? current : best
    ));
  }

  private answerScore(content: string): number {
    const compact = content.replace(/\s/g, "");
    let score = Math.min(compact.length, 120);
    if (compact.length <= 2) score -= 80;
    if (/^[好呀嗯啊哦呢那吧诶哈]+[，。,.!！?？]?$/.test(compact)) score -= 60;
    if (/[。！？!?]/.test(content)) score += 12;
    if (/[，,、]/.test(content)) score += 6;
    return score;
  }

  private getUserId(clientSessionId?: string): string {
    const baseUserId = process.env.COZE_USER_ID ?? "multi-agent-demo";
    const safeSessionId = clientSessionId?.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
    return safeSessionId ? `${baseUserId}-${safeSessionId}` : baseUserId;
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
