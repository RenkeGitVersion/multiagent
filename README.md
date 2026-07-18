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
2. 在 `server/agents.config.json` 替换每个 `cozeBotId` 和可选的 `cozeVoiceId`。
3. 将 `COZE_USE_MOCK=false`。
4. 当前真实模式会调用 Coze `/v3/chat` 创建会话，并轮询 `/v3/chat/retrieve` 与 `/v3/chat/message/list` 获取回复；如果 agent 配置了 `cozeVoiceId`，前端会自动播放 Coze `/v1/audio/speech` 生成的原生音色语音。

API token 只在后端读取，前端不会暴露。

本地 `.env` 可设置：

```bash
COZE_USE_MOCK=false
COZE_USE_CLI_TOKEN=true
```

`COZE_USE_CLI_TOKEN=true` 时会读取 `coze auth login --oauth` 保存的 CLI OAuth token。实测你自己的“虎子”智能体 `7645562795198742562` 可通过 OpenAPI 调用；API 管理页里的 `cztei_...` token 在当前 `/v3/chat` Bearer 调用下返回 4101，可能属于 Playground/Chat SDK 渠道令牌，不等同于 OpenAPI OAuth token。公开英语学习智能体 `7374811613293150208` 返回资源不存在/未授权，不能直接作为 API bot 使用，需要换成你自己空间里已发布到 Agent as API 的英语学习 bot。

Coze Chat SDK 适合直接在网页中嵌入官方聊天窗，配置项包括 `type=bot`、`bot_id` 和 `isIframe` 等；当前 demo 是自定义多智能体路由 UI，因此默认使用后端 OpenAPI 获取回复。如果希望某个 agent 点击后直接打开 Coze 官方聊天窗，可以单独接 Chat SDK。

### Coze 原生音色播放

回复生成后，前端会自动请求后端 `/api/speech`，由后端调用 Coze `/v1/audio/speech` 按当前 agent 的 `cozeVoiceId` 合成 mp3 并播放。Coze 音频不可用时才回退到浏览器 `speechSynthesis`。

本地 `.env` 需要：

```bash
COZE_USE_MOCK=false
COZE_USE_CLI_TOKEN=true
```

虎子当前配置的音色是“佩奇猪”，voice ID 是 `7468512265134882867`。API token 只在后端读取，前端不会暴露。

## 会话保持

用户与某个 agent 完成一轮对话后，10 秒内继续输入会保持由当前 agent 回复，并跳过声音画像和弱意图路由；如果用户明确说出另一个 agent 的名称或唤醒词，强意图会立即切换到对应 agent。

## Agent World

每个本地 agent 都预留了 Agent World 身份字段：

- `agentWorldUsername`
- `agentWorldApiKey`
- `agentWorldProfileUrl`

注册或查询：

```bash
npx tsx tools/agent_world.ts register little-fox
npx tsx tools/agent_world.ts profile little-fox
```

注册会返回 `api_key`、`verification_code` 和挑战题。解出挑战题后激活：

```bash
npx tsx tools/agent_world.ts verify <verification_code> <answer>
```

激活成功后，把返回的 `api_key` 填入 `server/agents.config.json` 对应 agent 的 `agentWorldApiKey`。挑战题 5 分钟过期，最多 5 次尝试。

## 意图路由

当前路由流程：

1. 强意图先用规则匹配 agent 名称、别名和唤醒词。
2. 弱意图先基于 query、年龄/性别画像、家庭角色、时间段、长期记忆和常用 agent 召回 TOP3 候选 agent。
3. 如果配置了 OpenAI-compatible 路由模型，只把 TOP3 候选交给 LLM 做最终语义匹配，并限制输出为短 JSON。
4. 如果没有配置模型或模型调用失败，自动回退到 TOP3 中分数最高的本地候选。

可选模型路由配置：

