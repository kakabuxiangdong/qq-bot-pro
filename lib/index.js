// qq-bot-pro：为 im-qqbot（@tencent-connect/dsh-qqbot）补齐三项缺失能力
//   ① 表情包    qq_list_stickers / qq_send_sticker
//   ② 主动群发言 冷场定时器 → 向 agent 注入开话题指令 → 文本自动发到群
//   ③ 连续对话   长期记忆 qq_memory_append/query/remove/clear + system-prompt 注入
//
// 依赖 gateway/bootstrap.js 里暴露的 globalThis.__qqbotRuntime（见 bootstrap patch），
// 含 bot / manager / mediaSender / ctx / sendToAgent 等。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 诊断日志（排查表情桥接是否生效；只写文件，不污染宿主 stdout）──
const DIAG_FILE = path.join(os.homedir(), '.dsh', 'qq-bot-pro', 'bridge.log');
function diag(msg) {
  try {
    fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true });
    fs.appendFileSync(DIAG_FILE, '[' + new Date().toISOString() + '] ' + msg + '\n', 'utf8');
  } catch { }
}

export const name = 'qq-bot-pro';
diag('module:loaded pid=' + (typeof process !== 'undefined' ? process.pid : '?') + ' flags=' + JSON.stringify({ applied: !!globalThis.__qqBotProApplied }) + ' stack=' + String(new Error().stack || '').split('\n').slice(1, 4).join(' | '));



// ── 长期记忆存储（独立于 profile，避免与 bridge 的 long-memory.md 混淆）──
const MEMORY_DIR = path.join(os.homedir(), '.dsh', 'qq-bot-pro');
const MEMORY_FILE = path.join(MEMORY_DIR, 'memory.json');

// ── 功能开关：~/.dsh/qq-bot-pro/settings.json ──────────────────────────
// 每一项都能单独开关；改完 2 秒内生效，不用重启。
const SETTINGS_FILE = path.join(MEMORY_DIR, 'settings.json');
const DEFAULT_FEATURES = {
  stickerBridge: true,   // 回复里的表情标记 → 真图发送
  stickerTools: true,    // qq_list_stickers / qq_send_sticker
  memory: true,          // 长期记忆工具 + 注入
  groupHistory: true,    // 群聊本地存档 + 注入
  crossScope: true,      // 群聊/私聊互相补上下文
  proactive: true,       // 冷场主动发言（总闸）
  proactiveGroup: true,  // 群里冷场主动开口
  proactiveC2c: true,    // 私聊冷场主动开口
  archiveGuard: true,    // 归档看守（会话被误归档时捞回来）
};
const FEATURE_HELP = {
  stickerBridge: '表情包发送桥接',
  stickerTools: '表情包工具',
  memory: '长期记忆',
  groupHistory: '群聊存档',
  crossScope: '群聊/私聊互通',
  proactive: '冷场主动发言',
  proactiveGroup: '群里主动开口',
  proactiveC2c: '私聊主动开口',
  archiveGuard: '归档看守',
};
let settingsCache = { at: 0, value: DEFAULT_FEATURES };
function features() {
  const now = Date.now();
  if (now - settingsCache.at < 2000) return settingsCache.value;
  let value = { ...DEFAULT_FEATURES };
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (raw && typeof raw.features === 'object' && raw.features) value = { ...value, ...raw.features };
  } catch { /* 没配置文件就用默认（全开） */ }
  settingsCache = { at: now, value };
  return value;
}
function on(name) { return features()[name] !== false; }
function offError(name) {
  return new Error('「' + (FEATURE_HELP[name] || name) + '」已在设置里关闭（把 ' + SETTINGS_FILE + ' 的 features.' + name + ' 改成 true 即可）');
}

// 首次运行写一份带注释的示例配置；已存在就绝不覆盖（用户可能改过）。
const SETTINGS_TEMPLATE = {
  features: DEFAULT_FEATURES,
  gate: {
    answerAll: false,                // 默认只在叫她名字 / 引用她 / 接话时回复，省 token
    replyToName: true,
    replyToQuote: true,
    replyToFollowUp: true,
    skipWhenMentioningOthers: true,
    mergeBurst: true,
    nameHints: ['小肥鱼', '肥鱼', '鲸鱼', '小鱼'],
    followWindowMs: 300000,
    quoteWindowMs: 900000,
    burstMs: 2500,
  },
  // 个性提示词：写在这里就等于写进她的系统提示词（最高的风格优先级）。
  // 以前用第三方桥（SnowLuma / NapCat 那套）的，把旧人设原文粘进来就行。
  persona: {
    group: '',
    direct: '',
  },
};
function ensureSettingsFile() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) return;
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(SETTINGS_TEMPLATE, null, 2) + '\n', 'utf8');
    diag('settings:created ' + SETTINGS_FILE);
  } catch (e) {
    diag('settings:create-fail ' + (e?.message || e));
  }
}

// ── 图形设置页：HTTP 接口 ──────────────────────────────────────────────
// 设置页的浏览器半侧（lib/client.js，设置 → 插件 → QQ 机器人）靠这两个接口读写
// 同一份 settings.json。宿主插件和 dsh-qqbot 里的门控都读这个文件，所以改完即生效。
const GATE_DEFAULTS = {
  answerAll: false,                 // 群里谁说话都接（会花 token）
  replyToName: true,                // 有人叫她名字就接
  replyToQuote: true,               // 引用她的话就接
  replyToFollowUp: true,            // 她刚说完话，接着说的话就接
  skipWhenMentioningOthers: true,   // @ 了别人时不插嘴
  mergeBurst: true,                 // 同一个人连发只接第一句
  nameHints: ['小肥鱼', '肥鱼', '鲸鱼', '小鱼'],
  followWindowMs: 300000,           // 接话窗口（毫秒）
  quoteWindowMs: 900000,            // 引用窗口（毫秒）
  burstMs: 2500,                    // 连发合并阈值（毫秒）
};
const GATE_HELP = {
  answerAll: '不叫她、只是群里聊天也回（每条都跑一轮模型，费 token）',
  replyToName: '有人叫「小肥鱼 / 肥鱼 / 鲸鱼 / 小鱼」就回',
  replyToQuote: '引用她说过的话就回',
  replyToFollowUp: '她刚说完话，群里接着说她就回',
  skipWhenMentioningOthers: '@ 了别人时不插嘴',
  mergeBurst: '同一个人连着发几句，只回第一句',
};
// 个性提示词：设置页里直接写人设，不用去改 cordis.patch.yml。
// 留空 = 只用 im-qqbot 的 groupPrompt / directPrompt（老用户不受影响）。
const PERSONA_DEFAULTS = { group: '', direct: '' };
const PERSONA_HELP = {
  group: '群里的人格设定（留空就沿用 cordis.patch.yml 里的 groupPrompt）',
  direct: '私聊的人格设定（留空就沿用 directPrompt）',
};
const PERSONA_MAX = 8000;
const SETTINGS_ROUTE = '/x-qq-bot-pro';

function readSettingsFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
function settingsView() {
  const raw = readSettingsFile();
  const rt = globalThis.__qqbotRuntime;
  let groups = [];
  try { groups = Object.keys(loadGroupHistory()).map((k) => k.split(':')[1]).filter(Boolean); } catch { }
  return {
    file: SETTINGS_FILE,
    features: { ...DEFAULT_FEATURES, ...(raw.features ?? {}) },
    gate: { ...GATE_DEFAULTS, ...(raw.gate ?? {}) },
    persona: { ...PERSONA_DEFAULTS, ...(raw.persona ?? {}) },
    help: { features: FEATURE_HELP, gate: GATE_HELP, persona: PERSONA_HELP },
    order: {
      features: Object.keys(DEFAULT_FEATURES),
      gate: Object.keys(GATE_DEFAULTS),
      persona: Object.keys(PERSONA_DEFAULTS),
    },
    live: {
      runtime: !!rt,
      appId: rt?.config?.appId ?? null,
      streaming: rt?.config?.streaming ?? null,
      groups,
    },
  };
}
// 只接受已知键、类型对得上的值，其它一律忽略；返回实际改动数。
function applySettingsPatch(patch) {
  const raw = readSettingsFile();
  const p = patch && typeof patch === 'object' ? patch : {};
  const nextFeatures = { ...DEFAULT_FEATURES, ...(raw.features ?? {}) };
  const nextGate = { ...GATE_DEFAULTS, ...(raw.gate ?? {}) };
  let changed = 0;
  if (p.features && typeof p.features === 'object') {
    for (const key of Object.keys(DEFAULT_FEATURES)) {
      const v = p.features[key];
      if (typeof v === 'boolean' && nextFeatures[key] !== v) { nextFeatures[key] = v; changed++; }
    }
  }
  if (p.gate && typeof p.gate === 'object') {
    for (const key of Object.keys(GATE_DEFAULTS)) {
      const v = p.gate[key];
      if (v === undefined || v === null) continue;
      const def = GATE_DEFAULTS[key];
      if (typeof def === 'boolean') {
        if (typeof v === 'boolean' && nextGate[key] !== v) { nextGate[key] = v; changed++; }
      } else if (typeof def === 'number') {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 1000 && n <= 86400000 && nextGate[key] !== Math.round(n)) { nextGate[key] = Math.round(n); changed++; }
      } else if (Array.isArray(def)) {
        const list = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : undefined;
        if (list && JSON.stringify(list) !== JSON.stringify(nextGate[key])) { nextGate[key] = list; changed++; }
      }
    }
  }
  const nextPersona = { ...PERSONA_DEFAULTS, ...(raw.persona ?? {}) };
  if (p.persona && typeof p.persona === 'object') {
    for (const key of Object.keys(PERSONA_DEFAULTS)) {
      const v = p.persona[key];
      if (typeof v !== 'string') continue;
      const text = v.trim().slice(0, PERSONA_MAX);
      if (text !== nextPersona[key]) { nextPersona[key] = text; changed++; }
    }
  }
  if (changed) {
    const out = { ...SETTINGS_TEMPLATE, ...raw, features: nextFeatures, gate: nextGate, persona: nextPersona };
    try {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
      settingsCache = { at: 0, value: DEFAULT_FEATURES };
      diag('settings:write changed=' + changed);
    } catch (e) { diag('settings:write-fail ' + (e?.message || e)); }
  }
  return changed;
}
function readRequestBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
    req.on('timeout', () => resolve(''));
  });
}
// 只让本机页面读写（回环对端 + 回环 Host，防 DNS rebinding）。
function isLocalRequest(req) {
  const loopback = (a) => /^127\./u.test(a) || a === '::1' || /^::ffff:127\./iu.test(a);
  const hostName = (h) => h.replace(/:\d+$/u, '').replace(/^\[(.*)\]$/u, '$1').toLowerCase();
  const host = hostName(String(req.headers?.host ?? ''));
  return loopback(String(req.socket?.remoteAddress ?? '')) && (host === 'localhost' || loopback(host));
}
function logTail(limit = 60) {
  try {
    const lines = fs.readFileSync(DIAG_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit);
  } catch { return []; }
}
function installSettingsRoute(ctx) {
  try {
    ctx.inject(['webServer'], (wctx) => {
      diag('settings:route-installed ' + SETTINGS_ROUTE + ' port=' + (() => { try { return wctx.webServer?.port ?? '?'; } catch { return '?'; } })());
      wctx.effect(() => wctx.webServer.register({
        kind: 'prefix',
        path: SETTINGS_ROUTE,
        handler: async (req, res) => {
          const send = (code, value) => {
            res.statusCode = code;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(value));
          };
          try {
            const rest = new URL(req.url ?? '/', 'http://x').pathname.slice(SETTINGS_ROUTE.length);
            const method = req.method ?? 'GET';
            if (rest === '/settings' || rest === '/' || rest === '') {
              if (method === 'GET' || method === 'HEAD') {
                if (!globalThis.__qqBotProUiSeen) { globalThis.__qqBotProUiSeen = true; diag('settings:ui-connected'); }
                send(200, settingsView());
                return;
              }
              if (method !== 'POST') { send(405, { error: 'method-not-allowed' }); return; }
              if (!isLocalRequest(req)) { send(403, { error: 'local-only' }); return; }
              let patch;
              try { patch = JSON.parse((await readRequestBody(req)) || '{}'); } catch { send(400, { error: 'bad-json' }); return; }
              const changed = applySettingsPatch(patch);
              send(200, { ...settingsView(), changed });
              return;
            }
            if (rest === '/log') {
              if (!isLocalRequest(req)) { send(403, { error: 'local-only' }); return; }
              send(200, { lines: logTail() });
              return;
            }
            send(404, { error: 'not-found' });
          } catch (err) {
            diag('settings:route-fail ' + (err?.message || err));
            try { send(500, { error: 'internal' }); } catch { }
          }
        },
      }), 'qq-bot-pro: settings route');
    });
  } catch (err) {
    diag('settings:route-install-fail ' + (err?.message || err));
  }
}

function loadMemory() {
  try {
    const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.entries)) return data.entries;
    return [];
  } catch { return []; }
}
function saveMemory(entries) {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify({ entries }, null, 2), 'utf8');
  } catch (e) { console.error('[qq-bot-pro] save memory failed:', e?.message); }
}
function memoryToText(entries) {
  if (!entries.length) return '';
  return '【长期记忆】\n' + entries.map((e) => '- ' + e.text).join('\n');
}

// ── 群聊本地记忆 ──
// QQ 官方 bot 在群里回完一条后，inbound 会调 clearGroupHistory() 把该群的
// historyBuffer 清空（避免下次 @ 时重复组包）。于是「刚才大家聊了什么」会丢。
// 这里把群消息同步落盘，并回注到 system prompt / 冷场搭话里。
const GROUP_HISTORY_FILE = path.join(MEMORY_DIR, 'group-history.json');
const GROUP_HISTORY_MAX = 300;   // 每群最多存多少条
const GROUP_HISTORY_PROMPT = 20; // 注入上下文用最近多少条

let groupHistory = null;
function loadGroupHistory() {
  if (groupHistory) return groupHistory;
  try {
    const data = JSON.parse(fs.readFileSync(GROUP_HISTORY_FILE, 'utf8'));
    groupHistory = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { groupHistory = {}; }
  return groupHistory;
}
function saveGroupHistory() {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(GROUP_HISTORY_FILE, JSON.stringify(groupHistory ?? {}), 'utf8');
  } catch { }
}
function groupKeyOf(rt, record) {
  const appId = rt?.config?.appId;
  const gid = record?.peerId ?? record?.replyTarget?.targetId;
  if (!appId || !gid) return undefined;
  return appId + ':' + gid;
}
function recentGroupHistory(rt, record, limit = GROUP_HISTORY_PROMPT) {
  const key = groupKeyOf(rt, record);
  const all = key ? (loadGroupHistory()[key] ?? []) : [];
  return all.slice(-limit);
}
function groupHistoryToText(list) {
  if (!list.length) return '';
  return list.map((e) => (e.from || '群友') + ': ' + String(e.text ?? '').slice(0, 200)).join('\n');
}

