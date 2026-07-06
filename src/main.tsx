import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentConfig, ChatMessage, ConverseResponse, FamilyMemorySnapshot, FamilyRole, Gender, RouteOutput, SpeakerIdentity, SpeakerUserSummary, TaskFiredEvent, TimeSegment, UserMemorySnapshot, UserProfile, VoiceProfileResult } from "../shared/types";
import "./styles.css";

const apiBase = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";
const agentHoldMs = 10_000;
const clientSessionStorageKey = "multi-agent-demo-client-session-id";

type SessionHold = {
  agentId: string;
  agentName: string;
  endsAt: number;
};

function App() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [currentAgent, setCurrentAgent] = useState<AgentConfig>();
  const [profile, setProfile] = useState<UserProfile>({ ageGroup: "adult", gender: "unknown" });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [transcript, setTranscript] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isConversationActive, setIsConversationActive] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isProfiling, setIsProfiling] = useState(false);
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfileResult | null>(null);
  const [speakerIdentity, setSpeakerIdentity] = useState<SpeakerIdentity | null>(null);
  const [registeredUsers, setRegisteredUsers] = useState<SpeakerUserSummary[]>([]);
  const [claimedUserId, setClaimedUserId] = useState<string>("");
  const [speakerDisplayName, setSpeakerDisplayName] = useState("");
  const [isIdentifying, setIsIdentifying] = useState(false);
  const [isRegisteringSpeaker, setIsRegisteringSpeaker] = useState(false);
  const [memory, setMemory] = useState<UserMemorySnapshot | null>(null);
  const [familyMemory, setFamilyMemory] = useState<FamilyMemorySnapshot | null>(null);
  const [familyRole, setFamilyRole] = useState<FamilyRole>("unknown");
  const [timeSegment, setTimeSegment] = useState<TimeSegment>(currentTimeSegment());
  const [memoryOptOut, setMemoryOptOut] = useState(false);
  const [routeResult, setRouteResult] = useState<(RouteOutput & { agentName: string }) | null>(null);
  const [status, setStatus] = useState("准备就绪");
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const latestAudioRef = useRef<Blob | null>(null);
  const latestTranscriptRef = useRef("");
  const finalTranscriptRef = useRef("");
  const autoSendRef = useRef(false);
  const conversationActiveRef = useRef(false);
  const isSendingRef = useRef(false);
  const isPlayingRef = useRef(false);
  const listeningSuppressedRef = useRef(false);
  const lastAssistantTextRef = useRef("");
  const lastAssistantAudioEndedAtRef = useRef(0);
  const restartListenTimerRef = useRef<number | null>(null);
  const audioReadyResolverRef = useRef<((audio: Blob | null) => void) | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const sessionHoldRef = useRef<SessionHold | null>(null);
  const clientSessionIdRef = useRef(getClientSessionId());
  const [sessionHold, setSessionHold] = useState<SessionHold | null>(null);
  const [holdRemainingSeconds, setHoldRemainingSeconds] = useState(0);

  const websocketUrl = useMemo(() => apiBase.replace(/^http/, "ws") + "/api/events", []);

  useEffect(() => {
    fetch(`${apiBase}/api/agents`)
      .then((res) => res.json())
      .then((data: { agents: AgentConfig[] }) => {
        setAgents(data.agents);
        setCurrentAgent(data.agents[0]);
      })
      .catch(() => setStatus("无法连接后端服务"));
    void refreshSpeakerUsers();
    void refreshFamilyMemory();
  }, []);

  async function refreshSpeakerUsers() {
    try {
      const response = await fetch(`${apiBase}/api/speaker/users`);
      const data = (await response.json()) as { users: SpeakerUserSummary[] };
      setRegisteredUsers(data.users);
      setClaimedUserId((current) => current || data.users.find((user) => user.centroidReady && user.status === "active")?.userId || "");
    } catch {
      setRegisteredUsers([]);
    }
  }

  async function refreshFamilyMemory() {
    try {
      const response = await fetch(`${apiBase}/api/family-memory`);
      const data = (await response.json()) as { familyMemory: FamilyMemorySnapshot };
      setFamilyMemory(data.familyMemory);
      setTimeSegment(data.familyMemory.currentTimeSegment);
    } catch {
      setFamilyMemory(null);
    }
  }

  useEffect(() => {
    const ws = new WebSocket(websocketUrl);
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as TaskFiredEvent | { type: string };
      if (!isTaskFiredEvent(payload)) return;
      setCurrentAgent(payload.agent);
      appendMessage("assistant", payload.assistantText, payload.agent.id);
      playAgentSpeech(payload.assistantText, payload.agent.id, payload.agent.displayName);
      setStatus(`任务已触发：提醒 ${payload.task.audience}`);
    };
    return () => ws.close();
  }, [websocketUrl]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const hold = sessionHoldRef.current;
      if (!hold) {
        setHoldRemainingSeconds(0);
        return;
      }

      const remainingMs = hold.endsAt - Date.now();
      if (remainingMs <= 0) {
        sessionHoldRef.current = null;
        setSessionHold(null);
        setHoldRemainingSeconds(0);
        return;
      }

      setHoldRemainingSeconds(Math.ceil(remainingMs / 1000));
    }, 250);

    return () => window.clearInterval(timer);
  }, []);

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

  function toggleConversation() {
    if (conversationActiveRef.current) {
      stopConversation();
      return;
    }
    conversationActiveRef.current = true;
    setIsConversationActive(true);
    void startListeningTurn();
  }

  function stopConversation() {
    conversationActiveRef.current = false;
    setIsConversationActive(false);
    if (restartListenTimerRef.current) {
      window.clearTimeout(restartListenTimerRef.current);
      restartListenTimerRef.current = null;
    }
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    stopAudioCapture();
    setIsListening(false);
    setStatus("对话已停止");
  }

  function scheduleListening(delayMs = 350) {
    if (!conversationActiveRef.current) return;
    if (restartListenTimerRef.current) window.clearTimeout(restartListenTimerRef.current);
    restartListenTimerRef.current = window.setTimeout(() => {
      restartListenTimerRef.current = null;
      if (conversationActiveRef.current && !isSendingRef.current && !isPlayingRef.current && !listeningSuppressedRef.current && !recognitionRef.current) {
        void startListeningTurn();
      }
    }, delayMs);
  }

  async function startListeningTurn() {
    if (!conversationActiveRef.current || recognitionRef.current || isSendingRef.current) return;
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
      finalTranscriptRef.current = "";
      setIsListening(true);
      setStatus("正在听你说话");
    };
    recognition.onresult = (event) => {
      const text = Array.from({ length: event.results.length }, (_, index) => event.results[index])
        .map((result: SpeechRecognitionResult) => result[0]?.transcript ?? "")
        .join("");
      const finalText = Array.from({ length: event.results.length }, (_, index) => event.results[index])
        .filter((result: SpeechRecognitionResult) => result.isFinal)
        .map((result: SpeechRecognitionResult) => result[0]?.transcript ?? "")
        .join("");
      setTranscript(text);
      setDraft(text);
      latestTranscriptRef.current = text;
      if (finalText.trim()) finalTranscriptRef.current = finalText;
    };
    recognition.onerror = () => {
      setStatus("语音识别失败，请检查麦克风权限或改用文本输入");
      setIsListening(false);
      recognitionRef.current = null;
      scheduleListening(600);
    };
    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
      stopAudioCapture();
      const finalText = (finalTranscriptRef.current || latestTranscriptRef.current).trim();
      if (listeningSuppressedRef.current) {
        autoSendRef.current = false;
        setStatus("AI 回复播放中，暂停监听");
        return;
      }
      if (isLikelyAssistantEcho(finalText)) {
        autoSendRef.current = false;
        setDraft("");
        setTranscript("");
        latestTranscriptRef.current = "";
        finalTranscriptRef.current = "";
        setStatus("已忽略扬声器回声，继续监听");
        scheduleListening(700);
        return;
      }
      if (autoSendRef.current && finalText) {
        setStatus("语音识别完成，正在自动发送");
        autoSendRef.current = false;
        void sendMessage(finalText);
      } else {
        autoSendRef.current = false;
        setStatus(finalText ? "语音识别完成" : "持续监听中");
        scheduleListening(300);
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setIsListening(false);
      scheduleListening(600);
    }
  }

  async function sendMessage(textOverride?: string) {
    const queryText = (textOverride ?? draft).trim();
    if (!queryText) return;
    const localStrongAgent = matchLocalStrongIntent(queryText);
    const lockedAgentId = getLockedAgentId(Boolean(localStrongAgent));
    appendMessage("user", queryText, lockedAgentId ?? currentAgent?.id);
    setDraft("");
    setTranscript("");
    setIsSending(true);
    isSendingRef.current = true;
    clearSessionHold();
    setStatus(lockedAgentId ? `继续由 ${agentNameById(lockedAgentId)} 回答` : "正在准备回复");

    try {
      requestAbortRef.current?.abort();
      const abortController = new AbortController();
      requestAbortRef.current = abortController;
      const hasStrongRoute = Boolean(localStrongAgent);
      await waitForAudioReady();
      const resolvedSpeaker = await resolveSpeakerIdentity(abortController.signal);
      const routedProfile = hasStrongRoute || lockedAgentId ? skipVoiceProfile(lockedAgentId ? "session-lock" : "strong") : await resolveVoiceProfile(abortController.signal);
      setStatus(lockedAgentId ? `继续由 ${agentNameById(lockedAgentId)} 回答` : "正在路由智能体");
      const response = await fetch(`${apiBase}/api/converse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          queryText,
          currentAgentId: currentAgent?.id,
          lockedAgentId,
          clientSessionId: clientSessionIdRef.current,
          resolvedUserId: resolvedSpeaker.userId,
          speakerIdentity: resolvedSpeaker,
          memoryOptOut,
          familyRole,
          timeSegment,
          profile: routedProfile,
          conversationContext: messages
        })
      });
      const data = (await response.json()) as ConverseResponse;
      setCurrentAgent(data.agent);
      setSpeakerIdentity(data.speakerIdentity ?? resolvedSpeaker);
      setMemory(data.memory ?? null);
      setFamilyMemory(data.familyMemory ?? familyMemory);
      if (data.timeSegment) setTimeSegment(data.timeSegment);
      setRouteResult(lockedAgentId ? null : { ...data.route, agentName: data.agent.displayName });
      appendMessage("assistant", data.assistantText, data.agent.id);
      setStatus(`${data.agent.displayName} 已生成回复，正在合成语音`);
      if (conversationActiveRef.current) {
        recognitionRef.current?.stop();
        recognitionRef.current = null;
        setIsListening(false);
      }
      void playAgentSpeech(data.assistantText, data.agent.id, data.agent.displayName);
      setStatus(
        data.task
          ? `已安排提醒：${new Date(data.task.triggerAt).toLocaleTimeString()}`
          : `${data.route.intentStrength === "strong" ? "强意图" : "弱意图"}路由到 ${data.agent.displayName}`
      );
    } catch (error) {
      setStatus(error instanceof DOMException && error.name === "AbortError" ? "已手动终止" : "后端请求失败，请确认服务已启动");
    } finally {
      setIsSending(false);
      isSendingRef.current = false;
      requestAbortRef.current = null;
    }
  }

  function getLockedAgentId(hasStrongRoute: boolean): string | undefined {
    if (hasStrongRoute) return undefined;
    const hold = sessionHoldRef.current;
    if (!hold || Date.now() > hold.endsAt) return undefined;
    return hold.agentId;
  }

  function clearSessionHold() {
    sessionHoldRef.current = null;
    setSessionHold(null);
    setHoldRemainingSeconds(0);
  }

  function agentNameById(agentId: string) {
    return agents.find((agent) => agent.id === agentId)?.displayName ?? "当前智能体";
  }

  function startSessionHold(agentId: string | undefined, agentName: string) {
    if (!agentId) return;
    const hold = {
      agentId,
      agentName,
      endsAt: Date.now() + agentHoldMs
    };
    sessionHoldRef.current = hold;
    setSessionHold(hold);
    setHoldRemainingSeconds(Math.ceil(agentHoldMs / 1000));
    setStatus(`语音播放完成，${Math.ceil(agentHoldMs / 1000)} 秒内继续由 ${agentName} 回答`);
  }

  function matchLocalStrongIntent(queryText: string): AgentConfig | undefined {
    return agents.find((agent) =>
      [agent.displayName, ...agent.aliases].some((alias) => alias && queryText.includes(alias))
    );
  }

  function terminateInteraction() {
    conversationActiveRef.current = false;
    setIsConversationActive(false);
    if (restartListenTimerRef.current) {
      window.clearTimeout(restartListenTimerRef.current);
      restartListenTimerRef.current = null;
    }
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    listeningSuppressedRef.current = false;
    stopCurrentAudio();
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

  function stopCurrentAudio() {
    audioPlayerRef.current?.pause();
    audioPlayerRef.current = null;
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    isPlayingRef.current = false;
  }

  function pauseListeningForPlayback() {
    listeningSuppressedRef.current = true;
    if (restartListenTimerRef.current) {
      window.clearTimeout(restartListenTimerRef.current);
      restartListenTimerRef.current = null;
    }
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    stopAudioCapture();
    setIsListening(false);
  }

  function normalizeSpeechText(text: string) {
    return text.replace(/[^\p{Script=Han}a-zA-Z0-9]/gu, "").toLowerCase();
  }

  function isLikelyAssistantEcho(text: string) {
    const normalized = normalizeSpeechText(text);
    const assistant = normalizeSpeechText(lastAssistantTextRef.current);
    if (!normalized || !assistant) return false;
    if (Date.now() - lastAssistantAudioEndedAtRef.current > 5000) return false;
    return assistant.includes(normalized) || normalized.includes(assistant.slice(0, Math.min(assistant.length, 30)));
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

  async function resolveSpeakerIdentity(signal: AbortSignal): Promise<SpeakerIdentity> {
    const audio = latestAudioRef.current;
    if (!audio || audio.size === 0) {
      const manualIdentity: SpeakerIdentity = {
        userId: claimedUserId || undefined,
        displayName: registeredUsers.find((user) => user.userId === claimedUserId)?.displayName,
        source: claimedUserId ? "manual" : "unknown",
        confidence: claimedUserId ? 0.5 : 0,
        reason: claimedUserId ? "无录音，使用手动选择用户，本轮不自动写入长期记忆" : "无录音，无法确认声纹身份"
      };
      setSpeakerIdentity(manualIdentity);
      return manualIdentity;
    }

    setIsIdentifying(true);
    setStatus("正在识别声纹身份");
    try {
      const form = new FormData();
      form.append("audio", audio, "speaker.webm");
      if (claimedUserId) form.append("claimedUserId", claimedUserId);
      form.append("assistantPlaybackRecentlyEnded", String(Date.now() - lastAssistantAudioEndedAtRef.current < 5000));
      const response = await fetch(`${apiBase}/api/speaker/resolve`, {
        method: "POST",
        body: form,
        signal
      });
      const result = (await response.json()) as SpeakerIdentity;
      setSpeakerIdentity(result);
      if (result.userId) {
        setClaimedUserId(result.userId);
        const memoryResponse = await fetch(`${apiBase}/api/memory/${encodeURIComponent(result.userId)}`, { signal });
        const memoryData = (await memoryResponse.json()) as { memory: UserMemorySnapshot };
        setMemory(memoryData.memory);
      } else {
        setMemory(null);
      }
      return result;
    } catch {
      const failed: SpeakerIdentity = {
        source: "failed",
        confidence: 0,
        reason: "声纹身份识别失败，本轮不写入长期记忆"
      };
      setSpeakerIdentity(failed);
      return failed;
    } finally {
      setIsIdentifying(false);
    }
  }

  async function registerSpeakerSample() {
    if (isRegisteringSpeaker || isListening || isSending) return;
    setIsRegisteringSpeaker(true);
    setStatus("正在录制声纹注册样本，请连续说话 3 秒");
    try {
      await startAudioCapture();
      await new Promise((resolve) => window.setTimeout(resolve, 3200));
      const audio = await waitForAudioReady();
      if (!audio || audio.size === 0) {
        setStatus("没有录到有效声纹样本");
        return;
      }
      const form = new FormData();
      form.append("audio", audio, "speaker-register.webm");
      if (claimedUserId) form.append("userId", claimedUserId);
      if (speakerDisplayName.trim()) form.append("displayName", speakerDisplayName.trim());
      const response = await fetch(`${apiBase}/api/speaker/register`, {
        method: "POST",
        body: form
      });
      const result = await response.json() as { userId: string; displayName?: string; sampleCount: number; centroidReady: boolean; message: string };
      setClaimedUserId(result.userId);
      if (result.displayName) setSpeakerDisplayName(result.displayName);
      setStatus(result.message);
      await refreshSpeakerUsers();
    } catch {
      setStatus("声纹注册失败，请确认后端和 Python 声纹环境可用");
    } finally {
      setIsRegisteringSpeaker(false);
    }
  }

  async function clearCurrentMemory() {
    if (!claimedUserId) return;
    const response = await fetch(`${apiBase}/api/memory/${encodeURIComponent(claimedUserId)}`, { method: "DELETE" });
    const data = (await response.json()) as { memory: UserMemorySnapshot };
    setMemory(data.memory);
    setStatus("已清除当前用户长期记忆");
  }

  async function toggleAutoImprove(enabled: boolean) {
    if (!claimedUserId) return;
    await fetch(`${apiBase}/api/speaker/auto-improve`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: claimedUserId, enabled })
    });
    await refreshSpeakerUsers();
  }

  function skipVoiceProfile(reason: "strong" | "session-lock" = "strong"): UserProfile {
    setVoiceProfile({
      ...profile,
      ageYears: 0,
      genderConfidence: 0,
      inferenceSeconds: 0,
      totalSeconds: 0,
      source: "skipped",
      error: reason === "session-lock" ? "10 秒内连续对话，跳过声音画像" : "强意图已明确，跳过声音画像"
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

  async function playAgentSpeech(text: string, agentId?: string, agentName = currentAgent?.displayName ?? "当前智能体") {
    lastAssistantTextRef.current = text;
    pauseListeningForPlayback();
    try {
      const response = await fetch(`${apiBase}/api/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ text, agentId })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: "Coze 原生音色不可用" })) as { error?: string };
        setStatus(`语音播放回退：${payload.error ?? "Coze 原生音色不可用"}`);
        throw new Error("Coze speech unavailable");
      }
      const audio = await response.blob();
      stopCurrentAudio();
      const audioUrl = URL.createObjectURL(audio);
      const player = new Audio(audioUrl);
      audioPlayerRef.current = player;
      player.onended = () => {
        isPlayingRef.current = false;
        listeningSuppressedRef.current = false;
        lastAssistantAudioEndedAtRef.current = Date.now();
        startSessionHold(agentId, agentName);
        URL.revokeObjectURL(audioUrl);
        scheduleListening(900);
      };
      player.onerror = () => {
        isPlayingRef.current = false;
        listeningSuppressedRef.current = false;
        URL.revokeObjectURL(audioUrl);
        scheduleListening(900);
      };
      isPlayingRef.current = true;
      await player.play();
      return;
    } catch {
      speakWithBrowser(text, agentName);
    }
  }

  function speakWithBrowser(text: string, agentName = currentAgent?.displayName ?? "当前智能体") {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 1;
    utterance.onend = () => {
      isPlayingRef.current = false;
      listeningSuppressedRef.current = false;
      lastAssistantAudioEndedAtRef.current = Date.now();
      startSessionHold(currentAgent?.id, agentName);
      scheduleListening(900);
    };
    utterance.onerror = () => {
      isPlayingRef.current = false;
      listeningSuppressedRef.current = false;
      scheduleListening(900);
    };
    isPlayingRef.current = true;
    window.speechSynthesis.speak(utterance);
  }

  function currentSpeakerUser() {
    return registeredUsers.find((user) => user.userId === claimedUserId);
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
          <label>
            声纹用户
            <select value={claimedUserId} onChange={(event) => setClaimedUserId(event.target.value)}>
              <option value="">自动识别</option>
              {registeredUsers.map((user) => (
                <option key={user.userId} value={user.userId}>
                  {user.displayName || user.userId}{user.centroidReady ? "" : "（未完成）"}
                </option>
              ))}
            </select>
          </label>
          <label>
            家庭角色
            <select value={familyRole} onChange={(event) => setFamilyRole(event.target.value as FamilyRole)}>
              <option value="unknown">未知</option>
              <option value="father">爸爸</option>
              <option value="mother">妈妈</option>
              <option value="child">孩子</option>
              <option value="elder">长辈</option>
              <option value="guest">访客</option>
            </select>
          </label>
          <label>
            时间段
            <select value={timeSegment} onChange={(event) => setTimeSegment(event.target.value as TimeSegment)}>
              <option value="morning">早上</option>
              <option value="noon">中午</option>
              <option value="afternoon">下午</option>
              <option value="evening">晚上</option>
              <option value="night">夜间</option>
            </select>
          </label>
          <label>
            昵称
            <input value={speakerDisplayName} onChange={(event) => setSpeakerDisplayName(event.target.value)} placeholder="用于显示的用户昵称" />
          </label>
          <button onClick={registerSpeakerSample} disabled={isRegisteringSpeaker || isListening || isSending}>
            {isRegisteringSpeaker ? "注册录音中" : "录制注册样本"}
          </button>
          <label className="checkbox-label">
            <input type="checkbox" checked={!memoryOptOut} onChange={(event) => setMemoryOptOut(!event.target.checked)} />
            允许长期记忆
          </label>
        </div>

        <div className={voiceProfile?.source === "voice" ? "profile-result detected" : "profile-result"}>
          <span>声音画像</span>
          {renderVoiceProfile(voiceProfile)}
          {isProfiling ? <em>识别中</em> : null}
        </div>

        <div className={speakerIdentity?.userId ? "identity-result detected" : "identity-result"}>
          <span>声纹身份</span>
          {renderSpeakerIdentity(speakerIdentity)}
          {isIdentifying ? <em>识别中</em> : null}
        </div>

        <div className={routeResult ? "route-result detected" : "route-result"}>
          <span>路由判断</span>
          {sessionHold && holdRemainingSeconds > 0
            ? <strong>会话保持中：{holdRemainingSeconds} 秒内继续由 {sessionHold.agentName} 回答</strong>
            : renderRouteResult(routeResult)}
        </div>

        <div className="voice-panel">
          <button className={isConversationActive ? "recording" : ""} onClick={toggleConversation}>
            {isConversationActive ? (isListening ? "监听中，点按停止" : "对话中，点按停止") : "开始"}
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
              <span>
                <strong>{agent.displayName}</strong>
                <small>{agent.cozeBotId.startsWith("replace_with_") ? "Coze 未配置" : "Coze 已配置"} · {agent.agentWorldApiKey ? "Agent World 已激活" : "Agent World 待激活"}</small>
              </span>
            </button>
          ))}
          <section className="memory-panel">
            <h2>长期记忆</h2>
            {renderMemory(memory, speakerIdentity)}
            <div className="memory-actions">
              <button onClick={clearCurrentMemory} disabled={!claimedUserId}>清除当前记忆</button>
              <button
                onClick={() => toggleAutoImprove(!currentSpeakerUser()?.autoImproveVoiceprint)}
                disabled={!claimedUserId}
              >
                {currentSpeakerUser()?.autoImproveVoiceprint === false ? "开启声纹优化" : "关闭声纹优化"}
              </button>
            </div>
          </section>
          <section className="memory-panel">
            <h2>家庭记忆</h2>
            {renderFamilyMemory(familyMemory, agents)}
          </section>
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
  if (result.source === "skipped") return <strong>{result.error ?? "已跳过声音画像"}</strong>;
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

