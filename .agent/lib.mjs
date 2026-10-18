// lib.mjs — shared environment helpers used by BOTH:
//   * templates/pipeline.mjs  (the live multi-agent loop)
//   * scripts/doctor.mjs      (the one-shot preflight)
// Keeping `detectBase()` and `resolvePi()` in ONE place avoids the two drifting
// apart (lessons #1 PATH pollution, #14 missing origin/HEAD).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// tiny non-interactive shell helper; throws on nonzero exit.
// cwd defaults to the repo containing this file; doctor.mjs passes the
// repo being checked explicitly so it works when run from a skill directory.
export function sh(cmd, opts = {}) {
  const out = execFileSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    // env/timeout MUST be forwarded: dropping them silently broke per-role
    // GitHub identities (reviewer GH_TOKEN) and long-running commands.
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
  });
  return out.trim();
}

// Agent C's build/test commands. Defaults keep the historical npm behaviour,
// but repos that are NOT npm-based (Python/Go/Rust) or that simply have no
// build/test scripts must be able to install this skill — they set
// AGENT_BUILD_CMD / AGENT_TEST_CMD (e.g. `make build` / `pytest -q`).
// An explicit empty string means "skip that step". The resolved values are what
// the PR comment reports, so the claim always equals what actually ran (lesson #17).
export function resolveTesterCommands(env = process.env) {
  const build = env.AGENT_BUILD_CMD ?? 'npm run build';
  const test = env.AGENT_TEST_CMD ?? 'npm test';
  return { build: String(build).trim(), test: String(test).trim() };
}

// ── /reject 语义（issue #14）───────────────────────────────────────
// 产品承诺「/reject 可取消一次批准」，但标签驱动的 worker 只看触发标签：
// 只加一个否定标签 agent-rejected 而不移除 agent-approved，issue 仍会被实现、
// 审查、测试并**自动合并**（合并不可逆）。因此取消必须 (1) 两个标签互斥，
// (2) 取活判定把 agent-rejected 当**硬排除**，让状态机有可达的 rejected 终态。
// 单一实现，pipeline 与 validate 共用（避免两份归一化逻辑漂移）。
export const REJECTED_LABEL = 'agent-rejected';
export const APPROVED_LABEL = 'agent-approved';

/** Normalize an issue's labels to plain names (string[] or GitHub's [{name}]). */
export function labelNames(issue) {
  return (issue?.labels || [])
    .map(l => (typeof l === 'string' ? l : l?.name))
    .filter(Boolean);
}

/** True when the issue carries the /reject label (hard veto, beats approval). */
export function isRejectedIssue(issue) {
  return labelNames(issue).includes(REJECTED_LABEL);
}

// Which issues should the watch loop pick up?
//  * agent-rejected → NEVER (veto wins even if agent-approved is still present)
//  * terminal state (merged/failed/needs_human/rejected) → no
// Pure + explicit so it can be asserted without gh/network.
export function selectPendingIssues(issues = [], state = {}) {
  const TERMINAL = ['merged', 'failed', 'needs_human', 'rejected'];
  return (issues || []).filter(it => {
    if (isRejectedIssue(it)) return false;      // 否决优先
    const c = state[it.number];
    return !c || !TERMINAL.includes(c.status);
  });
}

