#!/usr/bin/env node
// gen-patches.mjs — 维护者工具：把「npm 原版 dsh-qqbot」与「本机已打补丁的安装」做行级 diff，
// 生成 lib/patches.json（锚点 find/replace 补丁）。普通用户不需要运行它，直接用 lib/patch-host.mjs。
//
// 用法：
//   node lib/gen-patches.mjs --pristine <解压后的 0.5.3 package 目录> --live <已打补丁的包目录> [--out lib/patches.json]
//
// 取原版：
//   curl -LO https://registry.npmjs.org/@tencent-connect%2Fdsh-qqbot/-/dsh-qqbot-0.5.3.tgz
//   tar -xzf dsh-qqbot-0.5.3.tgz     # 得到 package/
//
// 算法要点（为什么不能直接给上下文就完事）：补丁段之间可能互相影响上下文，
// 所以每段的 find 必须从「已经应用过前面补丁的文本」里取；否则第二段会匹配失败或匹配到错位置。
// 每段都会扩张上下文直到 find 在文本里唯一；最后校验「应用结果 === 目标文件」逐字节相同。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = [
  'dist/gateway/bootstrap.js',
  'dist/gateway/middleware-setup.js',
  'dist/model/model-resolver.js',
  'dist/transport/inbound.js',
  'dist/index.js',
];
const CREATE = ['dist/gateway/spoke-tracker.js'];

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['-', a[i]]); i++; }
    else { out.push(['+', b[j]]); j++; }
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

export function makeOps(aLines, bLines, label = 'file') {
  const d = lcsDiff(aLines, bLines);
  const ops = [];
  let p = 0;
  let cur = aLines.slice();
  let i = 0;
  while (i < d.length) {
    if (d[i][0] === ' ') { p++; i++; continue; }
    const removed = [], added = [];
    while (i < d.length && d[i][0] !== ' ') {
      if (d[i][0] === '-') removed.push(d[i][1]); else added.push(d[i][1]);
      i++;
    }
    if (removed.length && cur.slice(p, p + removed.length).join('\n') !== removed.join('\n')) {
      throw new Error(label + ': removed block mismatch at line ' + p);
    }
    let op = null;
    for (let ctx = 1; ctx <= 40 && !op; ctx++) {
      const from = Math.max(0, p - ctx);
      const to = Math.min(cur.length, p + removed.length + ctx);
      const before = cur.slice(from, p);
      const after = cur.slice(p + removed.length, to);
      const find = [...before, ...removed, ...after].join('\n');
      if (!find) continue;
      const text = cur.join('\n');
      const at = text.indexOf(find);
      if (at === -1 || text.indexOf(find, at + 1) !== -1) continue;
      op = { find, replace: [...before, ...added, ...after].join('\n') };
    }
    if (!op) throw new Error(label + ': no unique anchor at line ' + p);
    ops.push(op);
    cur = cur.join('\n').replace(op.find, op.replace).split('\n');
    p += added.length;
  }
  return { ops, result: cur.join('\n') };
}

function main() {
  const pristine = arg('pristine');
  const live = arg('live');
  const out = arg('out', path.join(path.dirname(fileURLToPath(import.meta.url)), 'patches.json'));
  if (!pristine || !live) {
    console.error('用法: node lib/gen-patches.mjs --pristine <package目录> --live <已打补丁的包目录> [--out lib/patches.json]');
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(live, 'package.json'), 'utf8'));
  const spec = { baseVersion: pkg.version, files: {}, create: {} };
  for (const f of FILES) {
    const pt = fs.readFileSync(path.join(pristine, f), 'utf8');
    const lt = fs.readFileSync(path.join(live, f), 'utf8');
    const { ops, result } = makeOps(pt.split('\n'), lt.split('\n'), f);
    if (result !== lt) throw new Error('round-trip 失败: ' + f);
    spec.files[f] = ops;
    console.log(f + ' ops=' + ops.length);
  }
  for (const f of CREATE) {
    const p = path.join(live, f);
    if (fs.existsSync(p)) spec.create[f] = fs.readFileSync(p, 'utf8');
  }
  fs.writeFileSync(out, JSON.stringify(spec, null, 1) + '\n', 'utf8');
  console.log('written ' + out + ' (' + fs.statSync(out).size + 'B)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
