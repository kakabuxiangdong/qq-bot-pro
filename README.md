# qq-bot-pro

给 **DSH（DeepSeek Harness）** 的 QQ 官方机器人通道 `@tencent-connect/dsh-qqbot`（im-qqbot）补齐三件事：

| 能力 | 说明 |
| --- | --- |
| 🎨 表情包 | 16 张内置表情 + `qq_send_sticker`；回复里的 `[sticker:名]` / `![名](url)` 自动换成真图发出 |
| 💬 主动发言 | 冷场定时器：群里 30 分钟 / 私聊 40 分钟没人说话就自己开口 |
| 🧠 连续对话 | 长期记忆 `qq_memory_*`、群聊本地存档（官方 SDK 回复后会清 buffer）、群聊/私聊两个窗格互相可见 |

外加一个图形设置页（DSH → 设置 → 插件 → 「QQ 机器人」）：9 个功能开关 + 6 个门控开关，改完 2 秒生效。

## 下载

见 [Releases](../../releases) 页面的 `qq-bot-pro-<版本>.zip`。

## 安装（摘要）

```bash
cd ~/.dsh/plugins && unzip qq-bot-pro-1.0.1.zip
node ~/.dsh/plugins/qq-bot-pro/lib/patch-host.mjs --check   # 先看宿主状态
node ~/.dsh/plugins/qq-bot-pro/lib/patch-host.mjs           # 打宿主补丁（幂等、可 --revert）
node ~/.dsh/plugins/qq-bot-pro/lib/patch-host.mjs --register --profile ~/.dsh/profiles/desktop
```

然后在 profile 的 `cordis.patch.yml` 里给 im-qqbot 加 `preset: qq-bot`（建议同时 `sessionIdleTimeout: 21600000`），重启 DSH。

完整说明（数据文件、定时器参数、常见问题、卸载）见下载包里的 `README.md` 与 `RELEASE_NOTES.md`。

## 前置要求

- DSH Desktop（Web GUI），profile 目录形如 `~/.dsh/profiles/<profile>`
- `@tencent-connect/dsh-qqbot` **0.5.3**（补丁基线；换版本需重跑 `lib/gen-patches.mjs` 对齐锚点）
- QQ 开放平台的机器人（appId / appSecret），并已在群里添加
- **群主/管理员在机器人资料页开启「接收所有消息」**，否则群里不 @ 她的消息平台根本不会推送

## 已知限制

- 补丁锁 0.5.3；`node_modules` 重装会抹掉宿主补丁，重跑 `patch-host.mjs` 即可
- 内置表情由脚本自绘，二次分发请自行确认字体授权

## 许可

MIT