function renderSpeakerIdentity(result: SpeakerIdentity | null) {
  if (!result) return <strong>未注册或未识别声纹</strong>;
  const similarity = typeof result.similarity === "number" ? ` · 相似度 ${Math.round(result.similarity * 100)}%` : "";
  const qualityReasons = result.quality?.reasons?.length ? ` · ${qualityReasonLabel(result.quality.reasons)}` : "";
  if (result.userId) {
    return (
      <>
        <strong>{result.displayName || result.userId}</strong>
        <strong>{identitySourceLabel(result.source)}{similarity}</strong>
        <span>{result.reason}</span>
      </>
    );
  }
  return (
    <>
      <strong>{identitySourceLabel(result.source)}</strong>
      <span>{result.reason ?? "未确认身份，本轮不读取或写入私人长期记忆"}{qualityReasons}</span>
    </>
  );
}

function renderMemory(memory: UserMemorySnapshot | null, identity: SpeakerIdentity | null) {
  if (!identity?.userId) {
    return <p className="empty">未确认用户身份，本轮不会读取或写入私人长期记忆。</p>;
  }
  if (!memory || (memory.facts.length === 0 && memory.preferences.length === 0)) {
    return <p className="empty">当前用户暂无长期记忆。说“记住我喜欢……”可写入显式记忆。</p>;
  }
  return (
    <div className="memory-list">
      <p>当前用户：{identity.displayName || identity.userId} · {familyRoleLabel(memory.familyRole)}</p>
      {memory.preferences.map((item) => (
        <span key={item.key}>偏好：{item.key} = {item.value}</span>
      ))}
      {memory.facts.map((item) => (
        <span key={item.id}>事实：{item.text}</span>
      ))}
    </div>
  );
}

