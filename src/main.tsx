import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentConfig, ChatMessage, ConverseResponse, CozeVoiceRuntimeStatus, FamilyMemorySnapshot, FamilyRole, Gender, ReminderTask, RouteOutput, SpeakerIdentity, SpeakerUserSummary, TaskFiredEvent, TimeSegment, UserMemorySnapshot, UserProfile, VoiceProfileResult } from "../shared/types";
import "./styles.css";

const apiBase = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";
const agentHoldMs = 20_000;
const realtimeIdleDisconnectMs = 20_000;
const realtimeConnectTimeoutMs = 12_000;
const speechFinalSilenceMs = 200;
const speechInterimSilenceMs = 600;
const backendSttSilenceMs = 650;
const backendSttVoiceLevel = 6;
const backendSttMinSpeechMs = 120;
const resumeListeningAfterPlaybackMs = 80;
const duplicateSpeechSendWindowMs = 2500;
const clientSessionStorageKey = "multi-agent-demo-client-session-id";

type SessionHold = {
  agentId: string;
  agentName: string;
  endsAt: number;
};

type RealtimeIdleHold = {
  agentName: string;
  endsAt: number;
};

type RealtimeClientHandle = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  interrupt(): Promise<void>;
  sendMessage(message: Record<string, unknown>): void;
  setAudioEnable(isEnable: boolean): Promise<void>;
  on(eventName: string, callback: (eventName: string, event: unknown) => void): unknown;
};

type RealtimeRoomInfo = {
  token: string;
  uid: string;
  room_id: string;
  app_id: string;
};

type MobileTab = "agents" | "chat" | "tasks" | "settings";