// ── 终态的人工恢复入口（issue #19）──────────────────────────────────
// `needs_human` / `failed` 曾经是死胡同：watch 循环把两者当终态跳过，文档也只写
// 「请人工处理」，唯一的逃生口是未文档化的 `run --issue N --force` —— 而 `--force`
// **同时绕过 /reject 检查**，人类为了救一个卡住的 issue 可能顺手复活一个已被否决的
// issue。这里把「能不能重试、重试后从哪继续」抽成一个纯函数，pipeline 的 `retry`
// 子命令与 validate 共用同一份判定（避免两份逻辑漂移，lessons #26）。
//
// 语义：
//   needs_human / failed → 可重试；`next` 保留既有进度（pr/branch/round/fixes…），
//     status 复位为 `pr_open`（有 PR，从审查/测试继续）或 `new`（无 PR，从头实现），
//     retries+1、retriedAt 记录本次时间、previousStatus 保留旧状态用于审计，
//     旧 `error` 移入 `lastError` 后清空（错误已受理，但保留证据）。
//   merged   → 不可逆，永不可重试
//   rejected → 否决优先，重试不适用（要恢复请先 /approve 解除否决）
//   blocked  → 等依赖，不是失败；依赖关闭后流水线自动接手
//   pr_open  → 已在进行中，无需重试
//   无记录    → 从未被处理过，无需重试
// 纯函数：必须返回新对象，绝不修改入参（validate 会断言）。
export const RETRYABLE_STATUSES = ['needs_human', 'failed'];

/** Reset a terminal `needs_human`/`failed` entry so the loop can resume it. */
export function retryReset(prev) {
  if (!prev || typeof prev !== 'object') {
    return { ok: false, reason: '无状态记录（该 issue 从未被流水线处理过）' };
  }
  const status = String(prev.status || '');
  if (status === 'merged') return { ok: false, reason: '已合并（不可逆，不能重试）' };
  if (status === 'rejected') return { ok: false, reason: '已被 /reject 否决（否决优先；如需恢复请先 /approve 解除）' };
  if (status === 'blocked') return { ok: false, reason: '等待依赖中（不是失败；依赖关闭后流水线会自动接手）' };
  if (status === 'pr_open') return { ok: false, reason: 'PR 已在进行中（无需重试）' };
  if (!RETRYABLE_STATUSES.includes(status)) {
    return { ok: false, reason: `状态 ${status || '(空)'} 不在可重试范围（只有 ${RETRYABLE_STATUSES.join(' / ')} 可重试）` };
  }
  const next = { ...prev };
  // 有 PR → 从审查/测试继续；没有 PR → 必须回到 `new`，否则实现入口不会触发（见 pipeline）。
  next.status = prev.pr ? 'pr_open' : 'new';
  next.retries = (Number(prev.retries) || 0) + 1;
  next.retriedAt = new Date().toISOString();
  next.previousStatus = status;
  if (prev.error !== undefined) {
    next.lastError = prev.error;   // 保留证据：上一次失败的原因
    delete next.error;             // 但当前状态不再是「失败中」
  }
  return { ok: true, next };
}

/** Human-readable one-liner per stuck entry (for `pipeline.mjs retry --list`). */
// `retry --list` 也是出站点（issue #21 / Agent B review #1）：state.error 常是**原始**报错
// （远端 URL 内嵌凭据的 push 失败、带令牌的 API 报错），原样打到终端就是 tmux 窗格 /
// CI 日志 / 截图泄漏 —— 正是 lessons #25「内容贴来贴去」的路径。
// 在纯函数内部脱敏，保证所有调用方（含未來的）都不会把这行原始错误打出去。
export function formatRetryList(state = {}) {
  const lines = [];
  for (const key of Object.keys(state || {})) {
    const prev = state[key];
    if (!prev || !RETRYABLE_STATUSES.includes(String(prev.status || ''))) continue;
    const num = Number(key);
    const err = prev.error === undefined || prev.error === null || prev.error === ''
      ? '-'
      : redactSecrets(String(prev.error)).replace(/\s+/g, ' ').slice(0, 120);
    lines.push({ n: Number.isFinite(num) ? num : Infinity, text: `#${key} ${prev.status} pr=${prev.pr ?? '-'} retries=${prev.retries || 0} error=${err}` });
  }
  return lines.sort((a, b) => a.n - b.n).map(l => l.text);
}

