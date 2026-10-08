#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════
//  Proposal Screener — 独立筛选 pm-proposal，决定是否值得实现
//
//  通过（IMPLEMENT）→ 追加 REFINED_TASK 到 issue 正文 + 打 agent-approved
//                    （受 screenAutoCapWeekly 每周自动实现上限约束）
//  需拆分（SPLIT）  → 评论拆分方案 + 关闭 + 记入 docs/product-review.md
//  拒绝（REJECT）   → 评论理由 + 关闭 + 记入 docs/product-review.md
//
//  用法:
//    node .agent/pm/screen.mjs --check              # 待筛数量 / 自动实现余额
//    node .agent/pm/screen.mjs                      # 处理所有待筛提案
//    node .agent/pm/screen.mjs --issue 31 --force   # 强制筛某条（含非 pm-proposal）
//
//  配置（env 优先，其次 .agent/config.json）:
//    SCREEN_PROVIDER / SCREEN_MODEL  默认 deepseek / deepseek-v4-flash
//    SCREEN_AUTO_APPROVE=1|0         默认 true（config: screenAutoApprove）
//    SCREEN_AUTO_CAP_WEEKLY          默认 5（config: screenAutoCapWeekly）
// ══════════════════════════════════════════════════════════════════
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh, detectBase, resolvePi } from '../lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT = path.join(ROOT, '.agent');
const PM_DIR = path.join(AGENT, 'pm');
const LOG_DIR = path.join(PM_DIR, 'logs');
const WT = path.join(PM_DIR, 'wt-screen');
const LABEL_PROPOSAL = 'pm-proposal';
const LABEL_SCREENED = 'pm-screened';
const LABEL_APPROVED = 'agent-approved';
const LABEL_REJECTED = 'agent-rejected';
const LABEL_AUTO = 'agent-auto-approved';

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const FORCE = args.includes('--force');
const ISSUE = (() => { const i = args.indexOf('--issue'); return i >= 0 ? args[i + 1] : null; })();

function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
function loadConfig() { try { return JSON.parse(readFileSync(path.join(AGENT, 'config.json'), 'utf8')); } catch { return {}; } }
function gh(a) { return sh(['gh', ...a]); }
function ghJson(a) { return JSON.parse(gh(a)); }
function log(msg) { console.log(`[screen ${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`); }

const CFG = { ...loadConfig() };
loadEnv();

const SCREEN = {
  provider: process.env.SCREEN_PROVIDER || CFG.screener?.provider || 'deepseek',
  model: process.env.SCREEN_MODEL || CFG.screener?.model || 'deepseek-v4-flash',
};
const AUTO = process.env.SCREEN_AUTO_APPROVE ? process.env.SCREEN_AUTO_APPROVE === '1' : (CFG.screenAutoApprove !== false);
const CAP = parseInt(process.env.SCREEN_AUTO_CAP_WEEKLY || String(CFG.screenAutoCapWeekly ?? 5), 10);
const BASE = detectBase();

function autoApprovedThisWeek() {
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  try { return ghJson(['issue', 'list', '--state', 'all', `--label=${LABEL_AUTO}`, '--search', `created:>=${since}`, '--limit', '50', '--json', 'number']).length; }
  catch { return 0; }
}

/** 待筛：open + pm-proposal + 无 pm-screened 标签 */
function pendingProposals() {
  return ghJson(['issue', 'list', '--state', 'open', `--label=${LABEL_PROPOSAL}`, '--limit', '30',
    '--json', 'number,title,body,labels'])
    .filter(i => !(i.labels || []).some(l => l.name === LABEL_SCREENED));
}

function runScreener(issue, autoBudgetLeft) {
  const promptFile = path.join(PM_DIR, 'screener.md');
  mkdirSync(PM_DIR, { recursive: true });
  const runtime = `\n\n---\n\n# 本次任务\n筛选 issue #${issue.number}: ${issue.title}\n\n## 提案正文\n${issue.body || '(空)'}\n\n## 上下文\n- 仓库: ${ROOT}\n- 上下文包: \`${path.join(PM_DIR, 'context.md')}\`（若存在）\n- 产品长期认知: \`docs/product-review.md\`\n- 每周自动实现余额: ${autoBudgetLeft}\n\n请按格式输出，最后一行必须是 \`RESULT: IMPLEMENT\` / \`RESULT: REJECT\` / \`RESULT: SPLIT\`。`;
  const rf = path.join(WT, `.screener-${issue.number}.md`);
  const p = path.join(PM_DIR, `prompt-${issue.number}.tmp.md`);
  writeFileSync(p, readFileSync(promptFile, 'utf8') + runtime);
  const argv = ['-p', '--mode', 'text', '--provider', SCREEN.provider, '--model', SCREEN.model,
    '--session-id', `pm-screen-${issue.number}`,
    '--system-prompt', 'You are an independent proposal screener in an automated GitHub pipeline. Follow the appended instructions strictly.',
    '--append-system-prompt', p,
    '--exclude-tools', 'ask_user_question,review_loop',
    '--no-approve',
    '现在执行筛选任务：读代码与上下文，按格式给出结论。'];
  const res = spawnSync(resolvePi(), argv, { cwd: ROOT, encoding: 'utf8', env: process.env });
  return (res.stdout || '') + (res.stderr ? `\n[stderr]\n${res.stderr}` : '');
}

