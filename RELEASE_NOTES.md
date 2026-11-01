# qq-bot-pro v1.0.2

在 v1.0.1 基础上加了两块东西：**设置页里能直接写人设**，以及**从第三方桥迁移的路径**。

## v1.0.2 新增

- **个性提示词（设置页里直接写人设）**：设置 → 插件 → 「QQ 机器人」→ 底部「个性提示词」，群聊、私聊各一个文本框，各最多 8000 字。
  - 保存即生效（约 2 秒，不用重启宿主）；写在这里的语气 / 称呼 / 禁忌优先于默认风格，注入位置紧跟默认提示词之后（order 91）。
  - 留空就用 im-qqbot 配置里的 groupPrompt / directPrompt，老用户不受影响。
  - 用途：换人设、加口癖、指定怎么叫老板、禁掉某些话题，都不用改 YAML。
- **从第三方桥迁移**：README 新增「从第三方桥（SnowLuma / NapCat / OneBot）迁移」章节。原来那套桥的人设直接粘进「个性提示词」；长期记忆可以让 DSH 读旧文件后一次性写进 `~/.dsh/qq-bot-pro/memory.json`（结构 `{"entries":[{"id","text","scope","createdAt"}]}`），跟 DSH 说一句「把我旧桥的人设和长期记忆迁移到 QQ 机器人」即可。
- 版本号 `package.json` → 1.0.2（补丁内容与 v1.0.1 相同，无需重跑补丁器；从 1.0.0 升上来的仍要跑一次）。

## 从 v1.0.1 升级

解压覆盖插件目录即可，然后重启 DSH。补丁没变，不用再跑 `patch-host.mjs`。

---

# qq-bot-pro v1.0.1

在 v1.0.0 基础上补齐**图形设置页**，并修掉两个真问题：桌面更新重启被判失败、以及表情名对不上时丢图。

## v1.0.1 新增

- **图形设置页（插件自带，非 DSH 内置）**：DSH Web GUI → 设置 → 插件 → **「QQ 机器人」** 标签。
  - 9 个功能开关：表情包发送 / 表情包工具 / 长期记忆 / 群聊存档 / 群聊·私聊互通 / 冷场主动发言（总闸）/ 群里主动开口 / 私聊主动开口 / 归档看守。
  - 6 个门控开关 + 细节参数：每条都回、叫她名字就算找她、引用她就算找她、刚说过话就接着说、提到别人时别插嘴、连发合并；接话窗口 / 引用窗口 / 合并秒数 / 名字词表。
  - 保存后约 2 秒生效；宿主与 QQ 门控共用 `~/.dsh/qq-bot-pro/settings.json`；带「撤销」和「看诊断日志」（直接贴 `bridge.log` 尾巴）。
  - 前后端都在本包内：`lib/client.js`（`dsh.client` + `settings.plugins.tab` 插槽）、`lib/index.js` 的 `/x-qq-bot-pro/settings|log` 路由；只接受本机回环请求。
- **停机探针 + 优雅退出兜底**：桌面更新时宿主 dispose 完成后，dsh 自带的 5 秒兜底 exit 会被清除，进程改由事件循环自然排空；只要还有 socket/定时器撑着就活过 10 秒宽限期，被 SIGTERM 强杀，更新器报
  `Host did not complete graceful task teardown (exit null, signal SIGTERM, shutdown acknowledged true, graceful deadline exceeded true)`。
  现在插件内常驻一个 1 秒 unref 探针：观察到「IPC 断开 + process.exitCode 已置」时，先把残留句柄写进 `bridge.log`，再等 2 秒主动 `process.exit(exitCode)`（保留退出码）。正常运行时 IPC 一直连着、exitCode 为 undefined，不会误杀。
- **表情情绪词兜底**：模型自造表情名（气鼓鼓 / 委屈巴巴 / 无语住 / 笑死…）不再丢图，按关键词映射到最接近的内置表情。

## v1.0.0 已有（回顾）

- 表情包：16 张内置 + `qq_list_stickers` / `qq_send_sticker`；回复里 `[sticker:名]`、`![名](url)` 拦截替换成真图。
- 主动发言：冷场定时器（群 30 分钟 / 私聊 40 分钟，概率 0.5，`timer.json` 可调）+ `presence.json` 重开会话。
- 连续对话：长期记忆 `qq_memory_*`（`memory.json`）、群聊本地存档（`group-history.json`，300 条）、群聊/私聊互通（`exchanges.json`）。
- 不 @ 也接话：她 5 分钟内在该群说过话就算在跟她说，引用她放宽到 15 分钟（平台侧仍需开启「接收所有消息」）。
- 稳定性：归档看守（误归档会导致模型一步都不跑）、网关启动重试 + 工具注册幂等。

## 验证记录（本轮实测）

- 设置页宿主侧：GET/POST 正常，非法键与类型被忽略，`nameHints` 自动 trim/去空，远程来源 POST 返回 403，`/log` 正常。
- 设置页前端：用 React shim 渲染，15 个 checkbox + 3 个数值 + 词表均正确回填，保存后状态栏「已保存（N 项），立即生效」。
- 停机探针（真实 IPC 通道，`child_process.fork` 而非模拟）：IPC 断开 + exitCode=0 → 3.1 秒退出、code=0；exitCode=3 → 3.1 秒退出、code=3；exitCode 未置（模拟热重载）→ 9 秒仍存活、不自杀。
- 宿主补丁：`lib/patches.json` 覆盖 5 个改动文件 + 新建 `spoke-tracker.js`（基线 `@tencent-connect/dsh-qqbot@0.5.3`）。
- 全部 JS 文件 `node --check` 通过。

## 安装

```bash
cd ~/.dsh/plugins && unzip qq-bot-pro-1.0.1.zip
node ~/.dsh/plugins/qq-bot-pro/lib/patch-host.mjs --check   # 先看状态
node ~/.dsh/plugins/qq-bot-pro/lib/patch-host.mjs           # 打宿主补丁
node ~/.dsh/plugins/qq-bot-pro/lib/patch-host.mjs --register --profile ~/.dsh/profiles/desktop
```

然后在 profile 的 `cordis.patch.yml` 给 im-qqbot 加 `preset: qq-bot`（并建议 `sessionIdleTimeout: 21600000`），重启 DSH。详见 README。

## 已知限制

- 群里不 @ 的消息依赖**群管理在机器人资料页开启「接收所有消息」**，否则平台不推送（`bridge.log` 里连 `gate:skip` 都不会有）。
- 补丁基线锁定 `@tencent-connect/dsh-qqbot@0.5.3`；上游升级后需重跑 `lib/gen-patches.mjs` 对齐锚点。
- `node_modules` 被重装会抹掉宿主补丁，重跑 `lib/patch-host.mjs` 即可（幂等）。
- 内置表情由 `generate_stickers.py` 用 Windows 自带字体绘制，二次分发请自行确认字体授权。
