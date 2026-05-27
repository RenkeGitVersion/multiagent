import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentConfig, ChatMessage, ConverseResponse, Gender, TaskFiredEvent, UserProfile } from "../shared/types";
import "./styles.css";

const apiBase = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

function App() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [currentAgent, setCurrentAgent] = useState<AgentConfig>();
  const [profile, setProfile] = useState<UserProfile>({ ageGroup: "adult", gender: "unknown" });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [transcript, setTranscript] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [status, setStatus] = useState("准备就绪");
  const recognitionRef = useRef<SpeechRecognition | null>(null);

  const websocketUrl = useMemo(() => apiBase.replace(/^http/, "ws") + "/api/events", []);

  useEffect(() => {
    fetch(`${apiBase}/api/agents`)
      .then((res) => res.json())
      .then((data: { agents: AgentConfig[] }) => {
        setAgents(data.agents);
        setCurrentAgent(data.agents[0]);
      })
      .catch(() => setStatus("无法连接后端服务"));
  }, []);

  useEffect(() => {
    const ws = new WebSocket(websocketUrl);
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as TaskFiredEvent | { type: string };
      if (!isTaskFiredEvent(payload)) return;
      setCurrentAgent(payload.agent);
      appendMessage("assistant", payload.assistantText, payload.agent.id);
      speak(payload.assistantText);
      setStatus(`任务已触发：提醒 ${payload.task.audience}`);
    };
    return () => ws.close();
  }, [websocketUrl]);

  function appendMessage(role: ChatMessage["role"], text: string, agentId?: string) {
    setMessages((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        role,
        text,
        agentId,
        createdAt: new Date().toISOString()
      }
    ]);
  }

  function toggleListening() {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setStatus("当前浏览器不支持语音识别，请使用文本输入兜底");
      return;
    }

    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onstart = () => {
      setTranscript("");
      setIsListening(true);
      setStatus("正在听你说话");
    };
    recognition.onresult = (event) => {
      const text = Array.from({ length: event.results.length }, (_, index) => event.results[index])
        .map((result: SpeechRecognitionResult) => result[0]?.transcript ?? "")
        .join("");
      setTranscript(text);
      setDraft(text);
    };
    recognition.onerror = () => {
      setStatus("语音识别失败，请检查麦克风权限或改用文本输入");
      setIsListening(false);
    };
    recognition.onend = () => {
      setIsListening(false);
      setStatus("语音识别完成");
    };
    recognitionRef.current = recognition;
    recognition.start();
  }

  async function sendMessage() {
    const queryText = draft.trim();
    if (!queryText) return;
    appendMessage("user", queryText, currentAgent?.id);
    setDraft("");
    setTranscript("");
    setStatus("正在路由智能体");

    try {
      const response = await fetch(`${apiBase}/api/converse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queryText,
          currentAgentId: currentAgent?.id,
          profile,
          conversationContext: messages
        })
      });
      const data = (await response.json()) as ConverseResponse;
      setCurrentAgent(data.agent);
      appendMessage("assistant", data.assistantText, data.agent.id);
      speak(data.assistantText);
      setStatus(
        data.task
          ? `已安排提醒：${new Date(data.task.triggerAt).toLocaleTimeString()}`
          : `${data.route.intentStrength === "strong" ? "强意图" : "弱意图"}路由到 ${data.agent.displayName}`
      );
    } catch {
      setStatus("后端请求失败，请确认服务已启动");
    }
  }

  function speak(text: string) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
  }

  return (
    <main className="app-shell">
      <section className="stage">
        <div className="agent-visual">
          {currentAgent ? <img src={currentAgent.gifPath} alt={currentAgent.displayName} /> : null}
        </div>
        <div className="agent-copy">
          <p className="eyebrow">当前智能体</p>
          <h1>{currentAgent?.displayName ?? "载入中"}</h1>
          <p>{currentAgent?.defaultPromptHint ?? "正在准备智能体配置"}</p>
          <div className="tags">
            {currentAgent?.personaTags.map((tag) => <span key={tag}>{tag}</span>)}
          </div>
        </div>
      </section>

      <section className="control-band">
        <div className="profile-panel">
          <label>
            年龄段
            <select value={profile.ageGroup} onChange={(event) => setProfile({ ...profile, ageGroup: event.target.value as UserProfile["ageGroup"] })}>
              <option value="child">儿童</option>
              <option value="teen">青少年</option>
              <option value="adult">成人</option>
              <option value="senior">老人</option>
            </select>
          </label>
          <label>
            性别
            <select value={profile.gender} onChange={(event) => setProfile({ ...profile, gender: event.target.value as Gender })}>
              <option value="unknown">未知</option>
              <option value="female">女性</option>
              <option value="male">男性</option>
            </select>
          </label>
        </div>

        <div className="voice-panel">
          <button className={isListening ? "recording" : ""} onClick={toggleListening}>
            {isListening ? "停止录音" : "开始录音"}
          </button>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") sendMessage();
            }}
            placeholder="也可以直接输入：叫小狐狸给我讲故事"
          />
          <button onClick={sendMessage}>发送</button>
        </div>
        <p className="status">{status}{transcript ? ` · ${transcript}` : ""}</p>
      </section>

      <section className="content-grid">
        <div className="conversation">
          <h2>对话</h2>
          <div className="message-list">
            {messages.length === 0 ? <p className="empty">试试：“叫小狐狸给我讲故事” 或 “提醒小朋友 1 分钟后写作业”。</p> : null}
            {messages.map((message) => (
              <article key={message.id} className={`message ${message.role}`}>
                <span>{message.role === "user" ? "我" : agents.find((agent) => agent.id === message.agentId)?.displayName ?? "系统"}</span>
                <p>{message.text}</p>
              </article>
            ))}
          </div>
        </div>
        <div className="agent-list">
          <h2>Agent 池</h2>
          {agents.map((agent) => (
            <button
              key={agent.id}
              className={agent.id === currentAgent?.id ? "active" : ""}
              onClick={() => setCurrentAgent(agent)}
            >
              <img src={agent.gifPath} alt="" />
              <span>{agent.displayName}</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

function isTaskFiredEvent(payload: TaskFiredEvent | { type: string }): payload is TaskFiredEvent {
  return payload.type === "task:fired";
}