// 从 dsh-qqbot 的共享单例 history-store 里把缓冲同步到本地文件。
// 必须解析到宿主同一份模块（同一 file URL），才能拿到同一个 MemoryHistoryStore。
let historyStoreModPromise;
function loadHistoryStoreModule() {
  if (historyStoreModPromise) return historyStoreModPromise;
  const file = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules',
    '@tencent-connect', 'dsh-qqbot', 'dist', 'features', 'history-store.js');
  const url = 'file:///' + file.replace(/\\/g, '/');
  historyStoreModPromise = import(url).catch((err) => { diag('history:import-fail ' + (err?.message || err)); return undefined; });
  return historyStoreModPromise;
}
async function syncGroupHistory() {
  const mod = await loadHistoryStoreModule();
  if (!mod || typeof mod.getHistoryStore !== 'function') return 0;
  let store;
  try { store = mod.getHistoryStore(); } catch { return 0; }
  const buffers = store?.buffers;
  if (!(buffers instanceof Map)) return 0;
  const db = loadGroupHistory();
  let added = 0;
  for (const [key, buf] of buffers) {
    if (!Array.isArray(buf) || !buf.length) continue;
    if (!db[key]) db[key] = [];
    const arr = db[key];
    const seen = new Set(arr.map((e) => e.id));
    for (const h of buf) {
      const id = String(h?.messageId ?? '');
      if (!id || seen.has(id)) continue;
      const text = String(h?.content ?? '').trim();
      if (!text) continue;
      arr.push({
        id,
        t: Number(h?.timestamp) || Date.now(),
        from: String(h?.senderName ?? '').slice(0, 40),
        text: text.slice(0, 400),
      });
      seen.add(id);
      added++;
    }
    if (arr.length > GROUP_HISTORY_MAX) arr.splice(0, arr.length - GROUP_HISTORY_MAX);
  }
  if (added) {
    saveGroupHistory();
    diag('history:synced +' + added + ' groups=' + Object.keys(db).length);
  }
  return added;
}

// ── runtime 懒读取 ──
function getRuntime() { return globalThis.__qqbotRuntime; }

// ── nekowhale 表情服务（ctx.provide('stickers', kit)）懒读取 ──
function getStickers() {
  const rt = getRuntime();
  const ctx = rt?.ctx;
  for (const get of [
    () => ctx?.get?.('stickers'),
    () => ctx?.stickers,
    () => rt?.stickers,
  ]) {
    try { const v = get(); if (v && typeof v.parseReply === 'function') return v; } catch { }
  }
  return undefined;
}
function getReplyTarget(exec) {
  const rt = getRuntime();
  return rt?.manager?.findByAgent(exec.agent)?.replyTarget;
}

const registeredNames = new Set();
function registerTool(tools, def) {
  if (registeredNames.has(def.name)) { diag('tool:skip-dup ' + def.name); return; }
  tools.register(def);
  registeredNames.add(def.name);
  diag('tool:registered ' + def.name);
}

export function apply(ctx) {
  const dup = !!globalThis.__qqBotProApplied;
  globalThis.__qqBotProApplied = true;
  diag('apply:enter dup=' + dup + ' tools=' + typeof ctx?.get?.('tools') + ' caller=' + String(new Error().stack || '').split('\n').slice(1, 4).join(' | '));
  // tools 服务在根上下文是「可选」的（im-qqbot bootstrap.js 里也是 ctx.get('tools') 包 try/catch）。
  // 不用 inject:['tools']，避免 tools 未就绪时整个插件装配失败，连带记忆注入/冷场定时器一起挂掉。
  let tools;
  try { tools = ctx?.get?.('tools'); } catch { tools = undefined; }
  if (!tools) tools = ctx?.tools;

  ensureSettingsFile();
  installSettingsRoute(ctx);
  installShutdownWatch(ctx);
  diag('apply:enter tools=' + typeof tools);
  // 记忆注入 + 冷场定时器不依赖 tools，先装（bootstrap 可能晚于本插件激活，用轮询等 runtime）
  whenRuntimeReady((rt) => {
    diag('runtime:ready sender=' + typeof rt?.sender + ' md=' + typeof rt?.sender?.sendMarkdown + ' ctx=' + !!rt?.ctx + ' stickers=' + (typeof getStickers()) + ' probe=' + (() => { try { return ['stickers','webServer','tools'].map((n) => n + '=' + (typeof rt.ctx.get?.(n))).join(','); } catch (e) { return 'ERR:' + (e?.message || e); } })());
    installMemoryInjection(rt);
    installProactiveTimer(rt);
    installStickerBridge(rt);
    installExchangeRecorder(rt);
    installUnarchiveGuard(rt);
  });

  if (!tools?.register) {
    console.error('[qq-bot-pro] tools 服务不可用，未注册表情包/记忆工具（记忆注入/冷场定时器仍已安装）');
    return;
  }

  // ① 表情包：列出
  try { registerTool(tools, {
    name: 'qq_list_stickers',
    description: '浏览大肥鱼表情库里的表情（抽样列出 30 个）。想按情绪/场景精确找，用 sticker_search 更准。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { count: { type: 'integer' }, stickers: { type: 'array', items: { type: 'string' } } },
        required: ['count', 'stickers'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: '表情(' + value.count + '个):\n' + value.stickers.join('\n') }],
    },
    async execute() {
      if (!on('stickerTools')) throw offError('stickerTools');
      const stickers = getStickers();
      if (stickers?.search) {
        try {
          const hits = await stickers.search('', { limit: 30 });
          const lines = hits.map((h) => (typeof stickers.line === 'function' ? stickers.line(h.sticker) : (h.sticker.stem + '｜' + (h.sticker.emotion ?? ''))));
          if (lines.length) return { count: lines.length, stickers: lines };
        } catch (err) { diag('tool:list-fail ' + (err?.message || err)); }
      }
      const lines = localStickerCatalog();
      return { count: lines.length, stickers: lines };
    },
  }); } catch (err) { diag('tool:register-fail ' + (err?.message || err)); }

  // ② 表情包：发送
  try { registerTool(tools, {
    name: 'qq_send_sticker',
    description: '向当前 QQ 会话直接发送一个大肥鱼表情 GIF。name 用 sticker_search 搜到的名字（也可是情绪词，随机取一张）。这是直接发图，不返回 Markdown。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '表情名字（sticker_search 结果里的名字，或情绪词如 开心/摸鱼）。' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' } },
        required: ['id', 'name'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: '已发表情 ' + value.name }],
    },
    async execute(args, exec) {
      if (!on('stickerTools')) throw offError('stickerTools');
      const ref = String(args.name ?? '').trim();
      if (!ref) throw new Error('qq_send_sticker: name 不能为空');
      const rt = getRuntime();
      if (!rt?.mediaSender) throw new Error('qq_send_sticker: runtime 未就绪');
      const replyTarget = getReplyTarget(exec);
      if (!replyTarget) throw new Error('qq_send_sticker: 无法确定发送目标');
      const stickers = getStickers();
      if (stickers?.pick && stickers?.file) {
        try {
          const s = await stickers.pick(ref);
          if (s) {
            const { path: gifPath } = await stickers.file(s);
            await rt.mediaSender.sendImage(replyTarget, { localPath: gifPath });
            return { id: s.id, name: s.name || s.stem };
          }
        } catch (err) { diag('tool:pick-fail ' + (err?.message || err)); }
      }
      const local = localStickerPath(ref);
      if (!local) throw new Error('qq_send_sticker: 没有「' + ref + '」这个表情，可用：' + localStickerCatalog().join('/'));
      await rt.mediaSender.sendImage(replyTarget, { localPath: local });
      return { id: path.basename(local).replace(/\.[^.]+$/, ''), name: ref };
    },
  }); } catch (err) { diag('tool:register-fail ' + (err?.message || err)); }

  // ③ 长期记忆：append
  try { registerTool(tools, {
    name: 'qq_memory_append',
    description: '把值得长期记住的事（人物、约定、偏好、事实）写进长期记忆。只记事实和约定，不记聊天流水。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的一条具体内容。' },
        scope: { type: 'string', description: '可选："group" 或 "c2c"，标记这条记忆属于群聊还是私聊。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, count: { type: 'integer' } },
        required: ['id', 'count'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: '已记住（共 ' + value.count + ' 条）' }],
    },
    async execute(args) {
      if (!on('memory')) throw offError('memory');
      const text = String(args.text ?? '').trim();
      if (!text) throw new Error('qq_memory_append: text 不能为空');
      const entries = loadMemory();
      const entry = {
        id: 'm' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        text,
        scope: args.scope ?? null,
        createdAt: new Date().toISOString(),
      };
      entries.push(entry);
      saveMemory(entries);
      return { id: entry.id, count: entries.length };
    },
  }); } catch (err) { diag('tool:register-fail ' + (err?.message || err)); }

  // ④ 长期记忆：query
  try { registerTool(tools, {
    name: 'qq_memory_query',
    description: '按关键词查长期记忆；不传关键词返回最近的记忆。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '要搜的关键词（留空返回最近的记忆）。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, text: { type: 'string' } },
              required: ['id', 'text'],
              additionalProperties: false,
            },
          },
        },
        required: ['results'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.results.length ? value.results.map((r) => r.id + ' :: ' + r.text).join('\n') : '(无匹配记忆)' }],
    },
    async execute(args) {
      if (!on('memory')) throw offError('memory');
      const kw = String(args.keyword ?? '').trim().toLowerCase();
      const entries = loadMemory();
      const matched = kw
        ? entries.filter((e) => e.text.toLowerCase().includes(kw))
        : entries.slice(-10).reverse();
      return { results: matched.map((e) => ({ id: e.id, text: e.text })) };
    },
  }); } catch (err) { diag('tool:register-fail ' + (err?.message || err)); }

  // ⑤ 长期记忆：remove
  try { registerTool(tools, {
    name: 'qq_memory_remove',
    description: '按 id 删除一条长期记忆（id 由 qq_memory_query 返回）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '要删除的记忆 id。' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { removed: { type: 'boolean' }, count: { type: 'integer' } },
        required: ['removed', 'count'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.removed ? '已删除（剩 ' + value.count + ' 条）' : '未找到该记忆' }],
    },
    async execute(args) {
      if (!on('memory')) throw offError('memory');
      const id = String(args.id ?? '');
      let entries = loadMemory();
      const before = entries.length;
      entries = entries.filter((e) => e.id !== id);
      if (entries.length === before) return { removed: false, count: entries.length };
      saveMemory(entries);
      return { removed: true, count: entries.length };
    },
  }); } catch (err) { diag('tool:register-fail ' + (err?.message || err)); }

  // ⑥ 长期记忆：clear
  try { registerTool(tools, {
    name: 'qq_memory_clear',
    description: '清空全部长期记忆（谨慎使用）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { cleared: { type: 'integer' } },
        required: ['cleared'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: '已清空 ' + value.cleared + ' 条记忆' }],
    },
    async execute() {
      if (!on('memory')) throw offError('memory');
      const entries = loadMemory();
      saveMemory([]);
      return { cleared: entries.length };
    },
  }); } catch (err) { diag('tool:register-fail ' + (err?.message || err)); }

  console.log('[qq-bot-pro] 工具已注册: qq_list_stickers, qq_send_sticker, qq_memory_append/query/remove/clear');
}

