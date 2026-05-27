import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentConfig, ChatMessage, ConverseResponse, Gender, RouteOutput, TaskFiredEvent, UserProfile, VoiceProfileResult } from "../shared/types";
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
  const [isSending, setIsSending] = useState(false);
  const [isProfiling, setIsProfiling] = useState(false);
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfileResult | null>(null);
  const [routeResult, setRouteResult] = useState<(RouteOutput & { agentName: string }) | null>(null);
  const [status, setStatus] = useState("准备就绪");
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const latestAudioRef = useRef<Blob | null>(null);
  const latestTranscriptRef = useRef("");
  const autoSendRef = useRef(false);
  const audioReadyResolverRef = useRef<((audio: Blob | null) => void) | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);

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

  async function toggleListening() {
    if (isListening) {
      autoSendRef.current = true;
      recognitionRef.current?.stop();
      stopAudioCapture();
      setIsListening(false);
      return;
    }

    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Recognition) {
      setStatus("当前浏览器不支持语音识别，请使用文本输入兜底");
      return;
    }

    await startAudioCapture();
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = false;
    autoSendRef.current = true;
    recognition.onstart = () => {
      setTranscript("");
      latestTranscriptRef.current = "";
      setIsListening(true);
      setStatus("正在听你说话");
    };
    recognition.onresult = (event) => {
      const text = Array.from({ length: event.results.length }, (_, index) => event.results[index])
        .map((result: SpeechRecognitionResult) => result[0]?.transcript ?? "")
        .join("");
      setTranscript(text);
      setDraft(text);
      latestTranscriptRef.current = text;
    };
    recognition.onerror = () => {
      setStatus("语音识别失败，请检查麦克风权限或改用文本输入");
      setIsListening(false);
    };
    recognition.onend = () => {
      setIsListening(false);
      stopAudioCapture();
      const finalText = latestTranscriptRef.current.trim();
      if (autoSendRef.current && finalText) {
        setStatus("语音识别完成，正在自动发送");
        autoSendRef.current = false;
        void sendMessage(finalText);
      } else {
        autoSendRef.current = false;
        setStatus(finalText ? "语音识别完成" : "没有识别到文字，请重试");
      }
    };
    recognitionRef.current = recognition;
    recognition.start();
  }

  async function sendMessage(textOverride?: string) {
    const queryText = (textOverride ?? draft).trim();
    if (!queryText) return;
    appendMessage("user", queryText, currentAgent?.id);
    setDraft("");
    setTranscript("");
    setIsSending(true);
    setStatus("正在判断意图");

    try {
      requestAbortRef.current?.abort();
      const abortController = new AbortController();
      requestAbortRef.current = abortController;
      const strongRoute = await detectStrongIntent(queryText, abortController.signal);
      const routedProfile = strongRoute ? skipVoiceProfile() : await resolveVoiceProfile(abortController.signal);
      setStatus("正在路由智能体");
      const response = await fetch(`${apiBase}/api/converse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          queryText,
          currentAgentId: currentAgent?.id,
          profile: routedProfile,
          conversationContext: messages
        })
      });
      const data = (await response.json()) as ConverseResponse;
      setCurrentAgent(data.agent);
      setRouteResult({ ...data.route, agentName: data.agent.displayName });
      appendMessage("assistant", data.assistantText, data.agent.id);
      speak(data.assistantText);
      setStatus(
        data.task
          ? `已安排提醒：${new Date(data.task.triggerAt).toLocaleTimeString()}`
          : `${data.route.intentStrength === "strong" ? "强意图" : "弱意图"}路由到 ${data.agent.displayName}`
      );
    } catch (error) {
      setStatus(error instanceof DOMException && error.name === "AbortError" ? "已手动终止" : "后端请求失败，请确认服务已启动");
    } finally {
      setIsSending(false);
      requestAbortRef.current = null;
    }
  }

  function terminateInteraction() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setIsListening(false);
    setIsSending(false);
    setIsProfiling(false);
    setRouteResult(null);
    setTranscript("");
    setDraft("");
    setStatus("已手动终止");
  }

  async function startAudioCapture() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("当前浏览器无法录制音频画像");
      return;
    }

    audioChunksRef.current = [];
    latestAudioRef.current = null;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      latestAudioRef.current = new Blob(audioChunksRef.current, { type: mimeType });
      stream.getTracks().forEach((track) => track.stop());
      audioReadyResolverRef.current?.(latestAudioRef.current);
      audioReadyResolverRef.current = null;
    };
    mediaStreamRef.current = stream;
    mediaRecorderRef.current = recorder;
    recorder.start();
  }

  function stopAudioCapture() {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
      return;
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
  }

  async function waitForAudioReady() {
    if (latestAudioRef.current) return latestAudioRef.current;
    if (mediaRecorderRef.current?.state === "recording") {
      stopAudioCapture();
    }
    return new Promise<Blob | null>((resolve) => {
      const timeout = window.setTimeout(() => {
        audioReadyResolverRef.current = null;
        resolve(latestAudioRef.current);
      }, 1200);
      audioReadyResolverRef.current = (audio) => {
        window.clearTimeout(timeout);
        resolve(audio);
      };
    });
  }

  async function detectStrongIntent(queryText: string, signal: AbortSignal): Promise<boolean> {
    const response = await fetch(`${apiBase}/api/route/strong`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ queryText })
    });
    const result = await response.json() as { route: RouteOutput | null };
    return result.route?.intentStrength === "strong";
  }

  function skipVoiceProfile(): UserProfile {
    setVoiceProfile({
      ...profile,
      ageYears: 0,
      genderConfidence: 0,
      inferenceSeconds: 0,
      totalSeconds: 0,
      source: "skipped"
    });
    return profile;
  }

  async function resolveVoiceProfile(signal: AbortSignal): Promise<UserProfile> {
    setStatus("正在识别声音画像");
    await waitForAudioReady();
    const audio = latestAudioRef.current;
    if (!audio || audio.size === 0) {
      setVoiceProfile({ ...profile, ageYears: 0, genderConfidence: 0, inferenceSeconds: 0, totalSeconds: 0, source: "manual" });
      return profile;
    }

    setIsProfiling(true);
    try {
      const form = new FormData();
      form.append("audio", audio, "voice.webm");
      const response = await fetch(`${apiBase}/api/profile/audio`, {
        method: "POST",
        body: form,
        signal
      });
      const result = (await response.json()) as VoiceProfileResult;
      setVoiceProfile(result);
      if (result.source === "voice") {
        const nextProfile = { ageGroup: result.ageGroup, gender: result.gender };
        setProfile(nextProfile);
        return nextProfile;
      }
      return profile;
    } finally {
      setIsProfiling(false);
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

        <div className={voiceProfile?.source === "voice" ? "profile-result detected" : "profile-result"}>
          <span>声音画像</span>
          {renderVoiceProfile(voiceProfile)}
          {isProfiling ? <em>识别中</em> : null}
        </div>

        <div className={routeResult ? "route-result detected" : "route-result"}>
          <span>路由判断</span>
          {renderRouteResult(routeResult)}
        </div>

        <div className="voice-panel">
          <button className={isListening ? "recording" : ""} onClick={toggleListening}>
            {isListening ? "正在听，停顿后自动发送" : "开始录音"}
          </button>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") sendMessage();
            }}
            placeholder="也可以直接输入：叫小狐狸给我讲故事"
          />
          <button onClick={() => sendMessage()} disabled={isSending}>{isSending ? "发送中" : "发送"}</button>
          <button className="terminate" onClick={terminateInteraction}>终止</button>
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

function renderVoiceProfile(result: VoiceProfileResult | null) {
  if (!result) return <strong>未识别，使用手动画像</strong>;
  if (result.source === "manual") return <strong>无录音，使用手动画像</strong>;
  if (result.source === "skipped") return <strong>强意图已明确，跳过声音画像</strong>;
  if (result.source === "failed") return <strong>识别失败，使用手动画像</strong>;
  const ageLabels: Record<UserProfile["ageGroup"], string> = {
    child: "儿童",
    teen: "青少年",
    adult: "成人",
    senior: "老人"
  };
  const genderLabels: Record<Gender, string> = {
    female: "女性",
    male: "男性",
    unknown: "未知"
  };
  return (
    <>
      <strong>年龄：{ageLabels[result.ageGroup]}（约 {result.ageYears.toFixed(1)} 岁）</strong>
      <strong>性别：{genderLabels[result.gender]}（{Math.round(result.genderConfidence * 100)}%）</strong>
      <strong>耗时：{result.totalSeconds.toFixed(2)}s</strong>
    </>
  );
}

function renderRouteResult(result: (RouteOutput & { agentName: string }) | null) {
  if (!result) return <strong>等待用户输入</strong>;
  return (
    <>
      <strong>{result.intentStrength === "strong" ? "强意图" : "弱意图"}</strong>
      <strong>来源：{routeSourceLabel(result.source)}</strong>
      <strong>Agent：{result.agentName}</strong>
      <strong>置信度：{Math.round(result.confidence * 100)}%</strong>
      <span>{result.reason}</span>
    </>
  );
}

function routeSourceLabel(source: RouteOutput["source"]): string {
  if (source === "model") return "模型判断";
  if (source === "strong-rule") return "强意图规则";
  return "规则兜底";
}
