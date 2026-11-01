// host-bridge.js：由 gateway/bootstrap.js 在运行时动态 import 的装载器。
// 为什么需要它：profile bundle 装配在本机被静默跳过（bridge.log 从不出现），
// 但 gateway 一定会被加载，所以直接在这里把 qq-bot-pro 装上去。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(os.homedir(), '.dsh', 'qq-bot-pro', 'bridge.log');
function diag(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + msg + '\n', 'utf8');
  } catch { }
}

export async function install(rt) {
  diag('host-bridge:install rt=' + typeof rt + ' ctx=' + !!rt?.ctx + ' sender=' + typeof rt?.sender?.sendMarkdown);
  if (!rt?.ctx) { diag('host-bridge:abort no ctx'); return; }
  try {
    const probe = ['tools', 'stickers', 'agentPresets', 'agent-preset-registry', 'loader']
      .map((n) => { try { return n + '=' + typeof rt.ctx.get?.(n); } catch (e) { return n + '=ERR'; } })
      .join(',');
    diag('host-bridge:services ' + probe);
  } catch { }
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, 'index.js')).href);
    diag('host-bridge:module keys=' + Object.keys(mod).join(','));
    await mod.apply(rt.ctx);
    diag('host-bridge:apply returned');
  } catch (err) {
    diag('host-bridge:FAILED ' + String((err && (err.stack || err.message)) || err));
    try { globalThis.__qqBotProError = String((err && (err.stack || err.message)) || err); } catch { }
  }
  try {
    const tools = rt.ctx.get?.('tools');
    diag('host-bridge:tools register=' + typeof tools?.register + ' guard=' + typeof tools?.guard);
  } catch (e) { diag('host-bridge:tools probe failed ' + (e?.message || e)); }
}