function renderFamilyMemory(memory: FamilyMemorySnapshot | null, agents: AgentConfig[]) {
  if (!memory) return <p className="empty">暂无家庭记忆。完成一次对话后会自动生成家庭画像。</p>;
  const agentName = (agentId: string) => agents.find((agent) => agent.id === agentId)?.displayName ?? agentId;
  return (
    <div className="memory-list">
      <p>当前时间段：{timeSegmentLabel(memory.currentTimeSegment)}</p>
      {memory.members.slice(0, 4).map((member) => (
        <span key={member.userId}>
          成员：{member.displayName || member.userId} · {familyRoleLabel(member.familyRole)}
          {member.favoriteAgents[0] ? ` · 常用 ${agentName(member.favoriteAgents[0].agentId)} ${member.favoriteAgents[0].count} 次` : ""}
        </span>
      ))}
      {memory.agentUsage.slice(0, 3).map((item) => (
        <span key={item.agentId}>家庭常用智能体：{agentName(item.agentId)} · {item.count} 次</span>
      ))}
      {memory.reminderHabits.slice(0, 3).map((item) => (
        <span key={item.id}>提醒习惯：{familyRoleLabel(item.familyRole)} · {timeSegmentLabel(item.timeSegment)} · {item.message}</span>
      ))}
      {memory.sharedFacts.slice(0, 3).map((item) => (
        <span key={item.id}>家庭事实：{item.text}</span>
      ))}
    </div>
  );
}