// Prepare the branch Agent A implements on.
// FIRST round: branch off `origin/<base>`. FIX round: the PR branch already
// exists upstream, so we MUST continue on it — `git checkout -B <branch>
// origin/<base>` would silently RESET it back to base (dropping the previous
// round's commits) and turn the follow-up `git push` into a non-fast-forward
// reject. This is the single, testable place where that decision is made
// (lesson #19). `fetch origin` (all refs) is required so `origin/<branch>`
// is up to date on the fix-round path.
export function prepareImplementerBranch({ branch, base, cwd } = {}) {
  const exists = (ref) => {
    try { sh(['git', 'rev-parse', '--verify', '--quiet', ref], { cwd }); return true; }
    catch { return false; }
  };
  sh(['git', 'fetch', 'origin', '--quiet'], { cwd });
  const remote = `origin/${branch}`;
  if (exists(remote)) {
    // fix round — continue on the PR branch (`checkout <branch>` auto-creates a
    // local tracking branch when this checkout does not have one yet).
    sh(['git', 'checkout', branch], { cwd });
    sh(['git', 'reset', '--hard', remote], { cwd });
    return { reused: true };
  }
  sh(['git', 'checkout', '-B', branch, `origin/${base}`], { cwd });
  return { reused: false };
}

// State updates must MERGE, never replace: overwriting an issue entry with a
// fresh `{round:0,fixes:0}` erased the review round the loop had just recorded,
// so state.json could not remember that any fix round happened (lesson #19).
export function mergeIssueState(prev, patch) {
  return { ...(prev || {}), ...patch };
}

// ── 不可逆动作的「真实状态」判定（issue #16）────────────────────────
// `gh pr merge --delete-branch` 的语义是「先合并，再删本地与远程分支」：
// 删本地分支需要「当前分支」，工作区 detached HEAD 时 gh 抛
// `could not determine current branch: ... not on any branch` —— **合并在前、
// 报错在后**。所以退出码不能当作合并结果的事实来源：不可逆动作只认「读回
// 的真实状态」（issue #14/PR #15 的真实事故：mergedAt=17:23:32Z 已合并，
// 日志 17:23:34 却写 needs_human）。
// 三个终值：
//   merged  → 已合并（退出码非零也不例外）
//   blocked → 确认未合并（PR 仍 OPEN/CLOSED）
//   unknown → 读不到状态 → fail-closed（按未合并处理，交人工确认）
// 纯函数、无副作用，pipeline 与 validate 共用同一判定（避免两份逻辑漂移）。
export const MERGE_MERGED = 'merged';
export const MERGE_BLOCKED = 'blocked';
export const MERGE_UNKNOWN = 'unknown';
// `error` 是 `gh pr merge` 的报错文本（保留用于调用点可读性 / 未来诊断），
// 判定本身**只**依赖读回的 `pr` —— 这正是本函数存在的意义：
// 命令报错但已合并仍应判 merged。
export function classifyMergeAttempt({ error, pr } = {}) {
  const merged = !!(pr && (pr.state === 'MERGED' || pr.mergedAt));
  if (merged) return MERGE_MERGED;
  if (pr && (pr.state === 'OPEN' || pr.state === 'CLOSED')) return MERGE_BLOCKED;
  return MERGE_UNKNOWN;
}

// default branch auto-detected (main/master); override with AGENT_BASE.
// NOTE: `refs/remotes/origin/HEAD` is often MISSING on fresh clones (e.g. after
// `gh repo create --source=. --push`), so never let detection throw at import time.
export function detectBase(cwd = ROOT) {
  if (process.env.AGENT_BASE) return process.env.AGENT_BASE;
  const tryOut = (args) => { try { return sh(args, { cwd }).trim(); } catch { return ''; } };
  const sym = tryOut(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '');
  if (sym) return sym;
  for (const cand of ['main', 'master']) {
    if (tryOut(['git', 'rev-parse', '--verify', `origin/${cand}`])) return cand;
  }
  const ls = tryOut(['git', 'ls-remote', '--symref', 'origin', 'HEAD']);
  const m = ls.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  if (m) return m[1];
  return 'master';
}

