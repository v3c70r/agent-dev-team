#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════
//  Multi-agent loop — local orchestrator (v1)
//
//  Roles:
//    A implementer  — reads approved issue, implements, opens PR
//    B reviewer     — reviews PR diff, posts comments, discusses w/ A
//    C tester       — builds & runs the repo's build/test scripts, merges
//
//  Shared memory:  PR comments (GitHub) + .agent/logs/issue-<N>.md
//  Trigger:        issue labelled `agent-approved` by GitHub Actions triage
//
//  Usage:
//    node .agent/pipeline.mjs watch                 # loop until idle (Ctrl-C)
//    node .agent/pipeline.mjs watch --once          # one pass
//    node .agent/pipeline.mjs run --issue 42        # force-run one issue
//    node .agent/pipeline.mjs test --issue 42       # run test agent only
//    node .agent/pipeline.mjs status                # show state machine
//
//  Env:
//    MAX_REVIEW_ROUNDS (default 3)  MAX_TEST_FIXES (default 2)
//    TEST_SKIP=1                    skip functional tests (demo mode)
//    TEST_ENV_FILE=/abs/path/.env   env file to copy into test worktree
//    AGENT_BUILD_CMD / AGENT_TEST_CMD  Agent C's build/test commands
//                                   (default `npm run build` / `npm test`;
//                                    empty string = skip that step; non-npm
//                                    repos MUST set them, e.g. `make build`,
//                                    `pytest -q`)
// ══════════════════════════════════════════════════════════════════
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyMergeAttempt, detectBase, isRejectedIssue, MERGE_BLOCKED, MERGE_MERGED, mergeIssueState, prepareImplementerBranch, resolvePi, resolveTesterCommands, selectPendingIssues, sh } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = path.join(ROOT, '.agent');
const STATE_FILE = path.join(AGENT, 'state.json');
const LOG_DIR = path.join(AGENT, 'logs');
const TMP = path.join(AGENT, 'tmp');
const LABEL_APPROVED = 'agent-approved';
const BASE = detectBase();

// ── upstream feedback (self-improvement of the agent-dev-team skill) ──
// .agent/config.json: { "upstream": "<owner>/<repo>", "feedbackOptIn": true }