function parseVerdict(out) {
  const last = (re) => { let m, i = -1; while ((m = re.exec(out)) !== null) i = m.index; return i; };
  const impl = last(/RESULT:\s*IMPLEMENT|VERDICT:\s*IMPLEMENT|建议实现|值得实现/gi);
  const split = last(/RESULT:\s*SPLIT|VERDICT:\s*SPLIT|需要拆分|建议拆分/gi);
  const rej = last(/RESULT:\s*REJECT|VERDICT:\s*REJECT|建议拒绝|不值得实现|重复提案/gi);
  const best = Math.max(impl, split, rej);
  if (best === -1) return 'REJECT';
  if (best === impl) return 'IMPLEMENT';
  if (best === split) return 'SPLIT';
  return 'REJECT';
}
function section(out, name) {
  const re = new RegExp(`^\\s*${name}\\s*:\\s*([\\s\\S]*?)(?=^\\s*[A-Z_]{3,}\\s*:|^\\s*<!--|$)`, 'mi');
  const m = out.match(re);
  return m ? m[1].trim() : '';
}

function recordRejection(verdict, issue, why) {
  try {
    rmSync(WT, { recursive: true, force: true });
    sh(['git', 'fetch', 'origin', BASE, '--quiet']);
    sh(['git', 'worktree', 'add', '--detach', WT, `origin/${BASE}`]);
    const f = path.join(WT, 'docs', 'product-review.md');
    if (!existsSync(f)) { log('no docs/product-review.md — skip memory write'); return; }
    const date = new Date().toISOString().slice(0, 10);
    const block = `\n- ${date} **#${issue.number} ${issue.title}** → 筛选判定 ${verdict}：${why.replace(/\s+/g, ' ').slice(0, 400)}\n`;
    let md = readFileSync(f, 'utf8');
    if (!/##\s*已评估但不建议/.test(md)) md += `\n\n## 已评估但不建议（由筛选 agent 维护，避免重复提案）\n`;
    md += block;
    writeFileSync(f, md);
    sh(['git', 'add', 'docs/product-review.md'], { cwd: WT });
    sh(['git', '-c', 'user.name=pm-screener', '-c', 'user.email=pm-screener@users.noreply.github.com',
      'commit', '-m', `docs: record screened-out proposal #${issue.number} (${verdict}) [pm-screener]`], { cwd: WT });
    try { sh(['git', 'push', 'origin', `HEAD:${BASE}`], { cwd: WT }); log('memory updated (pushed)'); }
    catch {
      sh(['git', 'fetch', 'origin', BASE, '--quiet'], { cwd: WT });
      sh(['git', 'rebase', `origin/${BASE}`], { cwd: WT });
      sh(['git', 'push', 'origin', `HEAD:${BASE}`], { cwd: WT });
      log('memory updated (pushed after rebase)');
    }
  } catch (e) { log('memory write failed: ' + String(e.message).slice(0, 160)); }
  finally { try { sh(['git', 'worktree', 'remove', WT, '--force']); } catch {} try { sh(['git', 'worktree', 'prune']); } catch {} rmSync(WT, { recursive: true, force: true }); }
}

function screenOne(issue, budgetLeft) {
  log(`screening #${issue.number}: ${issue.title}`);
  const out = runScreener(issue, budgetLeft);
  const verdict = parseVerdict(out);
  const why = section(out, 'WHY') || '(no WHY)';
  const scope = section(out, 'SCOPE');
  const testability = section(out, 'TESTABILITY');
  const refined = section(out, 'REFINED_TASK');
  const splitPlan = section(out, 'SPLIT_PLAN');

  mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  writeFileSync(path.join(LOG_DIR, `screen-${stamp}.md`),
    `# Screener run ${new Date().toISOString()} — issue #${issue.number}\nmodel: ${SCREEN.provider}/${SCREEN.model}\nverdict: ${verdict}\n\n${out}\n`,
    { flag: 'a' });

  const head = `🤖 **提案筛选（独立 agent，${SCREEN.provider}/${SCREEN.model}）**\n\n` +
    `**判定：${verdict}**\n\n- **WHY**：${why}\n` +
    (scope ? `- **SCOPE**：${scope}\n` : '') +
    (testability ? `- **TESTABILITY**：${testability}\n` : '');

  if (verdict === 'IMPLEMENT') {
    const auto = AUTO && budgetLeft > 0;
    const body = head + (refined ? `\n### 给 Agent A 的收紧任务\n${refined}\n` : '') +
      `\n${auto ? '✅ 已自动批准（本周自动实现余额 ' + (budgetLeft - 1) + '）→ 流水线将开始实现。'
               : '⏸ 未自动批准（自动实现已关闭或本周余额用尽）→ 等你 `/approve`。'}`;
    gh(['issue', 'comment', String(issue.number), '--body', body]);
    // 把收紧后的任务追加到正文，确保 Agent A 读到
    if (refined) {
      const marker = '<!-- agent-screener -->';
      const newBody = `${issue.body || ''}\n\n---\n\n${marker}\n## Agent 筛选结论与实现范围（自动追加）\n\n${head}${refined ? `\n### 给 Agent A 的收紧任务\n${refined}` : ''}\n`;
      try { gh(['issue', 'edit', String(issue.number), '--body', newBody]); } catch (e) { log('body update failed: ' + e.message); }
    }
    const labels = [LABEL_SCREENED];
    if (auto) labels.push(LABEL_APPROVED, LABEL_AUTO);
    try { gh(['issue', 'edit', String(issue.number), ...labels.flatMap(l => ['--add-label', l])]); } catch (e) { log('label failed: ' + e.message); }
    return auto ? 'AUTO_APPROVED' : 'SCREENED_PENDING_HUMAN';
  }

  // REJECT / SPLIT → 关闭 + 记入产品记忆
  const body = head + (splitPlan ? `\n### 拆分建议\n${splitPlan}\n` : '') +
    `\n❌ ${verdict === 'SPLIT' ? '方向有价值但 scope 过大/缺前置条件 —— 已按策略关闭，拆分建议见上；如认可可重开更小的 issue。' : '判定不值得实现 —— 已关闭并记入 PM 记忆，避免重复提案。'}`;
  gh(['issue', 'comment', String(issue.number), '--body', body]);
  try { gh(['issue', 'edit', String(issue.number), '--add-label', LABEL_SCREENED, '--add-label', LABEL_REJECTED]); } catch {}
  try { gh(['issue', 'close', String(issue.number), '--reason', 'not planned']); } catch {}
  recordRejection(verdict, issue, why);
  return verdict;
}

function main() {
  const used = autoApprovedThisWeek();
  const budgetLeft = Math.max(0, CAP - used);

  if (CHECK) {
    const pending = ISSUE ? [{ number: ISSUE, title: '(forced)' }] : (() => { try { return pendingProposals(); } catch { return []; } })();
    console.log(JSON.stringify({
      pending: pending.map(p => '#' + p.number),
      awaitingScreening: pending.length,
      autoApprove: AUTO,
      autoCapWeekly: CAP,
      autoUsedThisWeek: used,
      autoBudgetLeft: budgetLeft,
      model: `${SCREEN.provider}/${SCREEN.model}`,
      base: BASE,
    }, null, 2));
    return;
  }

  let list;
  if (ISSUE) {
    const full = JSON.parse(gh(['issue', 'view', String(ISSUE), '--json', 'number,title,body,labels']));
    if (!FORCE && (full.labels || []).some(l => l.name === LABEL_SCREENED)) { log(`#${ISSUE} already screened (use --force)`); return; }
    list = [full];
  } else {
    list = pendingProposals();
  }

  if (list.length === 0) { log('no proposals waiting for screening'); return; }
  log(`${list.length} proposal(s) to screen; auto budget left this week: ${budgetLeft}`);

  let left = budgetLeft;
  for (const issue of list) {
    try {
      const r = screenOne(issue, left);
      if (r === 'AUTO_APPROVED') left = Math.max(0, left - 1);
      log(`#${issue.number} → ${r}`);
    } catch (e) {
      log(`#${issue.number} screening failed: ${String(e.message).slice(0, 200)}`);
    }
  }
}

main();
