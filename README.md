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
