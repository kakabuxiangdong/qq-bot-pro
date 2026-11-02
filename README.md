# qq-bot-pro

给 **DSH（DeepSeek Harness）** 的 QQ 官方机器人通道 `@tencent-connect/dsh-qqbot`（即 im-qqbot，QQ 开放平台 appId + appSecret 那套）补齐三件事：

| 能力 | 说明 |
| --- | --- |
| 🎨 表情包 | `qq_list_stickers` / `qq_send_sticker` 工具 + 回复里的 `[sticker:名]`、`![名](url)` 自动换成真图发出去；把你的图丢进 `stickers/` 即可（文件名就是表情名） |
| 💬 主动发言 | 冷场定时器：群里/私聊安静到阈值后自己开口（默认群 30 分钟、私聊 40 分钟，概率 0.5） |
| 🧠 连续对话 | 长期记忆 `qq_memory_*`（跨会话、跨天）；群聊本地存档（官方 SDK 回复后清空 history buffer，本插件自己落盘）；群聊/私聊两个窗格的对话互相可见 |

外加两个稳定性补丁：**归档看守**（QQ 会话被误归档会导致模型一步都不跑、群里彻底不回，插件每分钟自动 unarchive）和**网关启动重试**（宿主冷启动时 bootstrap 偶发失败）。

## 为什么需要宿主补丁

im-qqbot 本身只做一件事：把模型输出的文本发到 QQ。它不暴露内部运行时对象，也没有表情/主动发言/收图入上下文的入口。插件要接上这些能力，必须改它安装目录里的 6 处文件：

| 文件 | 改动 |
| --- | --- |
| `dist/gateway/bootstrap.js` | 暴露 `globalThis.__qqbotRuntime` 并装载本插件的 `lib/host-bridge.js` |
| `dist/gateway/spoke-tracker.js` | （新增）记录「她刚在这个群说过话」，用于不 @ 也接话 |
| `dist/gateway/middleware-setup.js` | 隐式 @ 门控 + `gate:pass/skip` 诊断日志 |
| `dist/model/model-resolver.js` | QQ 会话默认 `reasoningEffort: low`（聊天别用高推理档） |
| `dist/transport/inbound.js` | 入站图片直接进模型上下文，不用先落盘再读 |
| `dist/index.js` | 网关启动失败自动重试（最多 4 次） |

补丁形式是**锚点 find/replace**，不整包替换、不需要 git，版本不符会拒绝执行，改动前自动备份，幂等、可 `--revert`。

## 前置条件

- DSH Desktop（Web GUI），profile 目录形如 `~/.dsh/profiles/<profile>`
- `@tencent-connect/dsh-qqbot` **0.5.3**（补丁基线；其他版本需 `--force` 并对齐锚点）
- 一个 QQ 开放平台的机器人（appId / appSecret），已在目标群添加
- 群主/管理员在机器人资料页开启 **「接收所有消息」**（否则群里不 @ 她的消息平台根本不会推送，代码无法补救）

## 安装

```bash
# 1) 放到插件目录（也可 git clone 到这里）
cd ~/.dsh/plugins
# 解压/克隆得到 ~/.dsh/plugins/qq-bot-pro

# 2) 给宿主打补丁（先看状态：加 --check）
node ~/.dsh/plugins/qq-bot-pro/lib/patch-host.mjs --check
node ~/.dsh/plugins/qq-bot-pro/lib/patch-host.mjs

# 3) 登记进 profile：写 dependencies + dsh.profile.bundles + 建 node_modules 链接
node ~/.dsh/plugins/qq-bot-pro/lib/patch-host.mjs --register --profile ~/.dsh/profiles/desktop
```

`--register` 会帮你改 profile 的 `package.json`（原文件备份为 `package.json.qq-bot-pro.bak`），并在 `node_modules` 里建 junction。**如果你习惯用 pnpm**，也可以手动：

```json
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": { "qq-bot-pro": "link:C:/Users/you/.dsh/plugins/qq-bot-pro" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@tencent-connect/dsh-qqbot", "qq-bot-pro"] } }
}
```

然后 `pnpm install`（`node_modules` 一被重装，宿主补丁会被抹掉，重跑第 2 步即可）。

### 4) 让 QQ 会话用上本插件的 preset

profile 的 `cordis.patch.yml` 里，im-qqbot 那一行加 `preset: qq-bot`：

```yaml
- id: im-qqbot
  name: '@tencent-connect/dsh-qqbot'
  config:
    appId: '你的 appId'
    appSecret: '你的 appSecret'
    preset: qq-bot            # ← 关键：本插件提供的 preset（含工具白名单）
    sessionIdleTimeout: 21600000   # 6 小时，太短会导致冷场搭话永远等不到
    historyLimit: 16          # 群聊上下文条数
    streaming: false
    access:
      c2cMode: open
      groupMode: open
```

`preset` 留空或写错 id（例如 `Low`）会退化成「无 preset」：没有工具白名单、没有 persona、没有压缩，本地工具会全部暴露给 QQ 用户。

### 5) 重启 DSH