function identitySourceLabel(source: SpeakerIdentity["source"]) {
  if (source === "verified") return "验证通过";
  if (source === "identified") return "识别成功";
  if (source === "manual") return "手动选择";
  if (source === "failed") return "识别失败";
  return "未确认身份";
}

function qualityReasonLabel(reasons: string[]) {
  const labels: Record<string, string> = {
    too_short: "语音太短",
    too_quiet: "音量太低",
    too_much_silence: "静音过多",
    clipped: "爆音或削波",
    no_speech_detected: "有效人声不足",
    invalid_sample_rate: "采样率异常",
    model_failed: "模型推理失败"
  };
  return reasons.map((reason) => labels[reason] ?? reason).join("、");
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
  if (source === "session-lock") return "会话保持";
  if (source === "model") return "模型判断";
  if (source === "strong-rule") return "强意图规则";
  return "规则兜底";
}

function familyRoleLabel(role: FamilyRole) {
  const labels: Record<FamilyRole, string> = {
    father: "爸爸",
    mother: "妈妈",
    child: "孩子",
    elder: "长辈",
    guest: "访客",
    unknown: "未知"
  };
  return labels[role];
}

function timeSegmentLabel(segment: TimeSegment) {
  const labels: Record<TimeSegment, string> = {
    morning: "早上",
    noon: "中午",
    afternoon: "下午",
    evening: "晚上",
    night: "夜间"
  };
  return labels[segment];
}

function currentTimeSegment(): TimeSegment {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "noon";
  if (hour >= 14 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

function getClientSessionId() {
  const existing = window.localStorage.getItem(clientSessionStorageKey);
  if (existing) return existing;
  const next = crypto.randomUUID();
  window.localStorage.setItem(clientSessionStorageKey, next);
  return next;
}