// locate the real pi binary.
// `npm run` prepends node_modules/.bin to PATH, and a transitive dep also ships
// a (much older) `pi` CLI that shadows the real one — skip those dirs.
let PI_BIN = null;
export function resolvePi() {
  if (PI_BIN) return PI_BIN;
  if (process.env.PI_BIN) { PI_BIN = process.env.PI_BIN; return PI_BIN; }
  const dirs = (process.env.PATH || '').split(path.delimiter)
    .filter(d => d && !d.includes('node_modules'));
  for (const d of dirs) {
    const c = path.join(d, 'pi');
    if (existsSync(c)) { PI_BIN = c; return PI_BIN; }
  }
  PI_BIN = 'pi';
  return PI_BIN;
}

// ── 出站凭据防线（issue #21）─────────────────────────────────────────
// 2026-10-16 真实事故（提交 c36aca5）：评论正文里的 `$(gh auth token …)` 被 shell
// 展开成**真令牌**并贴进 PR 评论 → GitHub secret scanning 自动吊销 → 全链路 401，
// 流水线卡死。事后加了 `assertNoSecrets()`，但只挂在 3 个调用点，其余出站/落盘路径
// （上游 feedback、`gh pr review --body`、筛选器评论、`issue edit --body`、日志）全部
// 裸奔。把模式与两个 helper 放进 lib 是**结构性**修复：两个入口（pipeline、pm/screen）
// 都从同一份实现取值，`scripts/validate.mjs` 的 lint（7e）再保证每个 `'--body'`
// 调用点都被包裹（漏一处 → `npm test` 红）。docs/lessons.md #28。
//
// 规则二分（为什么不是一个函数解决）：
//   * agent **自己撰写**的正文（pipeline 评论 / PR 正文 / review 正文）→ 硬拦截
//     （`assertNoSecrets` throw）：宁可少发一条评论，也不泄漏凭据。
//   * **必须留下审计记录**的通道（上游 feedback、筛选判定评论、`issue edit --body`、
//     本地日志）→ 脱敏后发送（`redactSecrets`）：凭据绝不能发出去，但判定本身
//     绝不能因检测到凭据而丢失，否则审计断链。
export const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/,        // GitHub OAuth / PAT / user / server token
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,      // fine-grained PAT
  /\bglpat-[A-Za-z0-9_-]{16,}\b/,          // GitLab
  /\bsk-[A-Za-z0-9_-]{16,}\b/,             // OpenAI-style secret key
  /\bAKIA[0-9A-Z]{16}\b/,                  // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,      // Slack
];

/** How many token-shaped substrings does `text` contain? (pure; for audit counts) */
export function countSecretMatches(text) {
  const str = String(text ?? '');
  let n = 0;
  for (const re of SECRET_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    n += (str.match(g) || []).length;
  }
  return n;
}

/**
 * Replace every token-shaped substring with `<redacted:gho_>` (first 4 chars only —
 * enough to tell *which kind* of credential leaked while never revealing it).
 * Pure + **idempotent** (`redactSecrets(redactSecrets(x)) === redactSecrets(x)`),
 * zero false positives on normal prose / URLs / ordinary words.
 */
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    out = out.replace(g, (m) => `<redacted:${m.slice(0, 4)}>`);
  }
  return out;
}

/**
 * Hard block (fail-closed): refuse to send text containing a token shape.
 * Used for bodies the pipeline itself writes — never "sanitize then send".
 */
export function assertNoSecrets(text, where = 'GitHub 正文') {
  const str = String(text ?? '');
  for (const re of SECRET_PATTERNS) {
    const m = str.match(re);
    if (m) {
      // 报错里只暴露前 6 位，避免把泄漏内容再写进日志/工单
      throw new Error(
        `拒绝发送 ${where}：正文中含疑似凭据（${m[0].slice(0, 6)}…，len=${m[0].length}）。` +
        '这是硬拦截，请移除凭据后重试（docs/lessons.md #28）');
    }
  }
  return str;
}
