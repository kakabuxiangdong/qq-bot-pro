#!/usr/bin/env node
/**
 * patch-host.mjs — 给已安装的 @tencent-connect/dsh-qqbot 打上 qq-bot-pro 需要的宿主补丁。
 *
 * 为什么需要宿主补丁：im-qqbot 本身只把「模型输出的文本」发到 QQ，没有表情包、没有主动发言、
 * 也不暴露内部运行时对象。qq-bot-pro 插件靠 6 处宿主改动接上能力：
 *   1) dist/gateway/bootstrap.js     暴露 globalThis.__qqbotRuntime + 装载 host-bridge.js
 *   2) dist/gateway/spoke-tracker.js （新文件）记录「她刚说过话」用于不 @ 也接话
 *   3) dist/gateway/middleware-setup.js  隐式 @ 门控 + gate 诊断日志
 *   4) dist/model/model-resolver.js  QQ 会话默认 reasoningEffort=low
 *   5) dist/transport/inbound.js     入站图片直接进模型上下文（不用先落盘再读）
 *   6) dist/index.js                 网关启动失败自动重试（最多 4 次）
 *
 * 补丁是「锚点 find/replace」，不依赖 git，也不整包替换：只改上面几处，版本不对会拒绝执行。
 * 幂等：打过补丁的文件末尾有 marker 注释，重复运行会跳过；改动前自动备份，可 --revert。
 *
 * 用法：
 *   node lib/patch-host.mjs                 # 自动发现所有 profile 里的 dsh-qqbot 并打补丁
 *   node lib/patch-host.mjs --check         # 只看状态，不写文件
 *   node lib/patch-host.mjs --revert        # 还原成原版（从 .qq-bot-pro-backup 恢复）
 *   node lib/patch-host.mjs --target <dir>  # 指定某个包目录（可重复）
 *   node lib/patch-host.mjs --register --profile <profile 目录>   # 把本插件登记进 profile
 *   可选：--force（版本不符也强行打，锚点对不上会安全失败）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..');
const PATCHES = JSON.parse(fs.readFileSync(path.join(__dirname, 'patches.json'), 'utf8'));
const MARK = 'qq-bot-pro:patched';
const BACKUP_DIR = '.qq-bot-pro-backup';

function log(msg) { console.log(msg); }
function warn(msg) { console.warn('  ! ' + msg); }

function parseArgs(argv) {
  const opts = { targets: [], check: false, revert: false, force: false, register: false, profile: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--revert') opts.revert = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--register') opts.register = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--target') opts.targets.push(argv[++i]);
    else if (a === '--profile') opts.profile = argv[++i];
    else if (a.startsWith('--target=')) opts.targets.push(a.slice(9));
    else if (a.startsWith('--profile=')) opts.profile = a.slice(10);
    else warn('忽略未知参数: ' + a);
  }
  return opts;
}

function discoverTargets(explicit) {
  const found = [];
  // 显式给了 --target 就只动它：避免 --revert 顺手把别的安装也还原了
  if (explicit.length) return [...new Set(explicit.map((t) => path.resolve(t)))];
  const profilesRoot = path.join(os.homedir(), '.dsh', 'profiles');
  if (fs.existsSync(profilesRoot)) {
    for (const name of fs.readdirSync(profilesRoot)) {
      const p = path.join(profilesRoot, name, 'node_modules', '@tencent-connect', 'dsh-qqbot');
      if (fs.existsSync(path.join(p, 'package.json'))) found.push(p);
    }
  }
  return [...new Set(found)];
}

function readPkg(dir) {
  const file = path.join(dir, 'package.json');
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('无法解析 ' + file + '：' + e.message + '（若手工编辑过，请确认是合法 JSON）');
  }
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0, at = 0;
  for (;;) {
    const i = hay.indexOf(needle, at);
    if (i === -1) return n;
    n++;
    at = i + needle.length;
  }
}

function nodeCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) return String((r.stderr || '') + (r.stdout || '')).split('\n').filter(Boolean).slice(0, 3).join(' | ');
  return '';
}

function fileStatus(target, rel) {
  const abs = path.join(target, rel);
  if (!fs.existsSync(abs)) return { rel, abs, state: 'missing' };
  const text = fs.readFileSync(abs, 'utf8');
  if (text.includes(MARK)) return { rel, abs, state: 'patched' };
  const ops = PATCHES.files[rel] ?? [];
  // 逐段「试打」：后面的段落的锚点可能落在前面段落改过的文本里，
  // 所以必须按顺序在演化文本上校验，而不是拿所有锚点去匹配原文件（会误报 anchor-missing）。
  let trial = text;
  for (let i = 0; i < ops.length; i++) {
    const n = countOccurrences(trial, ops[i].find);
    if (n === 0) return { rel, abs, state: 'anchor-missing', detail: 'hunk#' + (i + 1) + ' 找不到锚点', ops };
    if (n > 1) return { rel, abs, state: 'ambiguous', detail: 'hunk#' + (i + 1) + ' 锚点出现 ' + n + ' 次', ops };
    trial = trial.replace(ops[i].find, () => ops[i].replace);
  }
  if (trial === text) return { rel, abs, state: 'patched', detail: '内容与补丁目标一致（无 marker）', ops, patchedText: trial };
  return { rel, abs, state: 'patchable', ops, patchedText: trial };
}

function backupFile(target, rel) {
  const backupRoot = path.join(target, BACKUP_DIR);
  const dest = path.join(backupRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) fs.copyFileSync(path.join(target, rel), dest);
  const manifestPath = path.join(backupRoot, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: [], created: [], patchedAt: undefined };
  if (!manifest.files.includes(rel)) manifest.files.push(rel);
  manifest.patchedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return dest;
}

function applyToFile(target, st) {
  // 直接用 dry-run 算好的结果写盘：校验与写入必须基于同一份演化文本，否则中间任何偏差都会毁掉文件。
  let text = st.patchedText ?? fs.readFileSync(st.abs, 'utf8');
  if (st.patchedText === undefined) {
    for (const op of st.ops) {
      if (countOccurrences(text, op.find) !== 1) throw new Error(st.rel + ': 锚点不唯一，已放弃（文件未改动）');
      text = text.replace(op.find, () => op.replace);
    }
  }
  backupFile(target, st.rel);
  fs.writeFileSync(st.abs, text, 'utf8');
  const err = nodeCheck(st.abs);
  if (err) {
    fs.copyFileSync(path.join(target, BACKUP_DIR, st.rel), st.abs);
    throw new Error(st.rel + ': 打完语法检查失败，已回滚：' + err);
  }
}

function createFiles(target) {
  const manifest = { created: [] };
  for (const [rel, content] of Object.entries(PATCHES.create ?? {})) {
    const abs = path.join(target, rel);
    const exists = fs.existsSync(abs);
    if (exists && fs.readFileSync(abs, 'utf8') === content) { log('  = ' + rel + ' 已是最新'); continue; }
    if (exists) {
      const backupRoot = path.join(target, BACKUP_DIR);
      const dest = path.join(backupRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) fs.copyFileSync(abs, dest);
      manifest.created.push(rel);
    } else {
      manifest.created.push(rel);
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    const err = nodeCheck(abs);
    if (err) throw new Error(rel + ': 新建文件语法检查失败：' + err);
    log('  + ' + rel + ' 已写入');
  }
  if (manifest.created.length) {
    const manifestPath = path.join(target, BACKUP_DIR, 'manifest.json');
    const m = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: [], created: [] };
    m.created = [...new Set([...(m.created ?? []), ...manifest.created])];
    m.patchedAt = new Date().toISOString();
    fs.mkdirSync(path.join(target, BACKUP_DIR), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n', 'utf8');
  }
}

function revertTarget(target) {
  const manifestPath = path.join(target, BACKUP_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) { warn('没有备份，跳过还原: ' + target); return; }
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const rel of m.files ?? []) {
    const src = path.join(target, BACKUP_DIR, rel);
    if (!fs.existsSync(src)) { warn('备份缺失: ' + rel); continue; }
    fs.copyFileSync(src, path.join(target, rel));
    log('  <- ' + rel + ' 已还原');
  }
  for (const rel of m.created ?? []) {
    const abs = path.join(target, rel);
    if (fs.existsSync(abs)) { fs.unlinkSync(abs); log('  x ' + rel + ' 已删除'); }
  }
  log('  备份保留在 ' + path.join(target, BACKUP_DIR) + '（确认无误后可手动删掉）');
}

function registerProfile(profileDir) {
  const pkgPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(pkgPath)) { warn('找不到 ' + pkgPath); return false; }
  const raw = fs.readFileSync(pkgPath, 'utf8');
  // 记事本等编辑器可能写入 UTF-8 BOM，JSON.parse 会因此报 Unexpected token
  const pkg = JSON.parse(raw.replace(/^\uFEFF/, ''));
  pkg.dependencies = pkg.dependencies ?? {};
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  let changed = false;
  const wantDep = 'link:' + PLUGIN_DIR.replace(/\\/g, '/');
  if (pkg.dependencies['qq-bot-pro'] !== wantDep) { pkg.dependencies['qq-bot-pro'] = wantDep; changed = true; }
  if (!bundles.includes('qq-bot-pro')) {
    const i = bundles.indexOf('@tencent-connect/dsh-qqbot');
    if (i === -1) bundles.push('qq-bot-pro'); else bundles.splice(i + 1, 0, 'qq-bot-pro');
    changed = true;
  }
  pkg.dsh.profile.bundles = bundles;
  if (changed) {
    fs.writeFileSync(pkgPath + '.qq-bot-pro.bak', raw, 'utf8');
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    log('  * ' + pkgPath + ' 已登记 qq-bot-pro（原文件备份为 package.json.qq-bot-pro.bak）');
  } else {
    log('  = ' + pkgPath + ' 已包含 qq-bot-pro');
  }
  const linkPath = path.join(profileDir, 'node_modules', 'qq-bot-pro');
  if (!fs.existsSync(linkPath)) {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    try {
      fs.symlinkSync(PLUGIN_DIR, linkPath, 'junction');
      log('  + 已创建 node_modules/qq-bot-pro -> ' + PLUGIN_DIR);
    } catch (e) {
      warn('创建软链接失败（' + e.message + '），请在该 profile 里运行 pnpm install');
    }
  }
  return true;
}

function report(target, rows) {
  const pkg = readPkg(target);
  log('');
  log('目标: ' + target);
  log('版本: ' + pkg.version + (pkg.version === PATCHES.baseVersion ? '' : '  (补丁基线 ' + PATCHES.baseVersion + ')'));
  for (const r of rows) log('  ' + r.state.padEnd(14) + ' ' + r.rel + (r.detail ? '  ' + r.detail : ''));
}

function patchTarget(target, opts) {
  let pkg;
  try { pkg = readPkg(target); } catch (e) { warn('不是有效的包目录: ' + target); return 1; }
  if (pkg.version !== PATCHES.baseVersion) {
    if (!opts.force) {
      warn(target + ' 版本是 ' + pkg.version + '，补丁基线是 ' + PATCHES.baseVersion + '；拒绝打补丁（确认要试可加 --force）');
      return 2;
    }
    warn('版本不符（' + pkg.version + '），按 --force 继续，锚点对不上会安全失败');
  }
  const rows = Object.keys(PATCHES.files).map((rel) => fileStatus(target, rel));
  if (opts.check) { report(target, rows); return rows.every((r) => r.state === 'patched') ? 0 : 2; }
  report(target, rows);
  let applied = 0;
  for (const st of rows) {
    if (st.state === 'patched') { log('  = ' + st.rel + ' 已打过补丁，跳过'); continue; }
    if (st.state !== 'patchable') { warn(st.rel + ' 状态 ' + st.state + (st.detail ? '（' + st.detail + '）' : '') + '，跳过'); continue; }
    try {
      applyToFile(target, st);
      applied++;
      log('  * ' + st.rel + ' 已打补丁');
    } catch (e) {
      warn(String(e.message || e));
    }
  }
  try { createFiles(target); } catch (e) { warn(String(e.message || e)); }
  log('');
  log(applied ? '完成：' + applied + ' 个文件已改动。重启 DSH（关闭再打开应用）后生效。' : '没有文件需要改动。');
  return applied ? 0 : 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }
  if (opts.register) {
    if (!opts.profile) { warn('--register 需要同时给 --profile <profile 目录>'); return 1; }
    return registerProfile(path.resolve(opts.profile)) ? 0 : 1;
  }
  const targets = discoverTargets(opts.targets);
  if (!targets.length) {
    warn('没找到 @tencent-connect/dsh-qqbot。请先用 --target 指定包目录，或用 --profile 登记插件后运行 pnpm install。');
    return 1;
  }
  let worst = 0;
  for (const t of targets) {
    if (opts.revert) {
      log('');
      log('还原: ' + t);
      revertTarget(t);
      continue;
    }
    worst = Math.max(worst, patchTarget(t, opts));
  }
  if (opts.check) log('\n--check 结束：' + (worst === 0 ? '全部已打补丁' : '存在未打补丁的文件'));
  return worst;
}

process.exitCode = main();