function App() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [currentAgent, setCurrentAgent] = useState<AgentConfig>();
  const [mobileTab, setMobileTab] = useState<MobileTab>("agents");
  const [profile, setProfile] = useState<UserProfile>({ ageGroup: "adult", gender: "unknown" });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<ReminderTask[]>([]);
  const [draft, setDraft] = useState("");
  const [transcript, setTranscript] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isConversationActive, setIsConversationActive] = useState(false);
  const [isRealtimeActive, setIsRealtimeActive] = useState(false);
  const [isRealtimeConnecting, setIsRealtimeConnecting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isProfiling, setIsProfiling] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
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
  const [cozeVoiceStatus, setCozeVoiceStatus] = useState<CozeVoiceRuntimeStatus | null>(null);
  const [status, setStatus] = useState("准备就绪");
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioLevelTimerRef = useRef<number | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const latestAudioRef = useRef<Blob | null>(null);
  const sttFallbackInFlightRef = useRef(false);
  const micSpeechStartedAtRef = useRef(0);
  const lastMicVoiceAtRef = useRef(0);
  const latestTranscriptRef = useRef("");
  const finalTranscriptRef = useRef("");
  const scheduledTranscriptRef = useRef("");
  const lastSubmittedSpeechRef = useRef<{ text: string; submittedAt: number }>({ text: "", submittedAt: 0 });
  const autoSendRef = useRef(false);
  const conversationActiveRef = useRef(false);
  const isSendingRef = useRef(false);
  const isPlayingRef = useRef(false);
  const listeningSuppressedRef = useRef(false);
  const lastAssistantTextRef = useRef("");
  const lastAssistantAudioEndedAtRef = useRef(0);
  const restartListenTimerRef = useRef<number | null>(null);
  const speechFinalizeTimerRef = useRef<number | null>(null);
  const recognitionFinalizedRef = useRef(false);
  const audioReadyResolverRef = useRef<((audio: Blob | null) => void) | null>(null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const realtimeClientRef = useRef<RealtimeClientHandle | null>(null);
  const realtimeAgentIdRef = useRef<string | null>(null);
  const realtimeHandoffInProgressRef = useRef(false);
  const realtimeMessageIdsRef = useRef<Set<string>>(new Set());
  const realtimeUserTranscriptRef = useRef("");
  const realtimeAssistantTranscriptRef = useRef("");
  const realtimeIdleTimerRef = useRef<number | null>(null);
  const realtimeConnectTimerRef = useRef<number | null>(null);
  const realtimeIdleHoldRef = useRef<RealtimeIdleHold | null>(null);
  const sessionHoldRef = useRef<SessionHold | null>(null);
  const clientSessionIdRef = useRef(getClientSessionId());
  const [sessionHold, setSessionHold] = useState<SessionHold | null>(null);
  const [holdRemainingSeconds, setHoldRemainingSeconds] = useState(0);
  const [realtimeIdleHold, setRealtimeIdleHold] = useState<RealtimeIdleHold | null>(null);
  const [realtimeIdleRemainingSeconds, setRealtimeIdleRemainingSeconds] = useState(0);

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
  }, []);

  async function refreshSpeakerUsers() {
    try {
      const response = await fetch(`${apiBase}/api/speaker/users`);
      const data = (await response.json()) as { users: SpeakerUserSummary[] };
      setRegisteredUsers(data.users);
      const firstReadyUser = data.users.find((user) => user.centroidReady && user.status === "active");
      setClaimedUserId((current) => current || firstReadyUser?.userId || "");
      if (firstReadyUser && !claimedUserId) setFamilyRole(firstReadyUser.familyRole);
    } catch {
      setRegisteredUsers([]);
    }
  }

  useEffect(() => {
    fetch(`${apiBase}/api/tasks`)
      .then((res) => res.json())
      .then((data: { tasks: ReminderTask[] }) => setTasks(data.tasks))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch(`${apiBase}/api/coze/voice-status`)
      .then((res) => res.json())
      .then((data: CozeVoiceRuntimeStatus) => {
        setCozeVoiceStatus(data);
        const readyCount = countReadyRealtimeAgents(data);
        const totalCount = data.realtimeAgents.length;
        if (data.useMock) {
          setStatus("Coze mock 模式开启，原声不会启用");
        } else if (!data.hasToken && !data.hasAnyRealtimeToken) {
          setStatus("Coze 原声未连接：缺少 token 或 CLI 登录态");
        } else if (!data.hasToken && data.hasAnyRealtimeToken) {
          setStatus(`Coze 实时建房 token 已加载：${readyCount}/${totalCount} 可用`);
        } else {
          setStatus(`Coze 原声配置已加载：${readyCount}/${totalCount} 实时建房可用`);
        }
      })
      .catch(() => setStatus("无法检查 Coze 原声状态"));
  }, []);

  useEffect(() => {
    const ws = new WebSocket(websocketUrl);
    ws.onmessage = (event) => {
      const payload = JSON.parse(event.data) as TaskFiredEvent | { type: string };
      if (!isTaskFiredEvent(payload)) return;
      setCurrentAgent(payload.agent);
      setTasks((items) => items.map((task) => task.taskId === payload.task.taskId ? payload.task : task));
      appendMessage("assistant", payload.assistantText, payload.agent.id);
      playAgentSpeech(payload.assistantText, payload.agent.id, payload.agent.displayName);
      setStatus(`任务已触发：提醒 ${payload.task.audience}`);
    };
    return () => ws.close();
  }, [websocketUrl]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const realtimeHold = realtimeIdleHoldRef.current;
      if (!realtimeHold) {
        setRealtimeIdleRemainingSeconds(0);
      } else {
        const realtimeRemainingMs = realtimeHold.endsAt - Date.now();
        if (realtimeRemainingMs <= 0) {
          realtimeIdleHoldRef.current = null;
          setRealtimeIdleHold(null);
          setRealtimeIdleRemainingSeconds(0);
        } else {
          setRealtimeIdleRemainingSeconds(Math.ceil(realtimeRemainingMs / 1000));
        }
      }

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

  function addTaskToState(task: ReminderTask) {
    setTasks((items) => {
      if (items.some((item) => item.taskId === task.taskId)) return items;
      return [task, ...items];
    });
  }

  function reportSpeechDebug(event: string, detail: Record<string, unknown> = {}) {
    void fetch(`${apiBase}/api/debug/client-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({ event, detail })
    }).catch(() => undefined);
  }

  function toggleConversation() {
    if (realtimeClientRef.current) {
      conversationActiveRef.current = false;
      setIsConversationActive(false);
      void stopRealtimeVoice();
      return;
    }
    if (isRealtimeConnecting) {
      conversationActiveRef.current = false;
      setIsConversationActive(false);
      void stopRealtimeVoice();
      return;
    }
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
    stopListeningTurn();
    setStatus("对话已停止");
  }

  function stopListeningTurn() {
    clearSpeechFinalizeTimer();
    if (restartListenTimerRef.current) {
      window.clearTimeout(restartListenTimerRef.current);
      restartListenTimerRef.current = null;
    }
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    stopAudioCapture();
    setIsListening(false);
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
    reportSpeechDebug("start-listening", {
      hasSpeechRecognition: Boolean(Recognition),
      isSecureContext: window.isSecureContext,
      userAgent: navigator.userAgent
    });
    if (!Recognition) {
      setStatus("当前浏览器不支持语音识别，请使用文本输入兜底");
      return;
    }

    try {
      await startAudioCapture();
    } catch (error) {
      setIsListening(false);
      setStatus(error instanceof Error ? `麦克风启动失败：${error.message}` : "麦克风启动失败，请检查输入设备");
      scheduleListening(900);
      return;
    }
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = false;
    (recognition as SpeechRecognition & { maxAlternatives?: number }).maxAlternatives = 5;
    reportSpeechDebug("recognition-config", {
      lang: recognition.lang,
      interimResults: recognition.interimResults,
      continuous: recognition.continuous
    });
    autoSendRef.current = true;
    recognitionFinalizedRef.current = false;
    recognition.onstart = () => {
      setTranscript("");
      latestTranscriptRef.current = "";
      finalTranscriptRef.current = "";
      scheduledTranscriptRef.current = "";
      setIsListening(true);
      setStatus("正在听你说话");
      reportSpeechDebug("recognition-start");
    };
    recognition.onaudiostart = () => {
      setStatus("浏览器已拿到麦克风音频");
      reportSpeechDebug("audio-start");
    };
    recognition.onspeechstart = () => {
      setStatus("检测到语音，正在等待转写");
      reportSpeechDebug("speech-start");
    };
    recognition.onspeechend = () => {
      setStatus("检测到你说完，等待浏览器返回文字");
      reportSpeechDebug("speech-end");
      window.setTimeout(() => {
        if (recognitionRef.current !== recognition) return;
        try {
          recognition.stop();
        } catch {
          // The browser may have already stopped this recognition turn.
        }
      }, speechFinalSilenceMs);
    };
    recognition.onnomatch = () => {
      setStatus("浏览器没有匹配出文字，准备继续监听");
      reportSpeechDebug("no-match");
    };
    recognition.onresult = (event) => {
      const text = Array.from({ length: event.results.length }, (_, index) => event.results[index])
        .map((result: SpeechRecognitionResult) => pickSpeechTranscript(result, currentAgent?.id, agents))
        .join("");
      const finalText = Array.from({ length: event.results.length }, (_, index) => event.results[index])
        .filter((result: SpeechRecognitionResult) => result.isFinal)
        .map((result: SpeechRecognitionResult) => pickSpeechTranscript(result, currentAgent?.id, agents))
        .join("");
      setTranscript(text);
      if (!isPlayingRef.current) setDraft(text);
      latestTranscriptRef.current = text;
      const recognizedText = (finalText || text).trim();
      reportSpeechDebug("result", {
        resultsLength: event.results.length,
        text,
        finalText,
        recognizedText,
        hasFinal: Boolean(finalText.trim())
      });
      const recognizedChanged = normalizeSpeechText(recognizedText) !== normalizeSpeechText(scheduledTranscriptRef.current);
      if (recognizedText && (recognizedChanged || finalText.trim())) {
        scheduledTranscriptRef.current = recognizedText;
        if (finalText.trim()) {
          finalTranscriptRef.current = finalText;
          scheduleRecognizedTextSend(finalText);
        } else {
          scheduleRecognizedTextSend(text, speechInterimSilenceMs);
        }
      }
    };
    recognition.onerror = (event) => {
      setStatus(formatSpeechRecognitionError(event.error));
      reportSpeechDebug("error", { error: event.error, message: event.message });
      setIsListening(false);
      recognitionRef.current = null;
      stopAudioCapture();
      scheduleListening(600);
    };
    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
      stopAudioCapture();
      if (recognitionFinalizedRef.current) return;
      const finalText = (finalTranscriptRef.current || latestTranscriptRef.current).trim();
      reportSpeechDebug("end", {
        finalText,
        latestText: latestTranscriptRef.current,
        sawMicVoice: Boolean(lastMicVoiceAtRef.current)
      });
      if (listeningSuppressedRef.current) {
        autoSendRef.current = false;
        clearSpeechFinalizeTimer();
        setStatus("AI 回复播放中，暂停监听");
        return;
      }
      if (isLikelyAssistantEcho(finalText)) {
        autoSendRef.current = false;
        setDraft("");
        setTranscript("");
        latestTranscriptRef.current = "";
        finalTranscriptRef.current = "";
        scheduledTranscriptRef.current = "";
        setStatus("已忽略扬声器回声，继续监听");
        scheduleListening(700);
        return;
      }
      if (autoSendRef.current && finalText) {
        scheduleRecognizedTextSend(finalText, 250);
      } else {
        autoSendRef.current = false;
        if (lastMicVoiceAtRef.current) {
          void transcribeCurrentAudioFallback();
          return;
        }
        setStatus(finalText ? "语音识别完成" : "持续监听中");
        scheduleListening(300);
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      reportSpeechDebug("start-throw");
      recognitionRef.current = null;
      setIsListening(false);
      scheduleListening(600);
    }
  }

  function clearSpeechFinalizeTimer() {
    if (!speechFinalizeTimerRef.current) return;
    window.clearTimeout(speechFinalizeTimerRef.current);
    speechFinalizeTimerRef.current = null;
  }

  function scheduleRecognizedTextSend(text: string, delayMs = speechFinalSilenceMs) {
    clearSpeechFinalizeTimer();
    const finalText = text.trim();
    if (!finalText) return;
    speechFinalizeTimerRef.current = window.setTimeout(() => {
      speechFinalizeTimerRef.current = null;
      void finalizeRecognizedText(finalText);
    }, delayMs);
    setStatus(`已听到，等待你说完`);
  }

  async function finalizeRecognizedText(text: string) {
    const finalText = text.trim();
    if (!finalText || isSendingRef.current) return;
    if (isDuplicateSpeechSubmit(finalText)) return;
    if (isLikelyAssistantEcho(finalText)) {
      autoSendRef.current = false;
      setDraft("");
      setTranscript("");
      latestTranscriptRef.current = "";
      finalTranscriptRef.current = "";
      scheduledTranscriptRef.current = "";
      setStatus("已忽略扬声器回声，继续监听");
      scheduleListening(500);
      return;
    }

    recognitionFinalizedRef.current = true;
    autoSendRef.current = false;
    clearSpeechFinalizeTimer();
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    stopAudioCapture();

    if (isPlayingRef.current) {
      stopCurrentAudio();
      listeningSuppressedRef.current = false;
      setStatus("已打断当前回复，正在处理你的新输入");
    } else {
      setStatus("语音识别完成，正在自动发送");
    }

    await sendMessage(finalText);
  }

  function isDuplicateSpeechSubmit(text: string) {
    const normalized = normalizeSpeechText(text);
    if (!normalized) return true;
    const lastSubmitted = lastSubmittedSpeechRef.current;
    const isDuplicate =
      normalized === lastSubmitted.text &&
      Date.now() - lastSubmitted.submittedAt < duplicateSpeechSendWindowMs;
    if (isDuplicate) {
      setStatus("已忽略重复语音输入");
      return true;
    }
    lastSubmittedSpeechRef.current = { text: normalized, submittedAt: Date.now() };
    return false;
  }

  async function sendMessage(textOverride?: string) {
    const queryText = (textOverride ?? draft).trim();
    if (!queryText) return;
    const localStrongAgent = matchLocalStrongIntent(queryText);
    if (localStrongAgent && canUseRealtime(localStrongAgent) && !realtimeClientRef.current && !isRealtimeConnecting) {
      setVoiceProfile({
        ...profile,
        ageYears: 0,
        genderConfidence: 0,
        inferenceSeconds: 0,
        totalSeconds: 0,
        source: "skipped",
        error: `${localStrongAgent.displayName}强意图已明确，直接进入实时语音`
      });
      setRouteResult({
        agentId: localStrongAgent.id,
        intentStrength: "strong",
        reason: `命中${localStrongAgent.displayName}唤醒词，直接进入 Coze 实时语音`,
        confidence: 0.98,
        source: "strong-rule",
        agentName: localStrongAgent.displayName
      });
      const realtimeStarted = await startRealtimeVoice(localStrongAgent, extractInitialRealtimeRequest(queryText, localStrongAgent));
      if (realtimeStarted) {
        appendMessage("user", queryText, localStrongAgent.id);
        setDraft("");
        setTranscript("");
        clearSessionHold();
        latestAudioRef.current = null;
        return;
      }
    }
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
          identityToken: resolvedSpeaker.identityToken,
          speakerIdentity: resolvedSpeaker,
          memoryOptOut,
          timeSegment,
          profile: routedProfile,
          conversationContext: messages
        })
      });
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({ error: "后端请求失败" })) as { error?: string };
        throw new Error(errorPayload.error ?? `后端请求失败：HTTP ${response.status}`);
      }
      const data = (await response.json()) as ConverseResponse;
      setCurrentAgent(data.agent);
      setSpeakerIdentity(data.speakerIdentity ?? resolvedSpeaker);
      setMemory(data.memory ?? null);
      setFamilyMemory(data.familyMemory ?? null);
      if (data.timeSegment) setTimeSegment(data.timeSegment);
      setRouteResult(lockedAgentId ? null : { ...data.route, agentName: data.agent.displayName });
      if (data.task) addTaskToState(data.task);
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
      latestAudioRef.current = null;
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
    stopMicLevelMeter();
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    listeningSuppressedRef.current = false;
    void stopRealtimeVoice();
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

  function canUseRealtime(agent: AgentConfig) {
    if (!cozeVoiceStatus || cozeVoiceStatus.useMock) return false;
    const runtimeAgent = cozeVoiceStatus.realtimeAgents.find((item) => item.id === agent.id);
    return Boolean(
      runtimeAgent?.hasBotId
      && runtimeAgent.hasVoiceId
      && (runtimeAgent.hasRealtimeTokenValue || cozeVoiceStatus.hasToken)
    );
  }

  async function startRealtimeVoice(agent: AgentConfig, initialUserText?: string): Promise<boolean> {
    if (!agent || agent.cozeBotId.startsWith("replace_with_")) {
      setStatus(`${agent?.displayName ?? "当前智能体"}还没有配置 Coze bot，无法启动实时语音`);
      return false;
    }

    stopListeningTurn();
    conversationActiveRef.current = true;
    setIsConversationActive(true);
    clearSessionHold();
    stopCurrentAudio();
    clearRealtimeIdleTimer();
    clearRealtimeConnectTimer();
    realtimeMessageIdsRef.current.clear();
    realtimeUserTranscriptRef.current = "";
    realtimeAssistantTranscriptRef.current = "";
    realtimeHandoffInProgressRef.current = false;
    realtimeAgentIdRef.current = agent.id;
    setCurrentAgent(agent);
    setRouteResult(null);
    setIsRealtimeConnecting(true);
    setStatus(`正在连接${agent.displayName}实时语音`);

    try {
      const { EventNames, RealtimeClient, RealtimeUtils } = await import("@coze/realtime-api");
      const permission = await RealtimeUtils.checkDevicePermission();
      if (!permission.audio) {
        realtimeClientRef.current = null;
        realtimeAgentIdRef.current = null;
        setIsRealtimeConnecting(false);
        setIsRealtimeActive(false);
        conversationActiveRef.current = false;
        setIsConversationActive(false);
        setStatus(`需要麦克风权限才能启动${agent.displayName}实时语音`);
        return false;
      }

      const roomResponse = await fetch(`${apiBase}/api/coze/realtime-room`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: agent.id,
          voiceId: agent.cozeVoiceId,
          roomMode: "default"
        })
      });
      if (!roomResponse.ok) {
        const payload = await roomResponse.json().catch(() => ({ error: "创建实时语音房间失败" })) as { error?: string };
        throw new Error(payload.error ?? "创建实时语音房间失败");
      }
      const { room } = await roomResponse.json() as { room: RealtimeRoomInfo };

      const client = new RealtimeClient({
        baseURL: "https://api.coze.cn",
        accessToken: "room-token-issued-by-server",
        botId: agent.cozeBotId,
        connectorId: "1024",
        voiceId: agent.cozeVoiceId,
        userId: room.uid,
        audioMutedDefault: false,
        isAutoSubscribeAudio: true,
        suppressStationaryNoise: true,
        suppressNonStationaryNoise: true,
        debug: true,
        getRoomInfo: async () => room
      }) as RealtimeClientHandle;

      let initialMessageSent = false;
      const sendInitialTextIfNeeded = () => {
        if (initialMessageSent) return;
        initialMessageSent = true;
        window.setTimeout(() => {
          sendInitialRealtimeUserText(client, initialUserText);
        }, 180);
      };

      client.on(EventNames.CONNECTED, () => {
        clearRealtimeConnectTimer();
        setIsRealtimeActive(true);
        setStatus(`${agent.displayName}实时语音已连接，可以直接说话`);
        sendInitialTextIfNeeded();
      });
      client.on(EventNames.DISCONNECTED, () => {
        clearRealtimeConnectTimer();
        realtimeClientRef.current = null;
        realtimeAgentIdRef.current = null;
        setIsRealtimeActive(false);
        setStatus(`${agent.displayName}实时语音已断开`);
        if (conversationActiveRef.current && !realtimeHandoffInProgressRef.current) scheduleListening(300);
      });
      client.on(EventNames.AUDIO_USER_SPEECH_STARTED, () => {
        clearRealtimeIdleTimer();
        realtimeUserTranscriptRef.current = "";
        setStatus("正在听你说话");
      });
      client.on(EventNames.AUDIO_USER_SPEECH_STOPPED, () => {
        const finalText = realtimeUserTranscriptRef.current.trim();
        if (finalText && !realtimeHandoffInProgressRef.current) {
          appendMessage("user", finalText, agent.id);
        }
        setStatus(`已听到，${agent.displayName}正在想`);
        if (finalText && !realtimeHandoffInProgressRef.current) {
          void maybeHandoffRealtimeWeakIntent(finalText);
        }
      });
      client.on(EventNames.AUDIO_AGENT_SPEECH_STARTED, () => {
        clearRealtimeIdleTimer();
        realtimeAssistantTranscriptRef.current = "";
        setStatus(`${agent.displayName}正在实时回复`);
      });
      client.on(EventNames.AUDIO_AGENT_SPEECH_STOPPED, () => {
        appendPendingRealtimeAssistantMessage(agent.id);
        setStatus("等待输入");
        startRealtimeIdleTimer(agent.displayName);
      });
      client.on(EventNames.CONVERSATION_AUDIO_TRANSCRIPT_DELTA, (_eventName, event) => {
        const text = readRealtimeText(event);
        if (!text) return;
        const fullText = mergeRealtimeTranscript(realtimeUserTranscriptRef.current, text);
        realtimeUserTranscriptRef.current = fullText;
        setTranscript(fullText);
        void maybeHandoffRealtimeStrongIntent(fullText);
      });
      client.on(EventNames.CONVERSATION_MESSAGE_DELTA, (_eventName, event) => {
        const text = readRealtimeText(event);
        if (!text || isInternalRealtimeMessage(text)) return;
        realtimeAssistantTranscriptRef.current = mergeRealtimeTranscript(realtimeAssistantTranscriptRef.current, text);
      });
      client.on(EventNames.CONVERSATION_MESSAGE_COMPLETED, (_eventName, event) => {
        const text = readRealtimeText(event);
        const id = readRealtimeId(event);
        if (!text || isInternalRealtimeMessage(text)) return;
        if (id && realtimeMessageIdsRef.current.has(id)) return;
        if (id) realtimeMessageIdsRef.current.add(id);
        appendRealtimeAssistantMessage(text, agent.id);
        realtimeAssistantTranscriptRef.current = "";
      });
      client.on(EventNames.CONVERSATION_CHAT_FAILED, (_eventName, event) => {
        setStatus(`${agent.displayName}实时语音生成失败：${formatRealtimeEvent(event)}`);
      });
      client.on(EventNames.ERROR, (_eventName, event) => {
        setStatus(`${agent.displayName}实时语音错误：${formatRealtimeEvent(event)}`);
      });
      client.on(EventNames.SERVER_ERROR, (_eventName, event) => {
        setStatus(`Coze 实时语音服务错误：${formatRealtimeEvent(event)}`);
      });

      realtimeClientRef.current = client;
      startRealtimeConnectTimer(agent.displayName);
      await client.connect();
      sendInitialTextIfNeeded();
      return true;
    } catch (error) {
      clearRealtimeConnectTimer();
      realtimeClientRef.current = null;
      setIsRealtimeActive(false);
      realtimeAgentIdRef.current = null;
      setStatus(error instanceof Error ? `${agent.displayName}实时语音启动失败：${error.message}` : `${agent.displayName}实时语音启动失败`);
      if (conversationActiveRef.current && !realtimeHandoffInProgressRef.current) scheduleListening(300);
      return false;
    } finally {
      setIsRealtimeConnecting(false);
    }
  }

  function startRealtimeConnectTimer(agentName: string) {
    clearRealtimeConnectTimer();
    realtimeConnectTimerRef.current = window.setTimeout(() => {
      realtimeConnectTimerRef.current = null;
      if (!realtimeClientRef.current || isRealtimeActive) return;
      const client = realtimeClientRef.current;
      realtimeClientRef.current = null;
      realtimeAgentIdRef.current = null;
      setIsRealtimeConnecting(false);
      setIsRealtimeActive(false);
      void client.disconnect().catch(() => undefined);
      setStatus(`${agentName}实时语音连接超时，已恢复普通监听`);
      if (conversationActiveRef.current && !realtimeHandoffInProgressRef.current) scheduleListening(300);
    }, realtimeConnectTimeoutMs);
  }

  function clearRealtimeConnectTimer() {
    if (!realtimeConnectTimerRef.current) return;
    window.clearTimeout(realtimeConnectTimerRef.current);
    realtimeConnectTimerRef.current = null;
  }

  function sendInitialRealtimeUserText(client: RealtimeClientHandle, text?: string) {
    const content = text?.trim();
    if (!content) return;
    client.sendMessage({
      id: crypto.randomUUID(),
      event_type: "conversation.message.create",
      data: {
        role: "user",
        content,
        content_type: "text"
      }
    });
  }

  async function stopRealtimeVoice() {
    const client = realtimeClientRef.current;
    clearRealtimeConnectTimer();
    clearRealtimeIdleTimer();
    realtimeClientRef.current = null;
    realtimeAgentIdRef.current = null;
    realtimeMessageIdsRef.current.clear();
    realtimeUserTranscriptRef.current = "";
    realtimeAssistantTranscriptRef.current = "";
    setIsRealtimeConnecting(false);
    setIsRealtimeActive(false);
    setTranscript("");
    if (!client) return;
    try {
      await client.disconnect();
      setStatus("虎子实时语音已断开");
    } catch {
      setStatus("虎子实时语音已停止");
    }
    if (conversationActiveRef.current && !realtimeHandoffInProgressRef.current) scheduleListening(300);
  }

  function appendPendingRealtimeAssistantMessage(agentId: string) {
    const text = realtimeAssistantTranscriptRef.current.trim();
    appendRealtimeAssistantMessage(text, agentId);
    realtimeAssistantTranscriptRef.current = "";
  }

  function appendRealtimeAssistantMessage(text: string, agentId: string) {
    if (!text || isInternalRealtimeMessage(text)) return;
    const normalizedText = normalizeSpeechText(text);
    const alreadyAppended = Array.from(realtimeMessageIdsRef.current).includes(normalizedText);
    if (alreadyAppended) return;
    realtimeMessageIdsRef.current.add(normalizedText);
    appendMessage("assistant", text, agentId);
  }

  function clearRealtimeIdleTimer() {
    if (realtimeIdleTimerRef.current) {
      window.clearTimeout(realtimeIdleTimerRef.current);
      realtimeIdleTimerRef.current = null;
    }
    realtimeIdleHoldRef.current = null;
    setRealtimeIdleHold(null);
    setRealtimeIdleRemainingSeconds(0);
  }

  function startRealtimeIdleTimer(agentName: string) {
    clearRealtimeIdleTimer();
    const hold = {
      agentName,
      endsAt: Date.now() + realtimeIdleDisconnectMs
    };
    realtimeIdleHoldRef.current = hold;
    setRealtimeIdleHold(hold);
    setRealtimeIdleRemainingSeconds(Math.ceil(realtimeIdleDisconnectMs / 1000));
    realtimeIdleTimerRef.current = window.setTimeout(() => {
      if (!realtimeClientRef.current || realtimeHandoffInProgressRef.current) return;
      void stopRealtimeVoice();
      setStatus(`${agentName}回复结束后 20 秒未检测到输入，已自动断开实时语音`);
    }, realtimeIdleDisconnectMs);
    setStatus("等待输入");
  }

  async function maybeHandoffRealtimeStrongIntent(queryText: string) {
    if (realtimeHandoffInProgressRef.current) return;
    const strongAgent = matchLocalStrongIntent(queryText);
    const realtimeAgentId = realtimeAgentIdRef.current;
    if (!strongAgent || !realtimeAgentId || strongAgent.id === realtimeAgentId) return;
    await handoffRealtimeTo(strongAgent, queryText, "strong", `实时语音中命中${strongAgent.displayName}唤醒词，切换到 Coze 实时语音`, "strong-rule");
  }

  async function handoffRealtimeTo(agent: AgentConfig, queryText: string, intentStrength: "strong" | "weak", reason: string, source: "strong-rule" | "model" | "rule-fallback" | "session-lock") {
    realtimeHandoffInProgressRef.current = true;
    setStatus(`识别到意图：切换到 ${agent.displayName}`);
    try {
      await realtimeClientRef.current?.interrupt();
    } catch {
      // Continue with the handoff even if the interrupt command fails.
    }
    await stopRealtimeVoice();
    setCurrentAgent(agent);
    setTranscript("");
    if (canUseRealtime(agent)) {
      appendMessage("user", queryText, agent.id);
      setRouteResult({
        agentId: agent.id,
        intentStrength,
        reason,
        confidence: intentStrength === "strong" ? 0.98 : 0.86,
        source,
        agentName: agent.displayName
      });
      await startRealtimeVoice(agent, extractInitialRealtimeRequest(queryText, agent));
    } else {
      await sendMessage(queryText);
    }
    realtimeHandoffInProgressRef.current = false;
  }

  async function maybeHandoffRealtimeWeakIntent(queryText: string) {
    const realtimeAgentId = realtimeAgentIdRef.current;
    if (!realtimeAgentId || realtimeHandoffInProgressRef.current) return;
    if (queryText.length < 4) return;
    try {
      const response = await fetch(`${apiBase}/api/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queryText,
          currentAgentId: currentAgent?.id ?? realtimeAgentId,
          profile,
          conversationContext: messages,
          timeSegment
        })
      });
      if (!response.ok) return;
      const data = (await response.json()) as { agent?: AgentConfig; route?: RouteOutput };
      const target = data.agent;
      if (!target?.id || target.id === realtimeAgentId) return;
      if (data.route?.intentStrength === "strong") return;
      await handoffRealtimeTo(target, queryText, "weak", `实时语音中识别到「${target.displayName}」意图，切换到 ${target.displayName}`, data.route?.source ?? "model");
    } catch {
      // 弱意图路由检查失败时不打断当前会话
    }
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
    clearSpeechFinalizeTimer();
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
    resetAudioFallbackActivity();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startMicLevelMeter(stream);
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      latestAudioRef.current = new Blob(audioChunksRef.current, { type: mimeType });
      stream.getTracks().forEach((track) => track.stop());
      stopMicLevelMeter();
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
      stopMicLevelMeter();
      return;
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    stopMicLevelMeter();
  }

  function startMicLevelMeter(stream: MediaStream) {
    stopMicLevelMeter();
    const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const audioContext = new AudioContextCtor();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      const average = samples.reduce((sum, value) => sum + Math.abs(value - 128), 0) / samples.length;
      const level = Math.min(100, Math.round((average / 36) * 100));
      setMicLevel(level);
      handleMicLevel(level);
      audioLevelTimerRef.current = window.requestAnimationFrame(tick);
    };
    audioContextRef.current = audioContext;
    tick();
  }

  function stopMicLevelMeter() {
    if (audioLevelTimerRef.current) {
      window.cancelAnimationFrame(audioLevelTimerRef.current);
      audioLevelTimerRef.current = null;
    }
    void audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    setMicLevel(0);
  }

  async function waitForAudioReady() {
    if (latestAudioRef.current) return latestAudioRef.current;
    return new Promise<Blob | null>((resolve) => {
      const timeout = window.setTimeout(() => {
        audioReadyResolverRef.current = null;
        resolve(latestAudioRef.current);
      }, 1200);
      audioReadyResolverRef.current = (audio) => {
        window.clearTimeout(timeout);
        resolve(audio);
      };
      if (mediaRecorderRef.current?.state === "recording") {
        stopAudioCapture();
      } else if (!mediaRecorderRef.current) {
        window.clearTimeout(timeout);
        audioReadyResolverRef.current = null;
        resolve(latestAudioRef.current);
      }
    });
  }

  function resetAudioFallbackActivity() {
    micSpeechStartedAtRef.current = 0;
    lastMicVoiceAtRef.current = 0;
  }

  function handleMicLevel(level: number) {
    if (!conversationActiveRef.current || isSendingRef.current || isPlayingRef.current || listeningSuppressedRef.current) return;
    if (sttFallbackInFlightRef.current || !mediaRecorderRef.current || mediaRecorderRef.current.state !== "recording") return;

    const now = Date.now();
    if (level >= backendSttVoiceLevel) {
      if (!micSpeechStartedAtRef.current) micSpeechStartedAtRef.current = now;
      lastMicVoiceAtRef.current = now;
      return;
    }

    const speechStartedAt = micSpeechStartedAtRef.current;
    const lastVoiceAt = lastMicVoiceAtRef.current;
    if (!speechStartedAt || !lastVoiceAt) return;
    if (now - lastVoiceAt < backendSttSilenceMs) return;
    if (now - speechStartedAt < backendSttMinSpeechMs) {
      resetAudioFallbackActivity();
      return;
    }
    if ((finalTranscriptRef.current || latestTranscriptRef.current).trim()) return;
    if (recognitionRef.current) return;
    reportSpeechDebug("fallback-triggered", {
      lastMicVoiceAt: lastMicVoiceAtRef.current,
      speechStartedAt: micSpeechStartedAtRef.current
    });
    void transcribeCurrentAudioFallback();
  }

  async function transcribeCurrentAudioFallback() {
    if (sttFallbackInFlightRef.current || isSendingRef.current) return;
    if ((finalTranscriptRef.current || latestTranscriptRef.current).trim()) return;
    sttFallbackInFlightRef.current = true;
    resetAudioFallbackActivity();
    recognitionFinalizedRef.current = true;
    clearSpeechFinalizeTimer();
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    try {
      recognition?.stop();
    } catch {
      // Recognition may already be stopped by the browser.
    }
    setIsListening(false);
    setStatus("浏览器没有返回文字，正在后端转写");

    try {
      const audio = await waitForAudioReady();
      if (!audio || audio.size < 1200) {
        setStatus("没有录到有效语音，继续监听");
        reportSpeechDebug("fallback-empty-audio", { size: audio?.size ?? 0 });
        scheduleListening(250);
        return;
      }

      const form = new FormData();
      form.append("audio", audio, "speech.webm");
      reportSpeechDebug("fallback-upload", { size: audio.size, type: audio.type });
      const response = await fetch(`${apiBase}/api/transcribe/audio`, {
        method: "POST",
        body: form
      });
      const result = (await response.json().catch(() => ({}))) as { text?: string; error?: string; elapsedMs?: number };
      if (!response.ok) {
        throw new Error(result.error ?? "后端转写失败");
      }

      const text = (result.text ?? "").trim();
      if (!text) {
        setStatus("后端也没有转写出文字，继续监听");
        reportSpeechDebug("fallback-empty-text", { elapsedMs: result.elapsedMs });
        scheduleListening(250);
        return;
      }

      setTranscript(text);
      setDraft(text);
      latestTranscriptRef.current = text;
      finalTranscriptRef.current = text;
      setStatus(`后端转写完成${result.elapsedMs ? `（${(result.elapsedMs / 1000).toFixed(1)}s）` : ""}，正在自动发送`);
      reportSpeechDebug("fallback-result", { text, elapsedMs: result.elapsedMs });
      await finalizeRecognizedText(text);
    } catch (error) {
      setStatus(error instanceof Error ? `语音转写失败：${error.message}` : "语音转写失败，继续监听");
      reportSpeechDebug("fallback-error", { error: error instanceof Error ? error.message : String(error) });
      scheduleListening(500);
    } finally {
      sttFallbackInFlightRef.current = false;
    }
  }

  async function resolveSpeakerIdentity(signal: AbortSignal): Promise<SpeakerIdentity> {
    const audio = latestAudioRef.current;
    if (!audio || audio.size === 0) {
      const selectedUser = registeredUsers.find((user) => user.userId === claimedUserId);
      const manualIdentity: SpeakerIdentity = {
        userId: claimedUserId || undefined,
        displayName: selectedUser?.displayName,
        familyRole: selectedUser?.familyRole,
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
      if (result.userId && result.identityToken) {
        setClaimedUserId(result.userId);
        setFamilyRole(result.familyRole ?? "unknown");
        const memoryResponse = await fetch(`${apiBase}/api/memory/${encodeURIComponent(result.userId)}`, {
          signal,
          headers: { "x-speaker-identity-token": result.identityToken }
        });
        const memoryData = (await memoryResponse.json()) as { memory: UserMemorySnapshot };
        setMemory(memoryData.memory);
      } else {
        if (result.userId) setClaimedUserId(result.userId);
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
      form.append("familyRole", familyRole);
      const response = await fetch(`${apiBase}/api/speaker/register`, {
        method: "POST",
        body: form
      });
      const result = await response.json() as { userId: string; displayName?: string; familyRole: FamilyRole; sampleCount: number; centroidReady: boolean; message: string };
      setClaimedUserId(result.userId);
      setFamilyRole(result.familyRole);
      if (result.displayName) setSpeakerDisplayName(result.displayName);
      setStatus(result.message);
      await refreshSpeakerUsers();
    } catch {
      setStatus("声纹注册失败，请确认后端和 Python 声纹环境可用");
    } finally {
      latestAudioRef.current = null;
      setIsRegisteringSpeaker(false);
    }
  }

  async function clearCurrentMemory() {
    if (!claimedUserId || !speakerIdentity?.identityToken) {
      setStatus("请先完成声纹验证，再清除长期记忆");
      return;
    }
    const response = await fetch(`${apiBase}/api/memory/${encodeURIComponent(claimedUserId)}`, {
      method: "DELETE",
      headers: { "x-speaker-identity-token": speakerIdentity.identityToken }
    });
    const data = (await response.json()) as { memory: UserMemorySnapshot };
    setMemory(data.memory);
    setStatus("已清除当前用户长期记忆");
  }

  async function toggleAutoImprove(enabled: boolean) {
    if (!claimedUserId || !speakerIdentity?.identityToken) {
      setStatus("请先完成声纹验证，再修改声纹优化设置");
      return;
    }
    await fetch(`${apiBase}/api/speaker/auto-improve`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-speaker-identity-token": speakerIdentity.identityToken
      },
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
      error: reason === "session-lock" ? "20 秒内连续对话，跳过声音画像" : "强意图已明确，跳过声音画像"
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
      if (shouldApplyVoiceProfile(result)) {
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
        scheduleListening(resumeListeningAfterPlaybackMs);
      };
      player.onerror = () => {
        isPlayingRef.current = false;
        listeningSuppressedRef.current = false;
        URL.revokeObjectURL(audioUrl);
        scheduleListening(resumeListeningAfterPlaybackMs);
      };
      isPlayingRef.current = true;
      await player.play();
      return;
    } catch {
      speakWithBrowser(text, agentName, agentId);
    }
  }

  function speakWithBrowser(text: string, agentName = currentAgent?.displayName ?? "当前智能体", agentId = currentAgent?.id) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = agentId === "study-coach" ? "en-US" : "zh-CN";
    utterance.rate = 1;
    utterance.onend = () => {
      isPlayingRef.current = false;
      listeningSuppressedRef.current = false;
      lastAssistantAudioEndedAtRef.current = Date.now();
      startSessionHold(agentId, agentName);
      scheduleListening(resumeListeningAfterPlaybackMs);
    };
    utterance.onerror = () => {
      isPlayingRef.current = false;
      listeningSuppressedRef.current = false;
      scheduleListening(resumeListeningAfterPlaybackMs);
    };
    isPlayingRef.current = true;
    window.speechSynthesis.speak(utterance);
  }

  function currentSpeakerUser() {
    return registeredUsers.find((user) => user.userId === claimedUserId);
  }

  function changeClaimedUser(userId: string) {
    setClaimedUserId(userId);
    const user = registeredUsers.find((item) => item.userId === userId);
    if (user) setFamilyRole(user.familyRole);
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
            <select value={claimedUserId} onChange={(event) => changeClaimedUser(event.target.value)}>
              <option value="">自动识别</option>
              {registeredUsers.map((user) => (
                <option key={user.userId} value={user.userId}>
                  {user.displayName || user.userId} · {familyRoleLabel(user.familyRole)}{user.centroidReady ? "" : "（未完成）"}
                </option>
              ))}
            </select>
          </label>
          <label>
            注册绑定角色
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

        <div className={isCozeVoiceReady(cozeVoiceStatus) ? "route-result detected" : "route-result"}>
          <span>Coze 原声</span>
          {renderCozeVoiceStatus(cozeVoiceStatus)}
        </div>

        <div className="voice-panel">
          <button className={isConversationActive ? "recording" : ""} onClick={toggleConversation}>
            {isRealtimeConnecting ? `连接${currentAgent?.displayName ?? "实时语音"}中` : isRealtimeActive ? `${currentAgent?.displayName ?? "智能体"}实时中，点按停止` : isConversationActive ? (isListening ? "监听中，点按停止" : "对话中，点按停止") : "开始"}
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
        <div className="mic-meter" aria-label="麦克风输入电平">
          <span>麦克风</span>
          <div className="mic-meter-track">
            <i style={{ width: `${micLevel}%` }} />
          </div>
          <strong>{isListening ? (micLevel > 4 ? "检测到声音" : "等待声音") : "未监听"}</strong>
        </div>
        <p className="status">{status}{transcript ? ` · ${transcript}` : ""}</p>
        {realtimeIdleHold && realtimeIdleRemainingSeconds > 0
          ? <p className="status realtime-idle-countdown">{realtimeIdleHold.agentName}回复完成，{realtimeIdleRemainingSeconds} 秒内没有输入将自动断开</p>
          : null}
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
                <small>唤醒词：{formatWakeWords(agent)}</small>
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

      <section className="mobile-demo-section">
        <div className="mobile-demo-copy">
          <p className="eyebrow">手机端 App</p>
          <h2>多智能体控制台</h2>
          <p>覆盖用户旅程里的能力了解、实时切换、异步提醒和后台设置，作为硬件音箱之外的可视化入口。</p>
        </div>
        <div className="phone-shell" aria-label="手机端多智能体控制台预览">
          <div className="phone-statusbar">
            <span>9:41</span>
            <span>5G  92%</span>
          </div>
          <div className="phone-header">
            <div>
              <small>当前 Agent</small>
              <strong>{currentAgent?.displayName ?? "载入中"}</strong>
            </div>
            {currentAgent ? <img src={currentAgent.gifPath} alt="" /> : null}
          </div>
          <nav className="phone-tabs" aria-label="手机端功能页签">
            {mobileTabs.map((tab) => (
              <button
                key={tab.id}
                className={mobileTab === tab.id ? "active" : ""}
                onClick={() => setMobileTab(tab.id)}
              >
                <span>{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </nav>
          <div className="phone-screen">
            {mobileTab === "agents" ? (
              <MobileAgentsView
                agents={agents}
                currentAgent={currentAgent}
                onSelect={(agent) => setCurrentAgent(agent)}
              />
            ) : null}
            {mobileTab === "chat" ? (
              <MobileChatView
                agents={agents}
                currentAgent={currentAgent}
                routeResult={routeResult}
                sessionHold={sessionHold}
                holdRemainingSeconds={holdRemainingSeconds}
                isConversationActive={isConversationActive}
                isListening={isListening}
                isRealtimeActive={isRealtimeActive}
                status={status}
                transcript={transcript}
                micLevel={micLevel}
                onToggleConversation={toggleConversation}
              />
            ) : null}
            {mobileTab === "tasks" ? (
              <MobileTasksView tasks={tasks} agents={agents} />
            ) : null}
            {mobileTab === "settings" ? (
              <MobileSettingsView
                agents={agents}
                profile={profile}
                setProfile={setProfile}
                cozeVoiceStatus={cozeVoiceStatus}
              />
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

function isTaskFiredEvent(payload: TaskFiredEvent | { type: string }): payload is TaskFiredEvent {
  return payload.type === "task:fired";
}

const mobileTabs: Array<{ id: MobileTab; label: string; icon: string }> = [
  { id: "agents", label: "能力", icon: "◇" },
  { id: "chat", label: "对话", icon: "◎" },
  { id: "tasks", label: "提醒", icon: "□" },
  { id: "settings", label: "设置", icon: "⚙" }
];

function MobileAgentsView({
  agents,
  currentAgent,
  onSelect
}: {
  agents: AgentConfig[];
  currentAgent?: AgentConfig;
  onSelect: (agent: AgentConfig) => void;
}) {
  return (
    <div className="mobile-view agent-library-view">
      <div className="phone-section-title">
        <strong>Agent Library</strong>
        <span>{agents.length} 个可用</span>
      </div>
      <div className="mobile-agent-grid">
        {agents.map((agent) => (
          <button
            key={agent.id}
            className={agent.id === currentAgent?.id ? "active" : ""}
            onClick={() => onSelect(agent)}
          >
            <img src={agent.gifPath} alt="" />
            <strong>{agent.displayName}</strong>
            <small>{agent.serviceScenes.slice(0, 2).join(" / ")}</small>
          </button>
        ))}
      </div>
      {currentAgent ? (
        <div className="phone-card featured-agent">
          <img src={currentAgent.gifPath} alt="" />
          <div>
            <span>唤醒词</span>
            <strong>{formatWakeWords(currentAgent)}</strong>
            <p>{currentAgent.defaultPromptHint}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MobileChatView({
  agents,
  currentAgent,
  routeResult,
  sessionHold,
  holdRemainingSeconds,
  isConversationActive,
  isListening,
  isRealtimeActive,
  status,
  transcript,
  micLevel,
  onToggleConversation
}: {
  agents: AgentConfig[];
  currentAgent?: AgentConfig;
  routeResult: (RouteOutput & { agentName: string }) | null;
  sessionHold: SessionHold | null;
  holdRemainingSeconds: number;
  isConversationActive: boolean;
  isListening: boolean;
  isRealtimeActive: boolean;
  status: string;
  transcript: string;
  micLevel: number;
  onToggleConversation: () => void;
}) {
  return (
    <div className="mobile-view live-control-view">
      <div className="phone-card live-agent-card">
        {currentAgent ? <img src={currentAgent.gifPath} alt="" /> : null}
        <div>
          <span>实时交互</span>
          <strong>{currentAgent?.displayName ?? "等待选择"}</strong>
          <p>{sessionHold && holdRemainingSeconds > 0 ? `${holdRemainingSeconds} 秒内继续由 ${sessionHold.agentName} 回答` : status}</p>
        </div>
      </div>
      <div className="route-radar" aria-label="智能体路由示意">
        {agents.map((agent, index) => (
          <button
            key={agent.id}
            className={agent.id === currentAgent?.id ? "active" : ""}
            style={{ transform: `rotate(${index * 72}deg) translate(86px) rotate(-${index * 72}deg)` }}
          >
            <img src={agent.gifPath} alt={agent.displayName} />
          </button>
        ))}
        <div className="route-radar-core">
          <strong>{routeResult?.intentStrength === "strong" ? "强意图" : "弱意图"}</strong>
          <span>{routeResult?.agentName ?? currentAgent?.displayName ?? "待路由"}</span>
        </div>
      </div>
      <div className="phone-card voice-state-card">
        <span>{isRealtimeActive ? "Coze 实时通话" : isListening ? "正在监听" : isConversationActive ? "对话运行中" : "待机"}</span>
        <div className="phone-mic-track">
          <i style={{ width: `${micLevel}%` }} />
        </div>
        <p>{transcript || "说出需求，系统会匹配合适的智能体"}</p>
      </div>
      <button className={isConversationActive ? "phone-primary danger" : "phone-primary"} onClick={onToggleConversation}>
        {isConversationActive ? "停止对话" : "开始语音"}
      </button>
    </div>
  );
}

function MobileTasksView({ tasks, agents }: { tasks: ReminderTask[]; agents: AgentConfig[] }) {
  const visibleTasks = tasks.length ? tasks : demoReminderTasks;
  return (
    <div className="mobile-view tasks-view">
      <div className="phone-section-title">
        <strong>异步提醒</strong>
        <span>{tasks.length ? "来自真实任务" : "示例"}</span>
      </div>
      <div className="task-command-card">
        <span>语音任务</span>
        <strong>提醒小朋友 20 分钟后写作业</strong>
        <small>到点后自动唤起儿童友好 agent</small>
      </div>
      <div className="mobile-task-list">
        {visibleTasks.map((task) => {
          const agent = agents.find((item) => item.id === task.reminderAgentId);
          return (
            <article key={task.taskId}>
              <div>
                <strong>{task.message}</strong>
                <span>{task.audience} · {agent?.displayName ?? "虎子"}</span>
              </div>
              <time>{new Date(task.triggerAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function MobileSettingsView({
  agents,
  profile,
  setProfile,
  cozeVoiceStatus
}: {
  agents: AgentConfig[];
  profile: UserProfile;
  setProfile: (profile: UserProfile) => void;
  cozeVoiceStatus: CozeVoiceRuntimeStatus | null;
}) {
  const [isAddAgentOpen, setIsAddAgentOpen] = useState(false);

  return (
    <div className="mobile-view settings-view">
      <div className="phone-section-title">
        <strong>后台设置</strong>
        <span>{cozeVoiceStatus ? `${countReadyRealtimeAgents(cozeVoiceStatus)}/${cozeVoiceStatus.realtimeAgents.length} 可用` : "检查中"}</span>
      </div>
      <button className="add-agent-button" onClick={() => setIsAddAgentOpen(true)}>
        <span>+</span>
        添加新的智能体
      </button>
      <div className="settings-panel-card">
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
      <div className="settings-permission-summary">
        <div>
          <strong>旁听权限</strong>
          <span>开启后，智能体可接收其他智能体的上下文摘要，用于跨 agent 连续服务。</span>
        </div>
      </div>
      <div className="settings-toggle-list">
        {agents.map((agent) => (
          <article key={agent.id}>
            <img src={agent.gifPath} alt="" />
            <div>
              <strong>{agent.displayName}</strong>
              <span>已开启 · 上下文摘要</span>
            </div>
            <button className="listen-toggle" aria-label={`${agent.displayName}旁听权限已开启`} />
          </article>
        ))}
      </div>
      {isAddAgentOpen ? (
        <div className="mobile-modal-backdrop" role="dialog" aria-modal="true" aria-label="添加新的智能体">
          <div className="mobile-modal">
            <button className="modal-close-button" onClick={() => setIsAddAgentOpen(false)} aria-label="关闭">×</button>
            <span className="modal-kicker">Add Agent</span>
            <h3>接入新的语音智能体</h3>
            <p>准备好 Coze bot id、Realtime SDK token、头像/GIF 和唤醒词，就可以把它加入 Agent 池。</p>
            <div className="modal-step-list">
              <span>1. 填写智能体名称和服务场景</span>
              <span>2. 配置 bot id 与实时语音 token</span>
              <span>3. 设置唤醒词、头像和旁听权限</span>
            </div>
            <button className="modal-primary-button" onClick={() => setIsAddAgentOpen(false)}>开始配置</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const demoReminderTasks: ReminderTask[] = [
  {
    taskId: "demo-homework",
    createdByAgentId: "companion-lan",
    triggerAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    audience: "小朋友",
    message: "温和提醒写作业",
    reminderAgentId: "little-fox",
    status: "scheduled"
  },
  {
    taskId: "demo-tv",
    createdByAgentId: "companion-lan",
    triggerAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    audience: "家庭",
    message: "检查看电视时间",
    reminderAgentId: "companion-lan",
    status: "scheduled"
  }
];

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

function shouldApplyVoiceProfile(result: VoiceProfileResult) {
  if (result.source !== "voice") return false;
  if (result.gender !== "unknown" && result.genderConfidence < 0.68) return false;
  return true;
}

function pickSpeechTranscript(result: SpeechRecognitionResult, agentId?: string, agents: AgentConfig[] = []) {
  const alternatives = Array.from({ length: result.length }, (_, index) => result[index]?.transcript ?? "");
  const wakeWords = agents.flatMap((agent) => [agent.displayName, ...agent.aliases]).filter(Boolean);
  const wakeCandidate = alternatives.find((text) => wakeWords.some((wakeWord) => text.includes(wakeWord)));
  if (wakeCandidate) return wakeCandidate;
  if (agentId !== "study-coach") return result[0]?.transcript ?? "";
  if (alternatives.some((text) => /\p{Script=Han}/u.test(text))) return result[0]?.transcript ?? "";
  return alternatives
    .sort((a, b) => englishTranscriptScore(b) - englishTranscriptScore(a))[0] ?? "";
}

function englishTranscriptScore(text: string) {
  const asciiLetters = (text.match(/[a-zA-Z]/g) ?? []).length;
  const hanChars = (text.match(/\p{Script=Han}/gu) ?? []).length;
  return asciiLetters - hanChars * 3 + text.length * 0.01;
}

function renderCozeVoiceStatus(status: CozeVoiceRuntimeStatus | null) {
  if (!status) return <strong>检查中</strong>;
  if (status.useMock) return <strong>mock 模式，未启用 Coze 原声</strong>;
  const readyAgents = status.realtimeAgents
    .filter(isRealtimeAgentReady)
    .map((agent) => agent.displayName);
  const readyCount = readyAgents.length;
  const totalCount = status.realtimeAgents.length;
  if (!status.hasToken && !status.hasAnyRealtimeToken) {
    return <strong>未连接：缺少通用 Coze token、CLI 登录态和 realtime token</strong>;
  }
  return (
    <>
      <strong>{readyCount}/{totalCount} 实时建房可用</strong>
      <strong>{readyAgents.length ? readyAgents.join("、") : "暂无可用 agent"}</strong>
      <span>{status.hasToken ? "通用 Coze token 已连接" : "通用 Coze token 未连接，当前依赖各 agent 的 realtime token"}</span>
      <span>{status.hasCliProxy ? "CLI 刷新会走代理" : "未配置 CLI 代理"}</span>
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
        <strong>{identitySourceLabel(result.source)} · {familyRoleLabel(result.familyRole ?? "unknown")}{similarity}</strong>
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

function isCozeVoiceReady(status: CozeVoiceRuntimeStatus | null) {
  if (!status || status.useMock) return false;
  return status.hasToken || status.hasAnyRealtimeToken;
}

function isRealtimeAgentReady(agent: CozeVoiceRuntimeStatus["realtimeAgents"][number]) {
  return agent.hasBotId && agent.hasVoiceId && agent.hasRealtimeTokenValue;
}

function countReadyRealtimeAgents(status: CozeVoiceRuntimeStatus | null) {
  if (!status) return 0;
  return status.realtimeAgents.filter(isRealtimeAgentReady).length;
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

function formatSpeechRecognitionError(error?: string) {
  const labels: Record<string, string> = {
    "no-speech": "没有检测到可识别语音，请靠近麦克风再说",
    "audio-capture": "浏览器没有拿到麦克风音频，请检查系统输入设备",
    "not-allowed": "浏览器麦克风权限被拒绝，请重新允许麦克风",
    "network": "浏览器语音识别服务网络失败，可检查 VPN/代理或改用文本输入",
    "service-not-allowed": "浏览器语音识别服务不可用，请检查浏览器设置",
    "language-not-supported": "当前识别语言不可用，请换 Chrome 或改用文本输入",
    "aborted": "语音识别被中断，正在重新监听"
  };
  return `语音识别失败：${labels[error ?? ""] ?? error ?? "未知错误"}`;
}

function formatWakeWords(agent: AgentConfig) {
  return [agent.displayName, ...agent.aliases].filter(Boolean).join(" / ");
}

function extractInitialRealtimeRequest(queryText: string, agent: AgentConfig): string | undefined {
  const wakeWords = [agent.displayName, ...agent.aliases].filter(Boolean).sort((a, b) => b.length - a.length);
  let request = queryText.trim();
  for (const wakeWord of wakeWords) {
    request = request.replace(new RegExp(escapeRegExp(wakeWord), "g"), " ");
  }
  request = request
    .replace(/[，,。.!！?？、：:；;~～\s]+/g, " ")
    .trim();
  if (!request || /^(你好|您好|哈喽|hello|hi)$/i.test(request)) return undefined;
  return request;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function readRealtimeText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const record = event as Record<string, unknown>;
  const content = record.content ?? record.text ?? record.delta;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => typeof item === "string" ? item : readRealtimeText(item))
      .join("")
      .trim();
  }
  if (content && typeof content === "object") return readRealtimeText(content);
  const data = record.data;
  if (typeof data === "string") return data.trim();
  if (data && typeof data === "object") return readRealtimeText(data);
  return "";
}

function readRealtimeId(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const id = record.id ?? record.message_id ?? record.chat_id;
  return typeof id === "string" ? id : undefined;
}

function mergeRealtimeTranscript(previous: string, next: string) {
  if (!previous) return next;
  if (!next) return previous;
  if (next.includes(previous)) return next;
  if (previous.includes(next)) return previous;
  return next.length >= previous.length ? next : previous;
}

function isInternalRealtimeMessage(text: string) {
  return /^\s*[{[]/.test(text) || /"msg_type"\s*:/.test(text) || /generate_answer_finish|empty result|from_module|from_unit/.test(text);
}

function formatRealtimeEvent(event: unknown) {
  if (event instanceof Error) return event.message;
  if (typeof event === "string") return event;
  try {
    return JSON.stringify(event);
  } catch {
    return "未知错误";
  }
}