// 停机诊断 + 优雅退出兜底
// 现象：桌面更新时宿主收到 shutdown，dispose 结束后把 process.exitCode 置好、断开 IPC，
// 但只要有残留句柄（QQ 网关 socket、SDK 内部定时器等）撑着事件循环，进程就不会自然退出；
// 10 秒优雅期限一过被 SIGTERM 杀掉（Windows 上这个信号无法被 JS 捕获），
// 于是报 "Host did not complete graceful task teardown ... graceful deadline exceeded true"。
// 做法：进程内常驻一个 1 秒的 unref 探针。一旦观察到「真的在停机」
// （曾经连着 IPC，现在 IPC 已断开，且 process.exitCode 已被置上），
// 就把还活着的句柄写进 bridge.log，再等 2 秒主动 exit，让更新重启被判成优雅退出。
// 正常运行时 IPC 一直连着、exitCode 始终是 undefined，绝不会误杀宿主。
const SHUTDOWN_GRACE_TICKS = 2;
const SHUTDOWN_WATCH_GEN = 2;
function installShutdownWatch(ctx) {
  const prev = globalThis.__qqBotProShutdownArm;
  if (prev && prev.gen === SHUTDOWN_WATCH_GEN) return;
  if (prev && prev.timer) { try { clearInterval(prev.timer); } catch { } }
  let sawConnected = false;
  let downTicks = 0;
  const timer = setInterval(() => {
    try {
      const connected = process.connected;
      if (connected) { sawConnected = true; downTicks = 0; return; }
      if (!sawConnected || process.exitCode === undefined) return;
      downTicks += 1;
      diag('shutdown:t+' + downTicks + 's exitCode=' + process.exitCode + ' ' + liveHandleSummary());
      if (downTicks >= SHUTDOWN_GRACE_TICKS) {
        diag('shutdown:force-exit ' + process.exitCode + ' 残留=' + liveHandleSummary());
        try { clearInterval(timer); } catch { }
        process.exit(process.exitCode);
      }
    } catch (err) {
      diag('shutdown:watch-fail ' + (err?.message || err));
    }
  }, 1000);
  if (typeof timer.unref === 'function') timer.unref();
  globalThis.__qqBotProShutdownArm = { gen: SHUTDOWN_WATCH_GEN, timer };
  globalThis.__qqBotProShutdownTimer = timer;
  diag('shutdown:watch-armed v=' + SHUTDOWN_WATCH_GEN);
}

/** 事件循环里还活着的句柄摘要（用于判断停机时是谁在撑着进程）。 */
function liveHandleSummary() {
  const parts = [];
  try {
    parts.push('res=' + (process.getActiveResourcesInfo ? process.getActiveResourcesInfo().join('|') : 'n/a'));
  } catch { }
  try {
    const handles = process._getActiveHandles ? process._getActiveHandles() : [];
    const names = handles.map((h) => {
      const n = (h && h.constructor && h.constructor.name) || typeof h;
      let extra = '';
      if (n === 'Socket' && h.remoteAddress) extra = '(' + h.remoteAddress + ':' + h.remotePort + ')';
      else if (n === 'Server' && typeof h.address === 'function') { try { extra = '(port ' + h.address().port + ')'; } catch { } }
      return n + extra;
    });
    parts.push('handles=' + names.join('|'));
  } catch { }
  return parts.join(' ');
}

function whenRuntimeReady(cb) {
  const poll = () => {
    const rt = getRuntime();
    if (rt?.ctx) { cb(rt); return; }
    setTimeout(poll, 1000);
  };
  poll();
}

