#!/usr/bin/env node
// doctor.mjs — one-shot preflight for agent-dev-team installs and day-to-day
// health checks. Pure Node (no new dependencies). Runs against the CURRENT
// working directory's repo, so it can be used both here (dogfood, via
// `npm run doctor`) and in a repo you're about to install the loop into.
// Exit code: non-zero when any check fails (✗) — script-friendly.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { detectBase, resolvePi, sh } from '../templates/lib.mjs';

const ROOT = process.cwd();
const run = (cmd, opts = {}) => sh(cmd, { cwd: ROOT, ...opts });

// ── small helpers ──
function whichInPath(name) {
  for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const c = path.join(d, name);
    if (existsSync(c)) return c;
  }
  return null;
}

function parseVersion(s) {
  const m = String(s).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

const ge = (v, major, minor) => v.major > major || (v.major === major && v.minor >= minor);

const displayWidth = (s) => {
  let w = 0;
  for (const ch of String(s)) w += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1;
  return w;
};
const pad = (s, n) => { let out = String(s); while (displayWidth(out) < n) out += ' '; return out; };

// Review-model routing mirrors templates/pipeline.mjs: env wins, then .agent/config.json, then built-in default.
function loadConfig() {
  try { return JSON.parse(readFileSync(path.join(ROOT, '.agent/config.json'), 'utf8')); } catch { return {}; }
}
function reviewModel() {
  const cfg = loadConfig();
  return {
    provider: process.env.REVIEW_PROVIDER || cfg.review?.provider || 'zai-coding-cn',
    model: process.env.REVIEW_MODEL || cfg.review?.model || 'glm-5.3',
  };
}

// ── checks ──
const CHECKS = [
  {
    name: 'gh auth',
    run() {
      let out;
      try { out = run(['gh', 'auth', 'status']); }
      catch { return { status: 'fail', detail: 'gh 未登录或不可用', fix: '运行 `gh auth login` 并确保 scopes 含 repo + workflow' }; }
      const account = (out.match(/account\s+(\S+)/i) || [])[1] || 'unknown';
      const scopeMatch = out.match(/Token scopes:\s*([^\n]*)/i);
      const scopes = scopeMatch ? [...scopeMatch[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
      const missing = ['repo', 'workflow'].filter(s => !scopes.includes(s));
      if (missing.length === 0) return { status: 'pass', detail: `已登录 ${account}；scopes: ${scopes.join(', ')}` };
      return { status: 'warn', detail: `已登录 ${account}，但缺 scopes: ${missing.join(', ')}`, fix: '运行 `gh auth refresh -s repo,workflow`' };
    },
  },
  {
    name: 'gh repo',
    run() {
      try {
        const out = run(['gh', 'repo', 'view', '--json', 'nameWithOwner']);
        const data = JSON.parse(out);
        if (data?.nameWithOwner) return { status: 'pass', detail: data.nameWithOwner };
        return { status: 'fail', detail: 'gh repo view 未返回 nameWithOwner', fix: '确认当前目录是 GitHub 仓库且 remote 已配置' };
      } catch {
        return { status: 'fail', detail: '无法解析当前仓库', fix: '确认当前目录是 GitHub 仓库、`git remote -v` 已关联、gh 已登录' };
      }
    },
  },
  {
    name: 'pi',
    run() {
      const bin = resolvePi();
      if (bin.includes('node_modules')) {
        return { status: 'fail', detail: `pi 命中的路径含 node_modules: ${bin}`, fix: '清除 node_modules 里的同名 pi 或设置 PI_BIN 指向真实 pi（lessons #1）' };
      }
      let out;
      try { out = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim(); }
      catch { return { status: 'fail', detail: `pi 不可执行: ${bin}`, fix: '安装 pi (>= 0.85) 并确保在 PATH（npm 语境请用 PI_BIN 显式指定）' }; }
      const v = parseVersion(out);
      if (!v) return { status: 'fail', detail: `无法解析 pi 版本: ${out}`, fix: '确认 `pi --version` 能正常输出版本号' };
      if (!ge(v, 0, 85)) return { status: 'fail', detail: `pi 版本过低: ${out}（需要 >= 0.85）`, fix: '升级 pi（`pi self-update` 或重新安装）' };
      return { status: 'pass', detail: `${out} @ ${bin}` };
    },
  },
  {
    name: 'tmux',
    run() {
      const p = whichInPath('tmux');
      if (p) return { status: 'pass', detail: p };
      return { status: 'fail', detail: 'tmux 不存在', fix: '安装 tmux（`apt install tmux` / `brew install tmux`）' };
    },
  },
  {
    name: 'node',
    run() {
      let out;
      try { out = execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(); }
      catch { return { status: 'fail', detail: 'node 不可执行', fix: '安装 Node.js (>= 18)' }; }
      const v = parseVersion(out);
      if (!v) return { status: 'fail', detail: `无法解析 node 版本: ${out}`, fix: '确认 `node --version` 正常输出' };
      if (v.major < 18) return { status: 'fail', detail: `node ${out}（需要 >= 18）`, fix: '升级 Node.js 到 18+' };
      return { status: 'pass', detail: `${out}（>= 18）` };
    },
  },
  {
    name: '默认分支',
    run() {
      const base = detectBase(ROOT);
      let ok = false;
      try { ok = !!run(['git', 'rev-parse', '--verify', `origin/${base}`]); } catch { ok = false; }
      if (ok) return { status: 'pass', detail: `${base}（origin/${base} 存在）` };
      return { status: 'fail', detail: `detectBase() 判定为 ${base}，但 origin/${base} 不存在`, fix: '`git fetch origin`；或 `git remote set-head origin -a`；或设置 AGENT_BASE' };
    },
  },
  {
    name: 'build/test',
    run() {
      const p = path.join(ROOT, 'package.json');
      if (!existsSync(p)) return { status: 'fail', detail: 'package.json 不存在', fix: '创建 package.json 并定义 build/test scripts' };
      let pkg;
      try { pkg = JSON.parse(readFileSync(p, 'utf8')); } catch { return { status: 'fail', detail: 'package.json 无法解析', fix: '修复 package.json 的 JSON 语法' }; }
      const missing = ['build', 'test'].filter(k => !(pkg.scripts || {})[k]);
      if (missing.length) return { status: 'fail', detail: `缺少 scripts: ${missing.join(', ')}`, fix: '在 package.json scripts 中添加 build 与 test（Agent C 依赖）' };
      return { status: 'pass', detail: 'build + test 均存在' };
    },
  },
  {
    name: '.gitignore',
    run() {
      const p = path.join(ROOT, '.gitignore');
      if (!existsSync(p)) return { status: 'fail', detail: '.gitignore 不存在', fix: '创建 .gitignore 并写入 templates/gitignore.snippet 的规则' };
      const txt = readFileSync(p, 'utf8');
      const required = ['.agent/state.json', '.agent/logs/', '.agent/tmp/', '.agent/**/*.log'];
      const missing = required.filter(r => !txt.includes(r));
      if (missing.length) return { status: 'fail', detail: `缺少忽略规则: ${missing.join(', ')}`, fix: '把 templates/gitignore.snippet 里的运行时规则写全（lessons #9）' };
      return { status: 'pass', detail: '包含全部必需运行时忽略规则' };
    },
  },
  {
    name: '模型可用性',
    run() {
      const rv = reviewModel();
      const name = `${rv.provider}/${rv.model}`;
      const bin = resolvePi();
      try {
        const out = execFileSync(bin, ['-p', '--mode', 'text',
          '--provider', rv.provider, '--model', rv.model,
          '--no-session', '--no-tools', '--no-approve', '--thinking', 'off',
          'Reply with exactly: OK'],
          { cwd: ROOT, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        if (!out) return { status: 'fail', detail: `${name} 探针返回空输出`, fix: '确认 REVIEW_MODEL 有效且账户可用（lessons #2）' };
        return { status: 'pass', detail: `${name} 探针成功（返回 "${out.slice(0, 40)}"）` };
      } catch (e) {
        const err = String((e.stderr || e.stdout || e.message) || '').trim();
        const brief = err.replace(/\s+/g, ' ').slice(0, 160);
        const quota = /\b429\b|insufficient|balance|quota|无可用资源|余额不足|欠费|rate.?limit|too many requests|capacity|overload/i.test(err);
        if (quota) {
          return { status: 'fail', detail: `${name} 额度/限流探测失败：${brief}`, fix: '为账户充值，或设置 REVIEW_PROVIDER / REVIEW_MODEL 指向可用模型（也可配置 reviewFallback 兜底）' };
        }
        return { status: 'fail', detail: `${name} 探测失败：${brief}`, fix: '确认 REVIEW_PROVIDER / REVIEW_MODEL 指向有效模型且已登录（`pi auth check --provider <x>` 显示 ready）' };
      }
    },
  },
  {
    name: 'config.json',
    run() {
      const p = path.join(ROOT, '.agent/config.json');
      if (!existsSync(p)) return { status: 'fail', detail: '.agent/config.json 不存在', fix: '从 templates/config.json 复制并填写 upstream / feedbackOptIn' };
      let cfg;
      try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch { return { status: 'fail', detail: '.agent/config.json 无法解析', fix: '修复 .agent/config.json 的 JSON 语法' }; }
      const fb = cfg.feedbackOptIn === true ? 'true（已开启自我提升反馈）' : cfg.feedbackOptIn === false ? 'false（已关闭）' : '未设置';
      return { status: 'pass', detail: `feedbackOptIn=${fb}` };
    },
  },
  {
    name: 'labels',
    run() {
      let out;
      try { out = run(['gh', 'label', 'list', '--json', 'name']); }
      catch { return { status: 'fail', detail: '无法查询远端 labels', fix: '确认 gh 已登录且仓库 remote 正确' }; }
      let names;
      try { names = new Set(JSON.parse(out).map(x => x.name)); }
      catch { return { status: 'fail', detail: '无法解析 label 列表', fix: '确认 gh label list 正常返回 JSON' }; }
      const required = ['agent-seen', 'agent-approved', 'agent-rejected'];
      const missing = required.filter(n => !names.has(n));
      if (missing.length) return { status: 'fail', detail: `缺少远端 labels: ${missing.join(', ')}`, fix: `创建缺失标签，例如 \`gh label create ${missing[0]}\`` };
      return { status: 'pass', detail: 'agent-seen / agent-approved / agent-rejected 均存在' };
    },
  },
];

// ── render + exit ──
const results = CHECKS.map((c) => {
  try { return { name: c.name, ...c.run() }; }
  catch (e) { return { name: c.name, status: 'fail', detail: `异常: ${e.message}`, fix: '见上方错误信息' }; }
});

let pass = 0, fail = 0, warn = 0;
for (const r of results) {
  if (r.status === 'pass') pass++;
  else if (r.status === 'warn') warn++;
  else fail++;
}

console.log('\n🔍 agent-dev-team doctor — 环境自检');
console.log('─'.repeat(80));
console.log('状态  检查项' + ' '.repeat(9) + '结果 / 修复建议');
console.log('─'.repeat(80));
for (const r of results) {
  const mark = r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : '✗';
  console.log(`${mark}     ${pad(r.name, 12)}  ${r.detail}`);
  if (r.status !== 'pass' && r.fix) console.log(`      ${' '.repeat(12)}  ↳ 修复: ${r.fix}`);
}
console.log('─'.repeat(80));
console.log(`结果：${pass} 项通过，${fail} 项失败，${warn} 项警告`);
if (fail > 0) console.log('❌ 有检查未通过，请先修复再继续安装/运行。');
else if (warn > 0) console.log('⚠ 必需项全部通过，但存在警告，建议处理后再继续。');
else console.log('✅ 全绿 — 可以继续。');

process.exit(fail > 0 ? 1 : 0);