完全退出再打开（宿主进程重启才会重新加载 bundle 与补丁后的 gateway）。

## 验证

```bash
tail -n 40 ~/.dsh/qq-bot-pro/bridge.log
```

正常应看到：

```
host-bridge:install rt=object ctx=true sender=function
runtime:ready sender=object md=function ctx=true stickers=object
tool:registered qq_list_stickers
...
```

群里 @ 她一次，日志会出现 `gate:pass ... implicit=false`；紧接着（5 分钟内）不 @ 只说一句话，应出现 `gate:pass ... implicit=true`。

## 图形设置页

插件自带设置界面（不是 DSH 内置功能）：打开 DSH Web GUI → **设置 → 插件 → 「QQ 机器人」标签**（排在「大肥鱼表情包」后面）。改完点保存，约 2 秒内生效——宿主和 QQ 门控读的是同一份 `~/.dsh/qq-bot-pro/settings.json`。

| 分组 | 内容 |
| --- | --- |
| 功能开关（9 项） | 表情包发送 / 表情包工具 / 长期记忆 / 群聊存档 / 群聊·私聊互通 / 冷场主动发言（总闸）/ 群里主动开口 / 私聊主动开口 / 归档看守 |
| 什么时候回消息（6 项） | 每条消息都回 / 叫她名字就算找她 / 引用她就算找她 / 她刚说过话就接着说 / 提到别人时先别插嘴 / 连发消息合并成一轮 |
| 细节 | 接话窗口（分钟）/ 引用窗口（分钟）/ 连发合并（秒）/ 「叫她名字」的词表 |
| 个性提示词 | 群里的人格设定 / 私聊的人格设定（两个多行输入框，留空则沿用 `cordis.patch.yml` 里的 `groupPrompt` / `directPrompt`） |

页面底部显示配置文件路径，另有「撤销」和「看诊断日志」（直接贴 `bridge.log` 尾巴）。后端只接受本机回环请求，端口随宿主变化。

实现位置：后端路由 `/x-qq-bot-pro/settings`、`/x-qq-bot-pro/log` 在 `lib/index.js`（`installSettingsRoute`）；前端页面是 `lib/client.js`，通过 `package.json` 的 `dsh.client` + `exports["./client"]` 声明，注册进 `settings.plugins.tab` 插槽。不想用界面时，直接手写 `settings.json` 效果一样。

### 个性提示词（人设）

设置页的「个性提示词」分组就是她的 system prompt 人设，群聊和私聊各一份：

- 写进去的文字会以 `【人设…】` 段落（order 91）注入，位置在 `groupPrompt`（order 90）之后、记忆（order 80）之前，**风格优先级最高**；
- 留空 = 不注入，用 `cordis.patch.yml` 里原来的 `groupPrompt` / `directPrompt`（老配置零改动）；
- 最多 8000 字，保存后下一轮回复生效。

### 从第三方桥（SnowLuma / NapCat / OneBot）迁移

以前用第三方协议桥的用户，人设和记忆都在旧配置里（例如桥的 `groupPrompt`、`long-memory.md`、SQLite/JSON 记忆库）。不用手抄：

1. 把旧人设原文直接粘进设置页的「个性提示词」输入框（群聊一份、私聊一份），保存即可；
2. 记忆让 DSH 帮你搬：在 DSH 里说「**把我旧桥（SnowLuma / NapCat）的人设和长期记忆迁移到 QQ 机器人**」，它会去读旧配置/记忆文件，再通过 `qq_memory_append` 写进 `memory.json`；
3. 迁移完在群里随便问一件旧事验证（例：「我们之前约好的事是啥」）。

> 记忆是纯文本 JSON（`~/.dsh/qq-bot-pro/memory.json`），也可以手工灌：`{"entries":[{"id":"...","text":"...","scope":"group","createdAt":"..."}]}`。

## 数据文件（都在 `~/.dsh/qq-bot-pro/`）

| 文件 | 用途 | 可删 |
| --- | --- | --- |
| `bridge.log` | 诊断日志（门控、表情、定时器、归档看守） | ✅ |
| `settings.json` | 图形设置页保存的开关与门控参数（删了回到默认值） | ✅ |
| `memory.json` | 长期记忆条目（`qq_memory_*` 工具读写） | ⚠️ 删了就忘了 |
| `group-history.json` | 群聊本地存档（SDK 回复后会清 buffer，这里留 300 条） | ⚠️ |
| `exchanges.json` | 群聊/私聊互相可见的最近对话（各留 14 条注入） | ✅ |
| `presence.json` | 「她最近在哪些群/私聊出现过」，定时器据此重开会话 | ✅ |
| `timer.json` | 主动发言参数，见下 | ✅ |
| `tool-restrict.log` | 工具白名单 restrict 失败的原因 | ✅ |

主动发言可调（不写就用默认）：

```json
// ~/.dsh/qq-bot-pro/timer.json
{ "checkMs": 600000, "idleMs": 1800000, "c2cIdleMs": 2400000, "prob": 0.5 }
```