// 能力说明（注入到 QQ 会话的 system prompt，让模型知道表情/记忆工具怎么用）
const CAPABILITY_GUIDE = [
  '【可用能力】文字回复会自动发送到 QQ，不需要调用任何发送工具。',
  '【表情包】想在回复里带表情时，单独一行写 [sticker:名字]（名字可用 qq_list_stickers 浏览，或用 sticker_search 按情绪搜），系统会自动把它换成真图发出；也可以用 qq_send_sticker 直接单发一张。不要在回复里写 Markdown 图片链接或本地文件路径。',
  '【看图】用户发来的图片会直接附在消息里，你能直接看到（截图、表情、照片都算），不需要调用任何工具去读文件。看图说话要具体：先说你看到的，再回应他的话。',
  '【群聊记忆】群里没 @ 你时的闲聊会被本地存档（最近 20 条自动出现在你上下文里），所以你知道大家刚在聊什么；更早的内容用 qq_memory_query 查长期记忆。',
  '【窗格互通】群聊和私聊是两个独立窗格（各自有历史），但你上下文里会自动带上「另一个窗格最近说的话」，所以两边是连着的：私聊里提过的事，群里也记得，反过来也一样。',
  '【人设】你的性格与说话方式由下方的「人设」段落决定（用户可在设置页改），照着演，不要解释设定、不要跳出角色。',
  '【长期记忆】遇到值得长期记住的信息（称呼、约定、重要事件、喜好），用 qq_memory_append 记下来；需要回忆时用 qq_memory_query 查。记忆会自动出现在你的上下文里。',
].join('\n');

// 记忆注入 hook：与 session-manager 的 registerScopePromptInjection 同 pattern，
// order 80（在 groupPrompt 的 order 90 之前），只在 QQ 会话上注入。
function installMemoryInjection(rt) {
  if (!rt?.ctx?.on) return;
  if (rt.__qqProPromptInstalled) return;
  rt.__qqProPromptInstalled = true;
  rt.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next();
    try {
      if (!context?.agent) return assembled;
      const record = rt.manager?.findByAgent(context.agent);
      if (!record) return assembled;
      const cfg = features();
      const entries = loadMemory();
      const sections = [...(assembled.sections ?? [])];
      sections.push({ name: 'qqbot:capability-guide', order: 78, text: CAPABILITY_GUIDE });
      // 个性提示词：设置页里写的 persona 直接进 system prompt（群聊 / 私聊各一份）
      const personaKey = record.scope === 'group' ? 'group' : 'direct';
      const personaText = String(readSettingsFile()?.persona?.[personaKey] ?? '').trim();
      if (personaText) {
        sections.push({
          name: 'qqbot:persona',
          order: 91,
          text: '【人设（用户在设置页里写的，优先级高于你的默认风格：语气、称呼、禁忌都按这个来，别跳出来解释设定）】\n' + personaText,
        });
      }
      if (cfg.groupHistory && record.scope === 'group') {
        // 群历史缓冲会被 clearGroupHistory 清空，这里用本地存档补上「刚才大家在聊什么」
        const histText = groupHistoryToText(recentGroupHistory(rt, record));
        if (histText) {
          sections.push({
            name: 'qqbot:group-history',
            order: 79,
            text: '【最近的群聊记录（本地存档，可能比你记得的更早，含没 @ 你的闲聊）】\n' + histText,
          });
        }
      }
      // 跨窗格：私聊里补上群里刚聊的，群里补上私聊刚说的，记忆连着
      const other = record.scope === 'group' ? 'c2c' : 'group';
      const crossText = cfg.crossScope ? exchangesToText(recentOtherExchanges(record.scope)) : '';
      if (crossText) {
        sections.push({
          name: 'qqbot:cross-scope',
          order: 77,
          text: (other === 'group'
            ? '【群里最近说的话（和这是两个窗格，你看不到那边的历史，这是给你接话用的，别逐条复述）】\n'
            : '【私聊里最近说的话（和这是两个窗格，你看不到那边的历史，这是给你接话用的，别逐条复述）】\n') + crossText,
        });
      }
      const memText = memoryToText(entries);
      if (cfg.memory && memText) sections.push({ name: 'qqbot:memory', order: 80, text: memText });
      return { ...assembled, sections };
    } catch { return assembled; }
  });
}

// ── 窗格互通：群聊 ↔ 私聊 最近的对话互记 ───────────────────────────────
// QQ 群聊和私聊是两个独立 session（不同 peerId/openid），模型各自只看得到本窗格历史。
// 这里把两边最近说的话各记一份，注入时补上「另一个窗格刚说了什么」，让记忆是连着的。
const EXCHANGE_FILE = path.join(MEMORY_DIR, 'exchanges.json');
const EXCHANGE_MAX = 200;   // 落盘上限
const EXCHANGE_PROMPT = 14; // 注入另一个窗格的最近多少条
const EXCHANGE_TEXT_MAX = 300;
let exchanges = null;
let exchangeHookLogged = false;

function loadExchanges() {
  if (exchanges) return exchanges;
  try {
    const data = JSON.parse(fs.readFileSync(EXCHANGE_FILE, 'utf8'));
    exchanges = Array.isArray(data?.items) ? data.items : [];
  } catch { exchanges = []; }
  return exchanges;
}

function saveExchanges() {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(EXCHANGE_FILE, JSON.stringify({ items: loadExchanges().slice(-EXCHANGE_MAX) }), 'utf8');
  } catch { /* 落盘失败不影响聊天 */ }
}

function extractTextFromMessage(msg) {
  const content = Array.isArray(msg?.content) ? msg.content : [];
  const parts = [];
  for (const part of content) if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  return parts.join('\n');
}

// 入站文本形如 "[卡卡不想动 (DC5E...)] 改好了 (@you)"，把昵称抠出来当发言人
function speakerOf(isUser, text) {
  if (!isUser) return '小肥鱼';
  const m = text.match(/^\[([^\]\n]{1,40})\s*\(/);
  return m ? m[1].trim() : '对方';
}

function stripSpeakerPrefix(text) {
  const m = text.match(/^\[[^\]\n]{1,40}\]\s*([\s\S]*)$/);
  return (m ? m[1] : text).trim();
}

function cleanExchangeText(raw) {
  let t = String(raw ?? '').replace(/\r/g, '').trim();
  const marker = '[Current message]';
  const at = t.lastIndexOf(marker);
  if (at >= 0) t = t.slice(at + marker.length).trim();
  return t.slice(0, EXCHANGE_TEXT_MAX);
}

function pushExchange(scope, from, text) {
  if (!text) return;
  const items = loadExchanges();
  const last = items[items.length - 1];
  if (last && last.scope === scope && last.from === from && last.text === text) return;
  items.push({ t: Date.now(), scope, from, text: text.slice(0, EXCHANGE_TEXT_MAX) });
  if (items.length > EXCHANGE_MAX) items.splice(0, items.length - EXCHANGE_MAX);
  exchanges = items;
  saveExchanges();
}

function exchangesToText(list) {
  return list.map((e) => (e.scope === 'group' ? '（群里）' : '（私聊）') + e.from + ': ' + e.text).join('\n');
}

function recentOtherExchanges(scope, limit = EXCHANGE_PROMPT) {
  const other = scope === 'group' ? 'c2c' : 'group';
  return loadExchanges().filter((e) => e.scope === other).slice(-limit);
}

function installExchangeRecorder(rt) {
  if (!rt?.ctx?.on) return;
  if (rt.__qqProExchangeInstalled) return;
  rt.__qqProExchangeInstalled = true;
  rt.ctx.on('session/event', (session, event) => {
    try {
      if (!event?.type) return;
      if (event.type !== 'user/message' && event.type !== 'assistant/message') return;
      const sid = session?.id ?? session?.header?.id;
      if (!sid) return;
      const record = rt.manager?.findBySessionId?.(sid);
      if (!record) return;
      rememberPresence(record);
      const isUser = event.type === 'user/message';
      const raw = isUser ? extractTextFromMessage(event.data) : extractTextFromMessage(event.data?.message ?? event.data);
      const cleaned = cleanExchangeText(raw);
      const text = stripSpeakerPrefix(cleaned);
      if (!text) return;
      if (text.startsWith('（系统）') || text.startsWith('Current runtime context') || text.startsWith('[Chat history begins]')) return;
      if (!exchangeHookLogged) { exchangeHookLogged = true; diag('exchange:hook first scope=' + record.scope); }
      if (features().crossScope) pushExchange(record.scope, speakerOf(isUser, cleaned), text);
    } catch { /* 记录失败不影响会话 */ }
  });
}