// ── issue dependencies ──
// Issues may declare prerequisites in their body, e.g.
//   "Depends on: #12, #13"  /  "Blocked by: #12"  /  "阻塞于 #12"
// The pipeline refuses to start such an issue while any prerequisite is open,
// so a freshly created batch with dependencies can be auto-approved safely.
function parseDependencies(body) {
  const m = String(body || '').match(/^\s*(?:Depends on|Blocked by|Depends|阻塞于|依赖于|依赖)\s*[:：]?\s*((?:#\d+[\s,，、]*)+)/im);
  if (!m) return [];
  return [...m[1].matchAll(/#(\d+)/g)].map(x => parseInt(x[1], 10));
}
function openDependencies(issue) {
  const deps = parseDependencies(issue && issue.body);
  if (!deps.length) return [];
  const open = [];
  for (const n of deps) {
    if (n === Number(issue.number)) continue;
    try {
      const st = ghJson(['issue', 'view', String(n), '--json', 'state,title']);
      if (st.state === 'OPEN') open.push({ number: n, title: st.title });
    } catch { /* unknown issue → treat as non-blocking */ }
  }
  return open;
}

function loadConfig() {
  try { return JSON.parse(readFileSync(path.join(AGENT, 'config.json'), 'utf8')); } catch { return {}; }
}
function reportGap(title, body) {
  const cfg = loadConfig();
  if (!cfg.feedbackOptIn || !cfg.upstream) return;
  try {
    // anti-spam: at most 3 feedback issues per rolling day
    const since = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const recent = ghJson(['issue', 'list', '-R', cfg.upstream, '--state', 'all',
      '--search', `[skill-feedback] created:>=${since}`, '--limit', '10', '--json', 'number']);
    if (recent.length >= 3) { console.warn('[feedback] daily cap reached, skip'); return; }
    const full = `${body}\n\n---\n_自动反馈来自 agent-dev-team 流水线（opt-in）。不应包含用户代码；如包含请维护者删除。 ${new Date().toISOString()}_`;
    try {
      gh(['issue', 'create', '-R', cfg.upstream, '--label', 'skill-feedback', '--title', `[skill-feedback] ${title}`, '--body', full]);
    } catch {
      // most users lack label rights upstream — retry without label
      gh(['issue', 'create', '-R', cfg.upstream, '--title', `[skill-feedback] ${title}`, '--body', full]);
    }
    console.warn(`[feedback] filed upstream: [skill-feedback] ${title}`);
  } catch (e) { console.warn('[feedback] failed:', e.message); }
}

// ── tiny helpers ──
// ── reviewer identity (optional separate GitHub account) ──
// .agent/config.json: { "reviewerGhUser": "qgu-reviewer" }  (env reviewerGhUser() wins)
// Purpose: Agent B (and its批准 review) should act as a *different* account than
// the implementer, so the approval is a genuine second identity instead of the
// "cannot approve your own PR" workaround (docs/lessons.md #4).
// NEVER use `gh auth switch` here: it rewrites the global gh config and races with
// the other pipelines/sessions calling gh on the same machine (lesson #23).
// Pass a per-process GH_TOKEN instead.
// 注意：CFG_JSON 在本文件靠后处才初始化（`const CFG_JSON = loadConfig()`），
// 所以这里**不能**在模块顶层读它 —— 会触发 TDZ（ReferenceError: Cannot access
// 'CFG_JSON' before initialization），watcher 直接起不来（2026-10-17 实测事故）。
// 改成惰性读取：第一次调用时才解析配置。
let _reviewerGhUser;
function reviewerGhUser() {
  if (_reviewerGhUser === undefined) {
    _reviewerGhUser = String(process.env.REVIEWER_GH_USER || CFG_JSON.reviewerGhUser || '').trim();
  }
  return _reviewerGhUser;
}
let _reviewerEnvCache;
function reviewerEnv() {
  if (!reviewerGhUser()) return {};
  if (_reviewerEnvCache !== undefined) return _reviewerEnvCache;
  try {
    const tok = sh(['gh', 'auth', 'token', '--user', reviewerGhUser()]).trim();
    _reviewerEnvCache = tok ? { ...process.env, GH_TOKEN: tok } : {};
    if (!tok) console.warn(`[reviewer] ${reviewerGhUser()} 无可用 token，回退到当前 gh 账号`);
  } catch (e) {
    console.warn(`[reviewer] 无法获取 ${reviewerGhUser()} 的 token（${e.message}），回退到当前 gh 账号`);
    _reviewerEnvCache = {};
  }
  return _reviewerEnvCache;
}
/** 该 reviewer 账号是否有写权限（决定其批准能否计入 branch protection 的 required reviews） */
function reviewerCanCountApproval() {
  if (!reviewerGhUser()) return null;
  try {
    const nwo = ghJson(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
    const out = sh(['gh', 'api', `repos/${nwo}`, '--jq', '.permissions.push'], { env: reviewerEnv() }).trim();
    return out === 'true';
  } catch { return null; }
}

function ghJson(args) { return JSON.parse(gh(args)); }
function gh(args, opts = {}) {
  return sh(['gh', ...args], opts);
}
const state = {
  load() {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return {};
  },
  save(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); },
};
function log(issueNum, msg) {
  mkdirSync(LOG_DIR, { recursive: true });
  const f = path.join(LOG_DIR, `issue-${issueNum}.md`);
  writeFileSync(f, (existsSync(f) ? readFileSync(f, 'utf8') : '') + `\n[${new Date().toISOString()}] ${msg}\n`);
}
// ── 下发前置防线：任何 GitHub 正文在发出前扫描令牌特征 ──
// 2026-10-16 真实事故：评论正文里的 `$(gh auth token --user <owner>)` 被 shell
// 展开成**真令牌**并贴进 PR 评论 → GitHub 秘密扫描自动吊销 → 全链路 401，
// 流水线卡死。提示词里写了禁令也可能被绕过，所以必须在**代码层**硬拦：
// 一旦命中特征就拒绝发送（throw），宁可不发评论也不泄漏凭据（lessons #26）。
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,        // GitHub OAuth / PAT / user / server token
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,      // fine-grained PAT
  /\bglpat-[A-Za-z0-9_-]{16,}\b/,          // GitLab
  /\bsk-[A-Za-z0-9_-]{16,}\b/,             // OpenAI-style secret key
  /\bAKIA[0-9A-Z]{16}\b/,                  // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,      // Slack
];
function assertNoSecrets(text, where = 'GitHub 正文') {
  const str = String(text ?? '');
  for (const re of SECRET_PATTERNS) {
    const m = str.match(re);
    if (m) {
      // 报错里只暴露前 6 位，避免把泄漏内容再写进日志/工单
      throw new Error(
        `拒绝发送 ${where}：正文中含疑似凭据（${m[0].slice(0, 6)}…，len=${m[0].length}）。` +
        '这是硬拦截，请移除凭据后重试（docs/lessons.md #26）');
    }
  }
  return str;
}
function commentOnIssue(num, body) { gh(['issue', 'comment', String(num), '--body', assertNoSecrets(body, `issue #${num} 评论`)]); }
function commentOnPr(num, body) { gh(['pr', 'comment', String(num), '--body', assertNoSecrets(body, `PR #${num} 评论`)]); }

// Get approved open issues that have no terminal state
function approvedIssues() {
  const out = gh(['issue', 'list', '--state', 'open', `--label=${LABEL_APPROVED}`, '--json', 'number,title,body,labels']);
  return JSON.parse(out);
}
function prForBranch(branch) {
  try {
    const out = gh(['pr', 'list', '--state', 'open', '--head', branch, '--json', 'number,headRefName,title']);
    const prs = JSON.parse(out);
    return prs[0] || null;
  } catch { return null; }
}
function openPrFor(issueNum, branch) {
  if (branch) { const p = prForBranch(branch); if (p) return p; }
  try {
    const out = gh(['pr', 'list', '--state', 'open', `--search`, `"#${issueNum}" in:body`, '--json', 'number,headRefName,title']);
    const prs = JSON.parse(out);
    return prs.find(p => p.title && p.title !== '') || null;
  } catch { return null; }
}

// ── Role A: implementer ──
async function runImplementer(issue, roundNote = '') {
  const s = state.load();
  const branch = `agent/${issue.number}`;
  const prompt = buildPrompt('implementer', { issue, branch, roundNote });
  // Fix rounds MUST continue on the PR's existing branch; only the first round
  // branches off base. `git checkout -B` on an existing branch would reset it
  // back to base (lesson #19), so branch prep lives in a tested helper.
  const { reused } = prepareImplementerBranch({ branch, base: BASE });
  log(issue.number, `A: 开始实现 (branch=${branch}, ${reused ? `修复轮：基于 PR 现有分支 origin/${branch}` : `首轮：基于 origin/${BASE}`}, model=${describeModel(IMPL)}) ${roundNote ? '——' + roundNote : ''}`);
  const out = runPi(`agent-issue-${issue.number}`, prompt, branch, IMPL);
  log(issue.number, `A: pi 输出（尾）:\n${out.split('\n').slice(-40).join('\n')}`);

  sh(['git', 'add', '-A']);
  try { sh(['git', 'commit', '-m', `Agent A: ${issue.title} (Closes #${issue.number}) [agent]`, '--allow-empty']); } catch {}
  sh(['git', 'push', '-u', 'origin', branch]);

  // ensure PR exists (query by branch — search index lags after create)
  let pr = prForBranch(branch);
  if (!pr) {
    const body = [
      `Closes #${issue.number}`,
      '',
      `🤖 Agent A (自动实现) — 来自 approved issue #${issue.number}.`,
      `标题: ${issue.title}`,
    ].join('\n');
    gh(['pr', 'create', '--base', BASE, '--head', branch, '--title', `Agent: ${issue.title}`, '--body', assertNoSecrets(body, 'PR 正文')]);
    for (let i = 0; i < 5 && !pr; i++) {
      await new Promise(r => setTimeout(r, 2000));
      pr = prForBranch(branch);
    }
  }
  if (pr) {
    commentOnPr(pr.number, `🤖 **Agent A 完成实现**（${describeModel(IMPL)}），等待 Agent B review（${describeModel(REVIEW)}）。`);
    // merge, never replace — `round`/`fixes` recorded by earlier rounds must survive
    s[issue.number] = mergeIssueState(s[issue.number], { status: 'pr_open', pr: pr.number, branch, title: issue.title });
  } else {
    s[issue.number] = mergeIssueState(s[issue.number], { status: 'pr_open', pr: null, branch, title: issue.title });
    log(issue.number, 'PR 尚未可查，稍后按分支重查');
  }
  state.save(s);
  return pr;
}

// ── Role B: reviewer (round-trip discussion with A) ──

/**
 * Parse the reviewer's verdict robustly.
 * The reviewer is asked for an English `RESULT: APPROVE|REQUEST_CHANGES` sentinel,
 * but models (e.g. GLM) sometimes answer in Chinese — "批准/通过" vs "要求修改" —
 * which previously defaulted to REQUEST_CHANGES and burned all review rounds.
 * We therefore scan for both languages and trust the LAST signal in the output.
 */
function parseReviewVerdict(out) {
  const text = String(out || '');
  const approve = /(RESULT:\s*APPROVE\b|LGTM\b|批准|予以批准|通过)/gi;
  const changes = /(RESULT:\s*REQUEST_CHANGES\b|REQUEST_CHANGES\b|要求修改|需要修改|需要更改|建议修改|不予批准|未批准|不批准|不通过)/gi;
  const last = (re) => { let m, i = -1; while ((m = re.exec(text)) !== null) i = m.index + m[0].length; return i; };
  const la = last(approve);
  const lc = last(changes);
  const sentinel = /RESULT:\s*(APPROVE|REQUEST_CHANGES)/i.test(text);
  if (la === -1 && lc === -1) return { verdict: 'REQUEST_CHANGES', source: 'no-signal' };
  if (la > lc) return { verdict: 'APPROVE', source: sentinel ? 'sentinel' : 'heuristic' };
  return { verdict: 'REQUEST_CHANGES', source: sentinel ? 'sentinel' : 'heuristic' };
}

// Model outages (billing/quota/rate-limit) must not dead-end the loop:
// fall back to another model for this round, leave a paper trail, and report
// the gap upstream (opt-in). Discovered live when the review model ran out of credit.
function isModelUnavailable(err) {
  const s = String((err && (err.stderr || err.stdout || err.message)) || '');
  return /\b429\b|insufficient|balance|quota|无可用资源|余额不足|欠费|rate.?limit|too many requests|capacity|overload/i.test(s);
}

async function runReviewRound(issueNum, prNum) {
  const prompt = buildPrompt('reviewer', { issue: { number: issueNum }, pr: prNum });
  let out;
  try {
    out = runPi(`agent-review-${prNum}`, prompt, null, REVIEW, reviewerEnv());
  } catch (err) {
    if (!isModelUnavailable(err)) throw err;
    const fallback = REVIEW_FALLBACK;
    const detail = String((err.stderr || err.message || '')).slice(0, 300);
    console.warn(`[review] ${describeModel(REVIEW)} unavailable → fallback ${describeModel(fallback)}: ${detail}`);
    log(issueNum, `B: 模型不可用（${describeModel(REVIEW)}）→ 回退到 ${describeModel(fallback)}`);
    try { commentOnPr(prNum, `⚠️ **审查模型不可用**（\`${describeModel(REVIEW)}\`）：\`${detail.replace(/\n/g, ' ')}\`\n\n已自动回退到 \`${describeModel(fallback)}\` 完成本轮审查（不影响合并）。\n长期方案：为账户充值，或设置 \`REVIEW_PROVIDER\`/\`REVIEW_MODEL\` 指向可用模型。`); } catch {}
    reportGap(`审查模型不可用（${describeModel(REVIEW)}）`, `## 现象\n审查轮次调用模型失败，错误被判定为额度/限流类。\n\n## 模型\n- 主: ${describeModel(REVIEW)}\n- 回退: ${describeModel(fallback)}\n\n## 错误\n\`\`\`\n${detail}\n\`\`\`\n\n## 建议\n模板已自动回退；可考虑在 doctor 中预检模型额度（\`pi auth check\` 不检测余额），或支持多模型候选列表。`);
    out = runPi(`agent-review-${prNum}`, prompt, null, fallback, reviewerEnv());
  }
  const { verdict, source } = parseReviewVerdict(out);
  log(issueNum, `B: verdict=${verdict} (${source}, model=${describeModel(REVIEW)})`);
  log(issueNum, `B: review 输出:\n${out.split('\n').slice(-30).join('\n')}`);
  return { verdict, out, source };
}

// ── Role C: tester (functional tests) ──

/** Human-readable report of which commands Agent C will actually run. */
function describeTesterCommands(cmds) {
  const line = (label, v, key) => (v ? `- ${label}: \`${v}\`` : `- ${label}: 已跳过（\`${key}\` 为空）`);
  return [line('build', cmds.build, 'AGENT_BUILD_CMD'), line('test', cmds.test, 'AGENT_TEST_CMD')].join('\n');
}

function runTester(issueNum, prNum, branch) {
  log(issueNum, `C: 开始功能测试 on ${branch}`);
  // Commands are shell strings (so `pytest -q` / `make build` work) and are
  // reported verbatim in the PR comment — the claim must equal what ran (lesson #17).
  const cmds = resolveTesterCommands();
  const ran = describeTesterCommands(cmds);
  const nothingToRun = !cmds.build && !cmds.test;
  const wt = path.join(TMP, `wt-${issueNum}`);
  rmSync(wt, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  // Use a DETACHED worktree at the remote branch: the agent branch is often
  // still checked out in the main worktree, which makes `worktree add <branch>`
  // fail with "already used by worktree". Detaching avoids the conflict.
  try { sh(['git', 'fetch', 'origin', branch, '--quiet']); } catch {}
  let added = false;
  try {
    try {
      sh(['git', 'worktree', 'add', '--detach', wt, `origin/${branch}`]);
      added = true;
    } catch {
      sh(['git', 'worktree', 'add', '--detach', wt, branch]);
      added = true;
    }
    // reuse node_modules via symlink when the repo has them (vite/esbuild tolerate it).
    // Repos without dependencies (e.g. this template repo) simply skip this.
    const rootModules = path.join(ROOT, 'node_modules');
    if (existsSync(rootModules) && !existsSync(path.join(wt, 'node_modules'))) {
      symlinkSync(rootModules, path.join(wt, 'node_modules'), 'dir');
    }
    if (process.env.TEST_ENV_FILE && existsSync(process.env.TEST_ENV_FILE)) copyFileSync(process.env.TEST_ENV_FILE, path.join(wt, '.env'));
    if (cmds.build) sh(['bash', '-lc', cmds.build], { cwd: wt });
    const testOut = cmds.test ? sh(['bash', '-lc', cmds.test], { cwd: wt }) : '';
    const report = testOut.split('\n').slice(-60).join('\n');
    log(issueNum, `C: 测试通过 ✅（${ran}）\n${report}`);
    commentOnPr(prNum, `🤖 **Agent C 功能测试通过** ✅${nothingToRun ? '（未配置构建/测试命令，已跳过执行）' : '（构建 + 测试套件通过）'}\n\n实际执行：\n${ran}`);
    return { pass: true };
  } catch (e) {
    const report = (e.stdout || e.message || '').split('\n').slice(-60).join('\n');
    log(issueNum, `C: 测试失败 ❌\n${report}`);
    commentOnPr(prNum, `🤖 **Agent C 功能测试失败** ❌\n\n实际执行：\n${ran}\n\n\`\`\`\n${report.slice(0, 3000)}\n\`\`\``);
    return { pass: false };
  } finally {
    if (added) { try { sh(['git', 'worktree', 'remove', wt, '--force']); } catch {} }
    try { sh(['git', 'worktree', 'prune']); } catch {}
    rmSync(wt, { recursive: true, force: true });
  }
}

// ── shared pi invocation ──
// ── model routing per role ──
// Agent A (implementer) uses pi's default model unless IMPL_PROVIDER/IMPL_MODEL are set.
// Agent B (reviewer) uses a different model for an independent perspective.
// model routing: env wins, then .agent/config.json, then built-in defaults
const CFG_JSON = loadConfig();
const REVIEW = {
  provider: process.env.REVIEW_PROVIDER || CFG_JSON.review?.provider || 'zai-coding-cn',
  model: process.env.REVIEW_MODEL || CFG_JSON.review?.model || 'glm-5.3',
};
const REVIEW_FALLBACK = {
  provider: process.env.REVIEW_FALLBACK_PROVIDER || CFG_JSON.reviewFallback?.provider || '',
  model: process.env.REVIEW_FALLBACK_MODEL || CFG_JSON.reviewFallback?.model || '',
};
const IMPL = {
  provider: process.env.IMPL_PROVIDER || '',
  model: process.env.IMPL_MODEL || '',
};
function describeModel(m) { return m.provider && m.model ? `${m.provider}/${m.model}` : '(pi default)'; }

function runPi(sessionId, prompt, branchHint, model = {}, extraEnv = {}) {
  const cwdNote = branchHint ? `当前分支应为 agent 分支（已在本地 checkout）。` : '';
  const extra = prompt; // full system prompt already assembled by buildPrompt
  mkdirSync(TMP, { recursive: true });
  const pfile = path.join(TMP, `${sessionId}.prompt.md`);
  writeFileSync(pfile, extra);
  const args = ['-p', '--mode', 'text', '--session-id', sessionId,
    ...(model.provider ? ['--provider', model.provider] : []),
    ...(model.model ? ['--model', model.model] : []),
    '--system-prompt', `You are part of an autonomous agent loop operating on the GitHub repo (cwd). ${cwdNote} Follow the instructions below strictly.`,
    '--append-system-prompt', pfile,
    '--no-approve',
    // positional user message — pi needs an actual message to act on
    '现在执行上面给出的完整任务：读所需上下文，用工具完成所有步骤，然后输出总结并结束。'];
  try {
    const bin = resolvePi();
    return execFileSync(bin, args, { cwd: ROOT, encoding: 'utf8', timeout: 0, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv } });
  } catch (e) {
    // even on nonzero exit, capture stdout
    if (e.stdout) return e.stdout.toString();
    throw e;
  }
}

// ── prompt builders ──
function buildPrompt(role, ctx) {
  const file = path.join(AGENT, 'prompts', role + '.md');
  let base = readFileSync(file, 'utf8');
  if (role === 'implementer') {
    let issueInfo = ctx.issue.body || '(no body)';
    return `${base}\n\n# 本次任务\nIssue #${ctx.issue.number}: ${ctx.issue.title}\n\n## Issue 内容\n${issueInfo}\n\n分支: ${ctx.branch}\n${ctx.roundNote ? '\n## 上一轮要求\n' + ctx.roundNote : ''}`;
  }
  if (role === 'reviewer') {
    return `${base}\n\n# 本次任务\nReview PR #${ctx.pr} (对应 issue #${ctx.issue.number})。`;
  }
  return base;
}

// ── state machine per issue ──
async function processIssue(issue, force = false) {
  // remember where we started so we can restore the user's branch afterwards
  let startBranch = null;
  try { startBranch = sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD']); } catch {}
  try {
    return await processIssueInner(issue, force);
  } finally {
    if (startBranch && startBranch !== 'HEAD') {
      try { sh(['git', 'checkout', startBranch]); } catch { /* leave as-is */ }
    }
  }
}

async function processIssueInner(issue, force = false) {
  const s = state.load();
  // /reject 是硬性否决（issue #14）：标签驱动的取活只加否定标签不等于取消，
  // 必须把 agent-rejected 当作硬排除，并在实现/合并前落成终态 `rejected`。
  // 边界：若实现已在运行，本函数不会中断正在跑的 pi 会话（不在本 PR 范围），
  // 但下一轮不再接管，PR 也不会被自动合并（见 docs/lessons.md #20）。
  if (isRejectedIssue(issue) && !force) {
    s[issue.number] = mergeIssueState(s[issue.number], { status: 'rejected', title: issue.title });
    state.save(s);
    log(issue.number, '状态: rejected（issue 带 agent-rejected 标签，硬性跳过实现与合并）');
    return { skipped: 'rejected' };
  }
  const cur = s[issue.number];
  const terminal = ['merged', 'rejected', 'failed'];
  if (cur && terminal.includes(cur.status) && !force) return { skipped: cur.status };

  const branch = cur?.branch || `agent/${issue.number}`;
  let pr = prForBranch(branch) || openPrFor(issue.number, branch) || (cur?.pr ? { number: cur.pr } : null);

  // 0) DEPENDENCIES — never start work whose prerequisites are still open
  if (!pr) {
    // throttle dependency re-checks (the watcher ticks every 30s)
    const sT = state.load();
    const lastCheck = sT[issue.number]?.blockedCheckedAt ? Date.parse(sT[issue.number].blockedCheckedAt) : 0;
    const blockedFresh = sT[issue.number]?.status === 'blocked' && (Date.now() - lastCheck) < 5 * 60_000;
    if (blockedFresh) return { skipped: 'blocked' };
    const blockedBy = openDependencies(issue);
    if (blockedBy.length) {
      const list = blockedBy.map(d => `#${d.number} (${d.title})`).join(', ');
      log(issue.number, `blocked: 等待依赖 ${list}`);
      const sB = state.load();
      if (!sB[issue.number]) sB[issue.number] = {};
      const firstNotice = !sB[issue.number].blockedNotified;
      sB[issue.number].status = 'blocked';
      sB[issue.number].blockedBy = blockedBy.map(d => d.number);
      sB[issue.number].blockedCheckedAt = new Date().toISOString();
      if (firstNotice) sB[issue.number].blockedNotified = true;
      state.save(sB);
      if (firstNotice) {
        try { commentOnIssue(issue.number, `⏳ 该 issue 声明了依赖，暂不开始实现：等待 ${list} 关闭。\n\n依赖完成后流水线会自动接手（无需操作）。`); } catch {}
      }
      return { skipped: 'blocked' };
    }
  }

  // dependencies satisfied → clear the blocked marker
  if (state.load()[issue.number]?.status === 'blocked') {
    const sc = state.load();
    sc[issue.number].status = 'pr_open';
    delete sc[issue.number].blockedBy;
    delete sc[issue.number].blockedNotified;
    delete sc[issue.number].blockedCheckedAt;
    state.save(sc);
    try { commentOnIssue(issue.number, '✅ 依赖已满足，开始实现。'); } catch {}
  }

  // 1) IMPLEMENT
  if (!cur || (cur.status === 'pr_open' && (!pr || force))) {
    if (pr && !force && cur) {
      s[issue.number] = { ...cur, status: 'reviewing' };
      state.save(s);
    } else {
      pr = await runImplementer(issue);
      if (!pr) return { skipped: 'waiting_pr' };
    }
  }
  pr = prForBranch(branch) || openPrFor(issue.number, branch) || (cur?.pr ? { number: cur.pr } : null);
  if (!pr) return { skipped: 'waiting_pr' };

  // 2) REVIEW (loop with A) — skip if already approved (resume path)
  const maxRounds = parseInt(process.env.MAX_REVIEW_ROUNDS || '3', 10);
  let lastReviewOut = '';
  let lastReviewVerdict = 'n/a';
  let fresh = state.load();
  if (!fresh[issue.number]) fresh[issue.number] = {}; // ensure key exists
  if (fresh[issue.number].status !== 'approved') {
    for (let r = 0; r < maxRounds; r++) {
      fresh = state.load();
      if (!fresh[issue.number]) fresh[issue.number] = {};
      const res = await runReviewRound(issue.number, pr.number);
      lastReviewOut = res.out;
      lastReviewVerdict = res.verdict;
      if (res.verdict === 'APPROVE') { fresh[issue.number].status = 'approved'; state.save(fresh); break; }
      const note = `Agent B 要求修改（第 ${r + 1} 轮），请根据 PR #${pr.number} 上 Agent B 的评论修改。`;
      fresh[issue.number].status = 'reviewing';
      fresh[issue.number].round = r + 1;
      state.save(fresh);
      await runImplementer(issue, note);
      pr = prForBranch(branch) || pr;
    }
  }

  // 3) TEST
  const s2 = state.load();
  if (!s2[issue.number] || s2[issue.number].status !== 'approved') {
    // loop exhausted without approval → notify human (include the last verdict so a
    // human can immediately see whether the reviewer had actually approved)
    if (!s2[issue.number]) s2[issue.number] = {};
    const excerpt = String(lastReviewOut || '').split('\n').filter(Boolean).slice(-6).join('\n').slice(0, 900);
    commentOnIssue(issue.number, `⚠️ Agent B 与 Agent A 未能在 ${maxRounds} 轮内达成一致，请人工 review PR #${s2[issue.number]?.pr || pr.number}。\n\n` +
      `自动解析的最后一轮结论：\`${lastReviewVerdict}\`\n\n` +
      (excerpt ? `<details><summary>最后一轮 reviewer 输出（节选）</summary>\n\n\`\`\`\n${excerpt}\n\`\`\`\n</details>` : ''));
    s2[issue.number].status = 'needs_human';
    s2[issue.number].lastVerdict = lastReviewVerdict;
    state.save(s2);
    return { skipped: 'needs_human' };
  }

  if (process.env.TEST_SKIP === '1') {
    commentOnIssue(issue.number, `🧪 TEST_SKIP=1，跳过功能测试。`);
    return await finishMerge(issue.number, s2[issue.number].pr || pr.number);
  }

  const maxFixes = parseInt(process.env.MAX_TEST_FIXES || '2', 10);
  for (let f = 0; f <= maxFixes; f++) {
    const t = runTester(issue.number, s2[issue.number].pr || pr.number, s2[issue.number].branch);
    if (t.pass) {
      return await finishMerge(issue.number, s2[issue.number].pr || pr.number);
    }
    if (f === maxFixes) {
      commentOnIssue(issue.number, `❌ 功能测试在 ${maxFixes + 1} 次尝试后仍失败，PR 保持开放，请人工处理。`);
      s2[issue.number].status = 'failed';
      state.save(s2);
      return { skipped: 'failed' };
    }
    const note = `Agent C 功能测试失败。请修复后重新推送。失败信息见 PR #${s2[issue.number].pr || pr.number} 评论。`;
    // `round` counts review rounds, `fixes` counts test-driven fix rounds.
    // Save BEFORE runImplementer so its merge (mergeIssueState) reads the new value.
    s2[issue.number].fixes = (s2[issue.number].fixes || 0) + 1;
    state.save(s2);
    await runImplementer(issue, note);
  }
}

async function finishMerge(issueNum, prNum) {
  // 合并不可逆 —— 在真正 `gh pr merge` 之前重新取一次 issue 标签确认 /reject。
  // review + test 窗口长达数十分钟，正是用户最想反悔的时候；只在取活时检查
  // 无法覆盖"实现已经在跑"的 in-flight 路径（issue #14 明确承诺"PR 不会被
  // 自动合并"）。取不到标签 = 无法确认 → 失败关闭，绝不做不可逆动作。
  let freshIssue;
  try {
    freshIssue = ghJson(['issue', 'view', String(issueNum), '--json', 'labels']);
  } catch (e) {
    const sf = state.load();
    sf[issueNum] = mergeIssueState(sf[issueNum], { status: 'needs_human' });
    state.save(sf);
    log(issueNum, `状态: needs_human（合并前无法确认 /reject 标签: ${e.message}）`);
    try { commentOnIssue(issueNum, `⚠️ 合并前无法确认 /reject 状态（\`${e.message}\`），为安全起见未自动合并 PR #${prNum}，请人工处理。`); } catch {}
    return { skipped: 'needs_human' };
  }
  if (isRejectedIssue(freshIssue)) {
    const sr = state.load();
    sr[issueNum] = mergeIssueState(sr[issueNum], { status: 'rejected' });
    state.save(sr);
    log(issueNum, `状态: rejected（合并前检查到 /reject，已阻止自动合并 PR #${prNum}）`);
    try { commentOnIssue(issueNum, `🛑 合并前检测到 /reject，已**阻止自动合并** PR #${prNum}。该 PR 保持开放，等待人工处理。`); } catch {}
    return { skipped: 'rejected' };
  }
  // ── 批准：优先用独立 reviewer 账号提交**真实** approve review ──
  // （同一账号无法批准自己的 PR —— lessons #4；因此推荐配置第二个账号）
  const approveBody = `🤖 Agent B 已批准 + Agent C 测试通过${reviewerGhUser() ? `（批准账号：${reviewerGhUser()}）` : ''}`;
  let approvalNote = '';
  if (reviewerGhUser()) {
    try {
      gh(['pr', 'review', String(prNum), '--approve', '--body', approveBody], { env: reviewerEnv() });
      const counts = reviewerCanCountApproval();
      approvalNote = counts === true
        ? `批准由独立账号 **${reviewerGhUser()}** 提交（该账号有写权限，可计入分支保护的 required reviews）。`
        : counts === false
          ? `批准由独立账号 **${reviewerGhUser()}** 提交 —— 但该账号只有只读权限，**此批准不会计入分支保护的 required reviews**（需要硬门禁请给它 write 权限）。`
          : `批准由独立账号 **${reviewerGhUser()}** 提交。`;
    } catch (e) {
      console.warn('[reviewer] 独立账号批准失败，回退到当前账号：' + e.message);
      log(issueNum, `B: 独立账号 ${reviewerGhUser()} 批准失败（${e.message}），回退`);
    }
  }
  if (!approvalNote) {
    try {
      gh(['pr', 'review', String(prNum), '--approve', '--body', approveBody]);
      approvalNote = '批准由当前 gh 账号提交。';
    } catch (e) {
      commentOnPr(prNum, '🤖 Agent B 已批准（当前账号无法提交正式 approve review —— 通常因为它是该 PR 的作者；以本评论作为批准记录）+ Agent C 测试通过。');
      approvalNote = '当前账号与 PR 作者相同，批准以**评论**记录（建议配置独立 reviewer 账号，见 SKILL.md）。';
    }
  }
  // ── 合并前：detached HEAD 兜底 ──
  // `gh pr merge --delete-branch` = 先合并、再删本地与远程分支；删本地分支需要
  // 「当前分支」，detached HEAD 时会抛 `not on any branch`（**合并在前、报错在后**）。
  // 先切回 BASE 让收尾步骤有分支可用（best-effort：失败仅 warn，不影响合并本身）。
  try {
    const cur = sh(['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
    if (cur === 'HEAD') {
      try { sh(['git', 'checkout', BASE]); }
      catch (e) {
        console.warn('checkout BASE before merge failed (continuing):', e.message);
        log(issueNum, `合并前切回 ${BASE} 失败（${e.message}），继续尝试合并`);
      }
    }
  } catch (e) { console.warn('detached-HEAD probe failed (continuing):', e.message); }

  // ── 合并：无论退出码如何，都不把它当作结果 ──
  let mergeErr = null;
  try {
    gh(['pr', 'merge', String(prNum), '--squash', '--delete-branch']);
  } catch (e) {
    mergeErr = e;
    console.warn('merge command failed (will verify real state):', e.message);
  }

  // ── 读回 PR 的真实状态（不可逆动作只认读回状态，issue #16）──
  // 读回失败 → pr 传 null → classifyMergeAttempt 判 unknown（fail-closed）。
  let prState = null;
  try {
    prState = ghJson(['pr', 'view', String(prNum), '--json', 'state,mergedAt,headRefName']);
  } catch (e) {
    console.warn('pr view readback failed:', e.message);
    prState = null;
  }
  const outcome = classifyMergeAttempt({ error: mergeErr?.message, pr: prState });

  if (outcome === MERGE_MERGED) {
    // 已合并（即便上面 gh 报了错）。尽力清理 `--delete-branch` 漏删的远程分支：
    // 仅 warn，绝不因此改变合并结果。
    const headBranch = prState?.headRefName;
    if (headBranch) {
      try {
        if (sh(['git', 'ls-remote', '--heads', 'origin', headBranch])) {
          try {
            gh(['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${headBranch}`]);
            log(issueNum, `已清理残留远程分支 ${headBranch}`);
          } catch (e) {
            console.warn('remote branch cleanup failed:', e.message);
            log(issueNum, `远程分支 ${headBranch} 清理失败（${e.message}）—— 不影响合并结果`);
          }
        }
      } catch (e) { console.warn('ls-remote failed:', e.message); }
    }
    const s = state.load();
    s[issueNum] = mergeIssueState(s[issueNum], { status: 'merged' });
    state.save(s);
    const errNote = mergeErr
      ? `\n\n> ⚠️ \`gh pr merge\` 退出码非零（\`${mergeErr.message}\`），但读回 PR 状态确认已合并 —— **以真实状态为准**。`
      : '';
    commentOnIssue(issueNum, `🎉 已合并 (PR #${prNum})。issue 将被自动关闭。\n\n${approvalNote}${errNote}`);
    log(issueNum, `状态: merged${mergeErr ? '（尽管 gh pr merge 报错，读回状态为已合并）' : ''}`);
    return { merged: true };
  }

  const sf = state.load();
  sf[issueNum] = mergeIssueState(sf[issueNum], { status: 'needs_human' });
  state.save(sf);
  if (outcome === MERGE_BLOCKED) {
    // 确认未合并：保留原错误文案，但明确「读回确认未合并」
    commentOnIssue(issueNum, `❌ 自动合并失败（读回状态确认 PR #${prNum} **未合并**${mergeErr ? `：${mergeErr.message}` : ''}，可能受分支保护限制）。请手动合并 PR #${prNum}。`);
    log(issueNum, '状态: needs_human (merge blocked)');
  } else {
    // unknown：读不到真实状态 → fail-closed，交人工确认（不再假装“已知失败”）
    commentOnIssue(issueNum, `⚠️ 无法确认 PR #${prNum} 的合并结果，已按未合并处理，请人工确认${mergeErr ? `（\`gh pr merge\` 报错：${mergeErr.message}）` : ''}。`);
    log(issueNum, '状态: needs_human (merge result unknown)');
  }
  return { skipped: 'needs_human' };
}

// ── CLI ──
async function main() {
  const cmd = process.argv[2] || 'watch';
  const once = process.argv.includes('--once');
  mkdirSync(LOG_DIR, { recursive: true });

  if (cmd === 'feedback') {
    // manual gap report: node .agent/pipeline.mjs feedback "<title>" [body]
    const cfg = loadConfig();
    if (!cfg.upstream) { console.error('no upstream configured in .agent/config.json'); process.exit(2); }
    if (!cfg.feedbackOptIn && !process.argv.includes('--force')) {
      console.error('feedbackOptIn=false（如需强制上报加 --force）'); process.exit(2);
    }
    const title = process.argv[3] || 'manual gap report';
    const body = process.argv[4] || '(no details provided)';
    reportGap(title, body);
    console.log('feedback submitted (or attempted) — see warnings above');
    return;
  }

  if (cmd === 'status') {
    console.log(JSON.stringify(state.load(), null, 2));
    return;
  }

  if (cmd === 'run') {
    const i = process.argv.indexOf('--issue');
    const force = process.argv.includes('--force');
    const issueNum = i >= 0 ? process.argv[i + 1] : null;
    const list = issueNum ? [{ number: issueNum, title: '', body: '' }] : approvedIssues();
    for (const issue of list) {
      const full = issueNum
        ? (await gh(['issue', 'view', String(issueNum), '--json', 'number,title,body,labels']))
        : issue;
      await processIssue(typeof full === 'string' ? JSON.parse(full) : full, force);
    }
    return;
  }

  if (cmd === 'review') {
    // Review-only: useful for testing the reviewer model or a manual re-review.
    //   node .agent/pipeline.mjs review --pr 12 [--issue 7]
    const pi = process.argv.indexOf('--pr');
    const prNum = pi >= 0 ? process.argv[pi + 1] : null;
    if (!prNum) { console.error('usage: pipeline.mjs review --pr <number> [--issue <number>]'); process.exit(2); }
    const ii = process.argv.indexOf('--issue');
    const issueNum = ii >= 0 ? process.argv[ii + 1] : 'unknown';
    console.log(`reviewing PR #${prNum} with ${describeModel(REVIEW)}`);
    const { verdict, out } = await runReviewRound(issueNum, prNum);
    console.log(`\nVERDICT: ${verdict}\n`);
    console.log(out.split('\n').slice(-20).join('\n'));
    return;
  }

  if (cmd === 'test') {
    const i = process.argv.indexOf('--issue');
    const issueNum = process.argv[i + 1];
    const s = state.load();
    const pr = openPrFor(issueNum) || { number: s[issueNum]?.pr };
    const t = runTester(issueNum, pr.number, s[issueNum].branch);
    console.log(t.pass ? 'PASS' : 'FAIL');
    return;
  }

  // watch loop — designed to stay alive in tmux; only Ctrl-C / `--once` stops it
  console.log('👀 agent pipeline watch — Ctrl-C 退出（tmux 中可常驻）');
  const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  let pollFailures = 0;
  for (;;) {
    try {
      const issues = approvedIssues();
      const s = state.load();
      // 否决优先 + 终态排除（可测试的纯函数；见 templates/lib.mjs）
      const pending = selectPendingIssues(issues, s);
      if (pending.length === 0) {
        console.log(`[${ts()}] 💤 idle — 等待新的 agent-approved issue …`);
        pollFailures = 0;
        if (once) return;
        await new Promise(r => setTimeout(r, 30_000));
        continue;
      }
      for (const issue of pending) {
        console.log(`[${ts()}] ▶ 处理 issue #${issue.number}: ${issue.title}`);
        try {
          await processIssue(issue);
          console.log(`[${ts()}] ✔ issue #${issue.number} 本轮结束`);
        } catch (err) {
          // one bad issue must NOT kill the long-running watcher
          console.error(`[${ts()}] ✖ issue #${issue.number} 处理失败，循环继续：${err.message}`);
          log(issue.number, `循环捕获异常（不退出）:\n${err.stack || err.message}`);
          const sf = state.load();
          if (!sf[issue.number]) sf[issue.number] = {};
          sf[issue.number].status = 'needs_human';
          sf[issue.number].error = String(err.message);
          state.save(sf);
          try { commentOnIssue(issue.number, `⚠️ 处理该 issue 时出错，已交给人工：\`${err.message}\``); } catch {}
          // self-improvement: unexpected pipeline errors are exactly the gaps
          // the skill wants to learn about (opt-in, sanitized, rate-limited)
          reportGap(`流水线异常: ${String(err.message).slice(0, 120)}`,
            `## 现象\n处理 issue 时流水线抛出未预期异常。\n\n## 详情\n\
\`\`\`\n${String(err.stack || err.message).slice(0, 1500)}\n\
\`\`\`\n\n## 环坑提示\n如果这是模板本身的问题（而非用户仓库环境问题），请改进 agent-dev-team 模板并补充 docs/lessons.md。`);
        }
      }
      pollFailures = 0;
      if (once) return;
    } catch (err) {
      // transient gh/network failure → backoff and keep watching
      pollFailures += 1;
      const delay = Math.min(300_000, 30_000 * pollFailures);
      console.error(`[${ts()}] ✖ 轮询失败 (${pollFailures}): ${err.message} — ${delay / 1000}s 后重试`);
      if (once) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

export { assertNoSecrets, SECRET_PATTERNS };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1); });
}