- `checkMs` 巡检间隔；`idleMs` 群冷场阈值；`c2cIdleMs` 私聊冷场阈值；`prob` 每次巡检开口概率。
- 想把「半小时搭一次话」改成「十分钟」：`idleMs: 600000`。
- 群冷场阈值建议 **≤ 1 小时**：QQ 官方对同一条消息的被动回复有 1 小时 TTL 和 4 次上限，超了就只能走主动推送（需要平台额外权限，容易被拒）。

## 工具

| 工具 | 说明 |
| --- | --- |
| `qq_list_stickers` | 列出内置表情（id + 中文名 + 用法） |
| `qq_send_sticker` | 按名字发表情，例如 `草`、`乐`、`摸鱼`、`气鼓鼓`（情绪词会兜底映射到最接近的一张） |
| `qq_memory_append` / `qq_memory_query` / `qq_memory_remove` / `qq_memory_clear` | 长期记忆增删查清 |

表情文件放在 `stickers/` 目录，**文件名去掉扩展名就是表情名**，支持 png / gif / jpg / webp，中文名也行（例：`好耶.png` → `[sticker:好耶]`）。改完不用重启，下一次调用就会读到新文件。

目录空着也能用：

- 装了 dsh-nekowhale-stickers 表情包插件的话，会自动回落到它的表情库；
- 模型自造的表情名（「气鼓鼓」「委屈巴巴」「笑死」）会按关键词映射到最接近的那张，不会因为找不到图而只发文字。

`generate_stickers.py` 是早期用 Windows 自带字体绘制内置表情的脚本，只是留个参考——v1.0.3 起包内不再附带那 16 张图，请用你自己的。

## 常见问题

**群里 @ 有反应，不 @ 就不理**
1. 平台侧：群管理 → 群设置 → 群机器人 → 她的资料页 → 打开「接收所有消息」。没开时平台完全不推消息，`bridge.log` 里连 `gate:skip` 都不会有。
2. 代码侧：本插件已把门控改成「她 5 分钟内在这个群说过话，就算在跟她说」（引用她则放宽到 15 分钟）。

**群里完全没反应，私聊正常**
多半是 QQ 会话被归档了（`~/.dsh/storages/workspace.json` 的 `archivedSessionIds`）：模型连一步都不会跑，`turn/end` 直接 `blocked`。本插件有一分钟一次的归档看守会自动 unarchive，并让她补一句。若日志出现 `archive:registry-missing`，重启 DSH（宿主启动时 workspaceRegistry 才可用）。

**表情只发出文字 / 发出去是一串字**
说明宿主补丁没生效（`bridge.log` 里没有 `runtime:ready`）。重跑 `lib/patch-host.mjs`，或先 `--check` 看状态。

**冷启动后 QQ 网关没连上**
早先只有 4 次重试，现在重试 + 工具注册已改成幂等（重复注册不再抛错）。仍然失败就看 `bridge.log` 里的 `boot:attempt-fail`。

**更新 DSH 时报 Host did not complete graceful task teardown / graceful deadline exceeded**
宿主退出太慢被 Electron 强杀，不是崩溃（新版本其实已经起来了）。原因是 dsh 自带的 5 秒兜底 exit 会在 dispose 完成后被清除，之后只能靠事件循环自然排空；QQ 网关 socket、插件定时器之类只要还挂着，进程就活过 10 秒宽限期。本插件装了停机探针：检测到「IPC 断开 + exitCode 已置」就先把残留句柄写进 `bridge.log`（`shutdown:t+1s ... handles=...`）再主动退出，让更新被判成优雅。看到 `shutdown:force-exit` 属正常。

**更新了 DSH / 重装依赖后一切失效**
`node_modules` 被覆盖，宿主补丁没了。重跑 `node lib/patch-host.mjs`（幂等，会自动判断哪些还需要打）。

## 回滚 / 卸载

```bash
# 还原宿主文件（从 .qq-bot-pro-backup 恢复，并删掉新增的 spoke-tracker.js）
node ~/.dsh/plugins/qq-bot-pro/lib/patch-host.mjs --revert

# 从 profile 里摘掉：删掉 dependencies 里的 qq-bot-pro、bundles 里的 qq-bot-pro，
# 再删 node_modules/qq-bot-pro，最后删除插件目录和 ~/.dsh/qq-bot-pro/
```

## 开发

宿主补丁的锚点由脚本生成，不要手改 `lib/patches.json`：

```bash
# 取补丁基线的原版包
curl -LO https://registry.npmjs.org/@tencent-connect%2Fdsh-qqbot/-/dsh-qqbot-0.5.3.tgz
tar -xzf dsh-qqbot-0.5.3.tgz          # 得到 package/

# 对比「现在的安装（已打补丁）」重新生成 lib/patches.json
node lib/gen-patches.mjs --pristine ./package --live ~/.dsh/profiles/desktop/node_modules/@tencent-connect/dsh-qqbot
```

生成器会校验「补丁应用结果与目标文件逐字节相同」，不做这步校验就会得到一套只在本机能用的锚点。

## 许可

MIT。仓库不附带表情图片；`generate_stickers.py` 若自绘分发，请自行确认字体授权（它用的是 Windows 自带字体）。
