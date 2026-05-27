# 多智能体语音切换 Demo

本项目是一个 Mac 本地浏览器 Demo：用户语音输入后，系统识别强/弱意图并切换到合适的 Coze 智能体，同时展示绑定 GIF，并支持“到点提醒写作业”的内存态异步任务闭环。

## 启动

```bash
npm install
cp .env.example .env
npm run dev
```

打开 Vite 显示的本地地址。Chrome 或 Edge 对 Web Speech API 支持最好。

## Coze 配置

首版默认 `COZE_USE_MOCK=true`，可以在没有真实 Coze 凭证时完整演示路由、GIF 切换、语音播报和异步提醒。

接入真实扣子智能体时：

1. 在 `.env` 填入 `COZE_API_TOKEN`。
2. 在 `server/agents.ts` 替换每个 `cozeBotId`。
3. 将 `COZE_USE_MOCK=false`。
4. 在 `server/cozeAdapter.ts` 内按账号实际开通的实时语音 API 补齐请求实现。

API token 只在后端读取，前端不会暴露。

## 意图路由

当前路由流程：

1. 强意图先用规则匹配 agent 名称、别名和唤醒词。
2. 弱意图优先调用 OpenAI-compatible Chat Completions 模型路由。
3. 如果没有配置模型或模型调用失败，自动回退到本地规则和打分。

可选模型路由配置：

```bash
LLM_ROUTER_BASE_URL=https://api.openai.com/v1
LLM_ROUTER_API_KEY=your_api_key
LLM_ROUTER_MODEL=gpt-5.2
```

也可以填任何兼容 `/chat/completions` 的模型服务地址。

## 本地声音画像测速

项目内提供了一个可选脚本，用于测试轻量版年龄/性别识别模型：

```bash
python3.11 -m venv .venv-age
.venv-age/bin/python -m pip install --upgrade pip torch torchaudio transformers huggingface_hub soundfile numpy
.venv-age/bin/python tools/profile_voice.py path/to/voice_16k.wav --seconds 2
```

默认模型是 `audeering/wav2vec2-large-robust-6-ft-age-gender`，输入要求为 16 kHz WAV。首次运行会下载 Hugging Face 模型；缓存后在本机测试音频上，2 秒音频约 0.67 秒完成，4 秒音频约 1.01 秒完成。真实效果需要用中文人声样本再评估。

网页已接入声音画像：点击“开始录音”后会同时保存一小段浏览器音频，发送消息时先上传到 `/api/profile/audio`，后端用 `ffmpeg` 转成 16 kHz WAV，再调用本地 Python 模型输出 `ageGroup/gender`，并把结果用于本轮 agent 路由。当前实现每次请求都会启动一次 Python 进程，适合网页直接测试效果；如果要降低延迟，下一步应改成常驻 Python 推理服务。