```bash
LLM_ROUTER_BASE_URL=https://api.openai.com/v1
LLM_ROUTER_API_KEY=your_api_key
LLM_ROUTER_MODEL=gpt-5.5
LLM_ROUTER_WIRE_API=responses
LLM_ROUTER_REASONING_EFFORT=high
LLM_ROUTER_MAX_OUTPUT_TOKENS=80
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

网页已接入声音画像：点击“开始录音”后会同时保存一小段浏览器音频，发送消息时先上传到 `/api/profile/audio`，后端用 `ffmpeg` 转成最多 3 秒的 16 kHz WAV，再交给本地 Python 模型输出 `ageGroup/gender`，并把结果用于本轮 agent 路由。

后端默认会启动一个常驻 Python 画像进程，首次请求加载 `audeering/wav2vec2-large-robust-6-ft-age-gender` 模型，后续请求通过 stdin/stdout JSONL 复用同一个模型实例，避免每轮都重新加载。若常驻进程启动或请求失败，会自动回退到单次 Python 进程；如需强制关闭常驻模式，可设置：

```bash
VOICE_PROFILE_USE_SERVICE=false
VOICE_PROFILE_SECONDS=1.5
VOICE_PROFILE_SERVICE_STARTUP_TIMEOUT_MS=60000
VOICE_PROFILE_SERVICE_TIMEOUT_MS=30000
```

## 声纹识别与长期记忆

项目已新增本地声纹身份层：用户可以在网页中录制多段注册样本，后端提取 speaker embedding 并为每个 `user_id` 维护 centroid。每轮语音输入会先尝试验证或识别说话人，只有身份可信时才读取或写入该用户的长期记忆。

声纹原始音频不会长期保存。后端默认只保存 embedding、centroid、质量摘要和用户记忆 JSON：

```text
server/.data/speaker-profiles.json
server/.data/user-memory.json
```

声纹 embedding 使用 SpeechBrain ECAPA-TDNN。首次使用前需要准备 Python 环境：

```bash
python3.11 -m venv .venv-speaker
.venv-speaker/bin/python -m pip install --upgrade pip
.venv-speaker/bin/python -m pip install speechbrain torch torchaudio soundfile numpy
```

本地仍需要安装 `ffmpeg`，用于把浏览器录音转成 16 kHz WAV。

可调阈值在 `.env` 中配置：

```bash
SPEAKER_PYTHON_PATH=.venv-speaker/bin/python
SPEAKER_MODEL_PATH=speechbrain/spkrec-ecapa-voxceleb
SPEAKER_VERIFY_MIN_SIMILARITY=0.72
SPEAKER_IDENTIFY_MIN_SIMILARITY=0.76
SPEAKER_IDENTIFY_MIN_MARGIN=0.05
SPEAKER_AUTO_UPDATE_MIN_SIMILARITY=0.84
MEMORY_WRITE_MIN_CONFIDENCE=0.82
```

网页使用方式：

1. 在“声纹用户”选择“自动识别”，填写昵称。
2. 点击“录制注册样本”，连续说话约 3 秒。
3. 至少录入 3 段有效样本后，centroid 才可用于识别。
4. 后续对话会显示“声纹身份”和相似度。
5. 只有识别或验证成功时，系统才读取该用户长期记忆。
6. 说“记住我喜欢科幻故事”这类显式表达时，系统会写入当前已确认用户的长期记忆。
7. 可以在“长期记忆”面板清除当前用户记忆，也可以关闭声纹自动优化。

阈值只是本地 Demo 的起始值。真实使用前需要用同一麦克风、同一语言环境下的样本校准，尤其要测试同一用户不同距离、不同噪声，以及不同用户相近声线的情况。

### 长期家庭记忆

在个人长期记忆之外，项目还新增了家庭级画像：

- 家庭角色：爸爸、妈妈、孩子、长辈、访客。角色在声纹注册时绑定到用户档案，后续对话由声纹识别自动带出，不需要每轮手动选择。
- 时间段：早上、中午、下午、晚上、夜间。
- 常用智能体：按家庭整体和每个成员分别统计 agent 使用次数。
- 提醒习惯：把提醒对象、提醒内容、时间段和触发 agent 沉淀为长期习惯。
- 家庭共享事实：例如“记住我们家晚上要少看电视”会写入家庭记忆。

家庭记忆存储在：

```text
server/.data/family-memory.json
```

前端会展示“家庭记忆”面板，包括当前时间段、家庭成员角色、常用智能体、提醒习惯和家庭事实。后端 `/api/converse` 会把个人记忆和家庭记忆一起注入 agent 上下文，但只信任声纹身份返回的家庭角色，只有声纹身份可信时才允许写入新的个人或家庭记忆。

当前时间段会自动根据本机时间推断，也可以在网页里手动切换用于测试。路由器会结合时间段和家庭角色做轻量加权，例如：

- 夜间 + 睡前故事更倾向虎子。
- 早上 + 计划/提醒更倾向生活管家。
- 晚上 + 作业/复习更倾向英语学习。
- 孩子角色会轻微提升虎子优先级。