// ── 归档看守 ──────────────────────────────────────────────────────────
// 宿主的工作区注册表一旦把 QQ 会话标成「已归档」，agent 每轮 pre-step 会被
// ArchivedSessionGate 直接 reject（turn/end 记 blocked、不产生任何回复），
// 用户看到的就是「她完全不说话了」。这里定期把 QQ 会话从归档里捞回来。
const ARCHIVE_CHECK_MS = 60 * 1000;

function qqSessionIds(rt) {
  const ids = new Set();
  try {
    const prefs = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh-qqbot', 'model-prefs.json'), 'utf8'));
    for (const v of Object.values(prefs?.sessionIds ?? {})) if (typeof v === 'string' && v) ids.add(v);
  } catch { /* 没这个文件就只靠活着的 record */ }
  try {
    for (const record of rt?.manager?.sessions?.values?.() ?? []) if (record?.sessionId) ids.add(record.sessionId);
  } catch { /* ignore */ }
  return ids;
}

// 兜底：拿不到注册表句柄时，直接在落盘文件里把 QQ 会话从归档列表摘掉。
// 宿主的归档列表只在启动时从 workspace.json 读一次，所以改文件 + 下次启动即干净；
// 它同时也是「registry 够不着」时唯一的自动恢复手段。
function sanitizeArchivedFile(rt) {
  try {
    const file = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = data?.global?.archivedSessionIds;
    if (!Array.isArray(list) || !list.length) return;
    const ids = qqSessionIds(rt);
    if (!ids.size) return;
    const kept = list.filter((x) => !ids.has(x));
    if (kept.length === list.length) return;
    data.global.archivedSessionIds = kept;
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    diag('archive:file-cleaned removed=' + (list.length - kept.length));
  } catch (err) {
    diag('archive:file-clean-fail ' + (err?.message || err));
  }
}

function installUnarchiveGuard(rt) {
  if (!rt?.ctx?.get) return;
  if (rt.__qqProArchiveGuard) return;
  rt.__qqProArchiveGuard = true;
  let greeted = false;
  let regMissing = false;
  const registry = () => {
    try {
      if (rt.workspaceRegistry && Array.isArray(rt.workspaceRegistry.archivedSessionIds)) return rt.workspaceRegistry;
    } catch { /* fall through */ }
    try {
      const direct = rt.ctx.get?.('workspaceRegistry') ?? rt.ctx.workspaceRegistry;
      if (direct) return direct;
    } catch { /* fall through */ }
    try {
      const viaRoot = rt.ctx.root?.get?.('workspaceRegistry') ?? rt.ctx.root?.workspaceRegistry;
      if (viaRoot) return viaRoot;
    } catch { /* fall through */ }
    return undefined;
  };
  const check = async () => {
    if (!on('archiveGuard')) return;
    const reg = registry();
    if (!reg?.archivedSessionIds || typeof reg.unarchiveSession !== 'function') {
      if (!regMissing) {
        regMissing = true;
        diag('archive:registry-missing probe=' + String(rt.workspaceRegistryProbe || '?'));
        sanitizeArchivedFile(rt);
      }
      return;
    }
    const ids = qqSessionIds(rt);
    if (!ids.size) return;
    let restored = 0;
    for (const id of ids) {
      if (!reg.archivedSessionIds.includes(id)) continue;
      try {
        await reg.unarchiveSession(id);
        restored += 1;
        diag('archive:restored ' + id);
      } catch (err) {
        diag('archive:restore-fail ' + id + ' ' + (err?.message || err));
      }
    }
    if (!restored || greeted) return;
    greeted = true;
    // 归档期间群里的消息一条都没进去，恢复后主动接一句，免得用户以为还坏着
    for (const record of rt.manager?.sessions?.values?.() ?? []) {
      try {
        if (record.scope !== 'group') continue;
        if (record.agent?.status !== 'idle') continue;
        await rt.sendToAgent(record, '（系统）你刚才因为会话被归档，群里的消息一条都没收到。现在恢复了，在群里自然地说一句，接上之前的话头，别解释系统和归档。');
      } catch { /* 单群失败不影响其他群 */ }
    }
  };
  check().catch(() => { });
  const timer = setInterval(() => { check().catch(() => { }); }, ARCHIVE_CHECK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

// 冷场定时器：每 10 分钟检查一次；群会话空闲 ≥ 30 分钟且 agent 空闲时，
// 以 0.5 概率注入开话题指令（agent 生成的文本会自动发到群）。
// 30 分钟是为了让开口落在「被动回复 1 小时 TTL」内（reply-limiter ttlMs=3600_000），
// 这样发出去走的是合法被动回复，而不是容易被平台拒绝的主动推送。
// 默认参数；可在 ~/.dsh/qq-bot-pro/timer.json 里覆盖（{checkMs,idleMs,prob}），改完重载插件即生效
function proactiveTuning() {
  const def = { checkMs: 10 * 60 * 1000, idleMs: 30 * 60 * 1000, c2cIdleMs: 40 * 60 * 1000, prob: 0.5 };
  try {
    const p = path.join(MEMORY_DIR, 'timer.json');
    if (!fs.existsSync(p)) return def;
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
    return {
      checkMs: Number(j.checkMs) > 5000 ? Number(j.checkMs) : def.checkMs,
      idleMs: Number(j.idleMs) > 30000 ? Number(j.idleMs) : def.idleMs,
      c2cIdleMs: Number(j.c2cIdleMs) > 30000 ? Number(j.c2cIdleMs) : def.c2cIdleMs,
      prob: typeof j.prob === 'number' ? Math.min(1, Math.max(0, j.prob)) : def.prob,
    };
  } catch { return def; }
}
const HISTORY_SYNC_MS = 3 * 1000; // 每 15 秒把群历史缓冲同步到本地存档

// ── 在场表 ─────────────────────────────────────────────────────────────
// 宿主重启 / 插件热重载后 manager.sessions 是空的，冷场定时器就再也等不到
// 「该找谁说话」。这里把最近来过的会话（含最后一次 replyTarget）落盘，
// 冷场时先按 key 把会话重新 getOrCreate 出来再开口。
const PRESENCE_FILE = path.join(MEMORY_DIR, 'presence.json');
const PRESENCE_MAX = 20;
let presenceCache = null;

function loadPresence() {
  if (presenceCache) return presenceCache;
  try {
    const j = JSON.parse(fs.readFileSync(PRESENCE_FILE, 'utf8'));
    presenceCache = Array.isArray(j?.items) ? j.items : [];
  } catch { presenceCache = []; }
  return presenceCache;
}
function savePresence() {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(PRESENCE_FILE, JSON.stringify({ items: (presenceCache ?? []).slice(-PRESENCE_MAX) }), 'utf8');
  } catch { }
}
function rememberPresence(record) {
  try {
    if (!record?.scope || !record?.peerId) return;
    const list = loadPresence();
    const key = record.sessionKey || (record.scope + ':' + record.peerId);
    const item = {
      key, scope: record.scope, peerId: record.peerId, senderId: record.senderId,
      replyTarget: record.replyTarget, lastActivity: record.lastActivity || Date.now(),
    };
    const i = list.findIndex((x) => x.key === key);
    if (i >= 0) list[i] = item; else list.push(item);
    if (list.length > PRESENCE_MAX) list.splice(0, list.length - PRESENCE_MAX);
    savePresence();
  } catch { }
}
// 双实例（profile 装配 + gateway 内联装载）共享同一张表，避免同时开口
const recentTriggers = (globalThis.__qqProRecentTriggers ??= new Map());

function installProactiveTimer(rt) {
  if (rt.__qqProTimerInstalled) return;
  rt.__qqProTimerInstalled = true;
  // 群历史落盘：即使宿主 clearGroupHistory() 清空了环形缓冲，本地仍有存档
  const syncTimer = setInterval(() => { if (on('groupHistory')) syncGroupHistory().catch(() => { }); }, HISTORY_SYNC_MS);
  if (typeof syncTimer.unref === 'function') syncTimer.unref();
  syncGroupHistory().catch(() => { });

  const tuning = proactiveTuning();
  diag('timer:install checkMs=' + tuning.checkMs + ' idleMs=' + tuning.idleMs + ' prob=' + tuning.prob);
  const timer = setInterval(async () => {
    if (!on('proactive')) return;
    const manager = rt.manager;
    if (!manager?.sessions) { diag('timer:tick no-sessions'); return; }
    const now = Date.now();
    const det = [];
    for (const r of manager.sessions.values()) {
      det.push(String(r.scope) + '/' + String(r.agent?.status) + '/' + Math.round((now - (r.lastActivity ?? 0)) / 60000) + 'm');
    }
    diag('timer:tick sessions=' + manager.sessions.size + ' det=' + (det.join(',') || 'none'));
    const targets = [];
    try { for (const r of manager.sessions.values()) targets.push({ key: r.sessionKey || (r.scope + ':' + r.peerId), scope: r.scope, peerId: r.peerId, live: r }); } catch { }
    for (const p of loadPresence()) {
      if (!targets.some((t) => t.key === p.key)) {
        targets.push({ key: p.key, scope: p.scope, peerId: p.peerId, senderId: p.senderId, replyTarget: p.replyTarget, lastActivity: p.lastActivity, live: undefined });
      }
    }
    for (const t of targets) {
      try {
        const isGroup = t.scope === 'group';
        if (isGroup ? !on('proactiveGroup') : !on('proactiveC2c')) continue;
        const idleMs = isGroup ? tuning.idleMs : (tuning.c2cIdleMs || tuning.idleMs);
        let record = t.live;
        const lastSeen = record ? (record.lastActivity ?? 0) : (t.lastActivity ?? 0);
        if (Date.now() - lastSeen < idleMs) continue;
        if (Date.now() - (recentTriggers.get(t.key) ?? 0) < 10 * 60 * 1000) continue;
        if (!record) {
          try {
            record = await manager.getOrCreate?.(t.scope, t.peerId, t.senderId, t.replyTarget);
          } catch (err) {
            // 宿主里同 sessionId 的 agent 可能还挂着（上次实例没释放）：跳过本轮，等它空闲/回收
            const m = String(err?.message || err);
            if (/already exists/i.test(m)) { diag('proactive:exists key=' + t.key); continue; }
            throw err;
          }
          if (!record) { diag('proactive:no-record key=' + t.key); continue; }
        }
        if (record.agent?.status !== 'idle') { diag('proactive:busy key=' + t.key + ' status=' + String(record.agent?.status)); continue; }
        if (Math.random() > tuning.prob) { diag('proactive:roll-skip key=' + t.key); continue; }
        recentTriggers.set(t.key, Date.now());
        record.lastActivity = Date.now();
        // 主动发言必须走主动推送：QQ 被动回复的 msg_id 只有 5 分钟有效期，
        // 带着旧 msgId 发送会直接失败（日志里就是「回复消息msg_id已过期」），消息其实一条都没发出去。
        var _tgt = record.replyTarget;
        if (_tgt && typeof _tgt === 'object' && (_tgt.msgId || _tgt.eventId)) {
          delete _tgt.msgId;
          delete _tgt.eventId;
          diag('proactive:drop-msgid key=' + t.key);
        }
        rememberPresence(record);
        let prompt;
        if (isGroup) {
          const histText = groupHistoryToText(recentGroupHistory(rt, record, 15));
          prompt = '（系统）群里冷场很久了，主动抛个话题和大家聊聊吧。自然一点、像随口说起，别用问句开场，别刷屏。'
            + (histText ? '\n\n最近群聊记录（供参考，别逐条复述，接着大家的话头说）：\n' + histText : '');
        }
        else {
          prompt = '（系统）私聊这边安静很久了，主动找对方说句话吧。像随手发条消息那样，短一点、自然一点，别说"系统""定时""主动汇报"这类词。';
        }
        diag('proactive:trigger key=' + t.key + ' scope=' + t.scope);
        await rt.sendToAgent(record, prompt);
      }
      catch (err) {
        diag('proactive:fail key=' + t.key + ' err=' + String(err?.message || err));
      }
    }
  }, tuning.checkMs);
  if (typeof timer.unref === 'function') timer.unref();
}

// 表情包桥接：把 agent 回复里的 [sticker:名字] / [sticker:情绪] 换成真实 GIF。
// 依赖 dsh-nekowhale-stickers 插件的 `stickers` 服务（ctx.get('stickers')），
// 懒读取、缺失时静默降级为原文（不影响纯文本回复）。
// 本地自带表情库（plugins/qq-bot-pro/stickers/*.png），不依赖 nekowhale 服务
const LOCAL_STICKER_DIR = path.join(__dirname, '..', 'stickers');
const STICKER_ALIASES = {
  草: 'cao', 乐: 'le', 笑: 'le', 好耶: 'haoye', 难绷: 'nanbeng', 6: 'liu', 溜: 'liu',
  才不胖: 'caibupang', 不胖: 'caibupang', 对呀: 'duiya', 对对: 'duiya', 贴贴: 'tietie',
  抱抱: 'tietie', 摸鱼: 'moyu', 冲: 'chong', 困: 'kun', 吃瓜: 'chigua', 点赞: 'dianzan',
  赞: 'dianzan', 哭: 'kuku', 哭哭: 'kuku', 怒: 'nu', 生气: 'nu', 疑问: 'yiwen', 问号: 'yiwen',
};
// 情绪词 → 最接近的本地表情（模型偶尔自己造词：气鼓鼓 / 委屈巴巴 / 无语住 之类）
const STICKER_KEYWORDS = [
  [/气|怒|恼|烦|凶|哼|不爽|讨厌|叉腰/, 'nu'],
  [/哭|呜呜|委屈|难过|伤心|泪|可怜|心碎|崩/, 'kuku'],
  [/笑|乐|草|哈哈|好笑|嘻|绷/, 'le'],
  [/好耶|耶|棒|厉害|牛|太强|优秀|万岁/, 'haoye'],
  [/难绷|无语|离谱|汗|尴尬|麻了|服了|呆|懵|震惊|惊|傻/, 'nanbeng'],
  [/摸鱼|摆烂|躺|累|上班|加班|划水|偷懒/, 'moyu'],
  [/贴|抱|亲|摸|蹭|揉|爱|害羞|羞|脸红|比心/, 'tietie'],
  [/冲|走|加油|干|上|来/, 'chong'],
  [/困|睡|晚安|哈欠|睡意/, 'kun'],
  [/吃瓜|八卦|围观|看戏|瓜/, 'chigua'],
  [/赞|顶|同意|支持|棒棒|红花/, 'dianzan'],
  [/胖|圆|嘟嘟/, 'caibupang'],
  [/[?？]|疑问|问号|啥|什么|为什么|啊这/, 'yiwen'],
  [/对|没错|确实|是的|嗯|认同/, 'duiya'],
  [/期待|等不及|好想看|盼|搓手|迫不及待/, 'haoye'],
  [/不高兴|不爽|郁闷|低落|丧|emo|心累/, 'kuku'],
  [/震惊|啊这|离谱|笑死|绷不住|逆天|夸张/, 'nanbeng'],
];
function localStickerPath(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return undefined;
  const stems = new Map();
  try {
    for (const f of fs.readdirSync(LOCAL_STICKER_DIR)) {
      const m = f.match(/^(.*)\.(png|gif|jpg|jpeg|webp)$/i);
      if (m) stems.set(m[1].toLowerCase(), path.join(LOCAL_STICKER_DIR, f));
    }
  } catch { return undefined; }
  const lower = raw.toLowerCase();
  if (stems.has(lower)) return stems.get(lower);
  const alias = STICKER_ALIASES[raw];
  if (alias && stems.has(alias)) return stems.get(alias);
  for (const [stem, file] of stems) if (lower.includes(stem) || raw.includes(stem)) return file;
  // 造词兜底：先整串按情绪关键字匹配，再逐字退一步
  for (const [re, stem] of STICKER_KEYWORDS) {
    if (re.test(raw) && stems.has(stem)) return stems.get(stem);
  }
  for (const ch of [...raw]) {
    for (const [re, stem] of STICKER_KEYWORDS) {
      if (re.test(ch) && stems.has(stem)) return stems.get(stem);
    }
  }
  return undefined;
}
function localStickerCatalog() {
  try {
    return fs.readdirSync(LOCAL_STICKER_DIR)
      .map((f) => f.match(/^(.*)\.(png|gif|jpg|jpeg|webp)$/i))
      .filter(Boolean)
      .map((m) => m[1]);
  } catch { return []; }
}

// 本地 byhash 缓存：nekowhale 把 <hash>.gif 存在这里，不依赖 stickers 服务即可发图
const NEKO_BYHASH = path.join(os.homedir(), '.dsh', 'nekowhale-stickers', 'byhash');
const NEKO_RENDERS = path.join(os.homedir(), '.dsh', 'nekowhale-stickers', 'renders');
function localRenderedGif(id) {
  try {
    const gifPath = path.join(NEKO_RENDERS, String(id) + '.gif');
    if (fs.existsSync(gifPath)) return gifPath;
  } catch { }
  return undefined;
}
function localGifByHash(hash) {
  try {
    const gifPath = path.join(NEKO_BYHASH, String(hash) + '.gif');
    if (fs.existsSync(gifPath)) return gifPath;
  } catch { }
  return undefined;
}

// 表情包桥接：把 agent 回复里的 Markdown 图片行 ![名字](url) 和 [sticker:名字] 标记
// 换成真实 GIF（走 mediaSender.sendImage），纯文本仍走原路径。
// 解析顺序：① URL 里的 hash → 本地 byhash 缓存（最稳，不依赖服务）
//          ② stickers 服务 parseReply/file（可按名字/情绪解析）
//          ③ 都失败 → 记日志跳过（至少文字能到）
function installStickerBridge(rt) {
  const sender = rt?.sender;
  if (sender && sender.__stickerBridgeInstalled) { diag('bridge:skip duplicated'); return; }
  if (!sender || typeof sender.sendMarkdown !== 'function') {
    diag('bridge:no-sender sender=' + typeof sender + ' md=' + typeof sender?.sendMarkdown);
    return;
  }
  const orig = sender.sendMarkdown;

  const flushText = async (target, buf) => {
    const textOut = buf.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (textOut) await orig(target, textOut, undefined);
  };

  const resolveGif = async (part, stickers) => {
    if (part.type === 'img') {
      // nekowhale 的图片 URL 有两种：/s/<hash>.gif = 图库原图（byhash 缓存），
      // /r/<id>.gif = meme_render 现画的图（renders 目录），两者都要能落地成 file。
      const hm = part.url.match(/\/(s|r)\/([0-9a-f]{6,64})\.gif/i);
      if (hm) {
        const local = hm[1].toLowerCase() === 'r' ? localRenderedGif(hm[2]) : localGifByHash(hm[2]);
        if (local) return local;
        if (stickers && typeof stickers.fileByHash === 'function' && hm[1].toLowerCase() === 's') {
          try { const got = await stickers.fileByHash(hm[2]); if (got) return got; } catch { }
        }
        if (stickers && typeof stickers.renderPath === 'function' && hm[1].toLowerCase() === 'r') {
          try {
            const got = stickers.renderPath(hm[2]);
            if (got && fs.existsSync(got)) return got;
          } catch { }
        }
      }
    }
    const local = localStickerPath(part.type === 'img' ? part.alt : part.ref);
    if (local) return local;
    if (stickers?.parseReply && stickers?.file) {
      const ref = part.type === 'img' ? part.alt : part.ref;
      try {
        const list = await stickers.parseReply('[sticker:' + ref + ']');
        for (const sp of list) {
          if (sp?.type === 'sticker' && sp.sticker) {
            const got = await stickers.file(sp.sticker);
            if (got?.path) return got.path;
          }
        }
      } catch (err) {
        diag('resolve:kit-fail ref=' + ref + ' err=' + (err?.message || err));
      }
    }
    return undefined;
  };

  sender.sendMarkdown = async (target, content, opts) => {
    let stickers;
    try { stickers = getStickers(); } catch { stickers = undefined; }
    if (typeof content !== 'string') return orig(target, content, opts);
    if (!on('stickerBridge')) return orig(target, content, opts);

    // 去掉 sticker_send / meme_render 的说明尾巴（工具 boilerplate，不该发给用户）
    const text = content.replace(/把上面这行原样放进回复即可显示。?/g, '');

    const RE = /!\[([^\]\n]{1,80})\]\(([^)\s]+)\)|\[sticker:([^\]\n]{1,80})\]/g;
    const parts = [];
    let last = 0;
    let m;
    while ((m = RE.exec(text))) {
      if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) });
      if (m[1] !== undefined) parts.push({ type: 'img', alt: m[1], url: m[2] });
      else parts.push({ type: 'tag', ref: m[3] });
      last = RE.lastIndex;
    }
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });

    const hasMedia = parts.some((pp) => pp.type !== 'text');
    diag('md:enter len=' + text.length + ' hasMedia=' + hasMedia + ' kit=' + (typeof stickers) + ' scope=' + (target && target.scope));
    if (!hasMedia) return orig(target, content, opts);

    const buf = [];
    for (const part of parts) {
      if (part.type === 'text') { buf.push(part.value); continue; }
      try {
        await flushText(target, buf);
      } catch (err) { diag('flush-text-fail err=' + (err?.message || err)); }
      buf.length = 0;
      try {
        const gifPath = await resolveGif(part, stickers);
        if (!gifPath) { diag('media:unresolved ' + JSON.stringify(part).slice(0, 160)); continue; }
        await rt.mediaSender.sendImage(target, { localPath: gifPath });
        diag('media:sent ' + gifPath);
      } catch (err) {
        diag('media:send-fail err=' + (err?.message || err));
        console.error('[qq-bot-pro] sticker send failed:', err?.message);
      }
    }
    try { await flushText(target, buf); } catch (err) { diag('flush-text-tail-fail err=' + (err?.message || err)); }
  };
  sender.__stickerBridgeInstalled = true;
  diag('bridge:installed');
  console.log('[qq-bot-pro] 表情包桥接已安装（Markdown 图片行 / [sticker:名字] → 真 GIF）');
}
