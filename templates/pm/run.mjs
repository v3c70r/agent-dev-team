#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════
//  Product Manager agent — daily, DeepSeek off-peak, ≤1 proposal/day
//
//  Usage:
//    node .agent/pm/run.mjs --check        # due? window open? slots left?
//    node .agent/pm/run.mjs                # run if due (daily target)
//    node .agent/pm/run.mjs --force        # run now (ignores schedule+window)
//    node .agent/pm/run.mjs --dry-run      # research + report, create NO issues
//
//  Scheduling:
//    - runs at PM_HOUR_UTC each day, but ONLY inside the DeepSeek discount
//      window (UTC 16:30–00:30) unless --force is given
//    - at most PM_DAILY_CAP (default 1) new issues per calendar day
//    - additionally bounded by PM_WEEKLY_CAP (default 5) rolling 7 days
//
//  Env:
//    PM_PROVIDER=deepseek  PM_MODEL=deepseek-v4-flash
//    PM_HOUR_UTC=17  PM_DAILY_CAP=1  PM_WEEKLY_CAP=5
//    PM_WINDOW_START_UTC=16.5  PM_WINDOW_END_UTC=24.5   (00:30 next day)
// ══════════════════════════════════════════════════════════════════
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PM_DIR = path.join(ROOT, '.agent', 'pm');
const STATE_FILE = path.join(PM_DIR, 'state.json');
const LOG_DIR = path.join(PM_DIR, 'logs');
const CONTEXT_FILE = path.join(PM_DIR, 'context.md');
const WT = path.join(PM_DIR, 'wt');
const LABEL = 'pm-proposal';

const CFG = {
  provider: process.env.PM_PROVIDER || 'deepseek',
  model: process.env.PM_MODEL || 'deepseek-v4-flash',
  hourUtc: parseFloat(process.env.PM_HOUR_UTC ?? '17'),
  dailyCap: parseInt(process.env.PM_DAILY_CAP ?? '1', 10),
  weeklyCap: parseInt(process.env.PM_WEEKLY_CAP ?? '5', 10),
  winStart: parseFloat(process.env.PM_WINDOW_START_UTC ?? '16.5'), // 16:30 UTC
  winEnd: parseFloat(process.env.PM_WINDOW_END_UTC ?? '24.5'),     // 00:30 UTC next day
};

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY = args.includes('--dry-run');
const CHECK = args.includes('--check');

// ── helpers ──
function sh(bin, argv, opts = {}) {
  return execFileSync(bin, argv, { cwd: opts.cwd || ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function ghJson(argv) { return JSON.parse(sh('gh', argv)); }
function log(msg) { console.log(`[pm ${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`); }

function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** UTC decimal hour, e.g. 17.5 = 17:30 UTC */
function utcDecimalHour(now = new Date()) { return now.getUTCHours() + now.getUTCMinutes() / 60; }

/** true when now falls inside the DeepSeek discount window (may cross midnight) */
function inOffPeakWindow(now = new Date()) {
  const h = utcDecimalHour(now);
  const s = CFG.winStart;
  const e = CFG.winEnd;
  // window ending after 24:00 means it wraps past midnight (e.g. 16:30 → 00:30)
  if (e > 24) return h >= s || h <= (e - 24);
  return s <= e ? (h >= s && h <= e) : (h >= s || h <= e);
}

/** today's scheduled instant (PM_HOUR_UTC) in UTC */
function todayTarget(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Math.floor(CFG.hourUtc), Math.round((CFG.hourUtc % 1) * 60), 0));
}
/** has today's run already happened? */
function isDue(state, now = new Date()) {
  if (FORCE) return true;
  const target = todayTarget(now);
  if (now < target) return false;                       // scheduled time not reached yet
  const last = state.lastRun ? new Date(state.lastRun) : null;
  return !last || last < target;                        // not yet run today
}

/** count pm-proposal issues created since a UTC date (inclusive) */
function countSince(isoDate) {
  try {
    return ghJson(['issue', 'list', '--state', 'all', `--label=${LABEL}`,
      '--search', `created:>=${isoDate}`, '--limit', '100', '--json', 'number,createdAt']);
  } catch { return []; }
}
function dayKey(now = new Date()) { return now.toISOString().slice(0, 10); }
function weekAgoKey(now = new Date()) { return new Date(now.getTime() - 7 * 864e5).toISOString().slice(0, 10); }

// ── context bundle ──
function buildContext() {
  const parts = [];
  parts.push(`# Context bundle (generated ${new Date().toISOString()})\n`);
  parts.push('## package.json scripts\n```json\n' + JSON.stringify(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts, null, 2) + '\n```\n');

  const tree = (dir, depth = 2) => {
    const out = [];
    const walk = (d, prefix, lvl) => {
      if (lvl > depth) return;
      for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (['node_modules', '.git', 'dist', 'test-results', 'tmp', 'wt'].includes(e.name)) continue;
        const p = path.join(d, e.name);
        out.push(prefix + e.name + (e.isDirectory() ? '/' : ` (${(statSync(p).size / 1024).toFixed(1)}K)`));
        if (e.isDirectory()) walk(p, prefix + '  ', lvl + 1);
      }
    };
    walk(dir, '', 1);
    return out.join('\n');
  };
  parts.push('## File tree\n```\n' + tree(ROOT, 2) + '\n```\n');

  try {
    const spec = readFileSync(path.join(ROOT, 'tests/app.spec.js'), 'utf8');
    parts.push(`\n## Tests\n${spec.match(/test\(/g)?.length || 0} tests in tests/app.spec.js\n`);
  } catch { /* no tests/app.spec.js — fine, describe via package.json scripts above */ }

  try {
    const open = ghJson(['issue', 'list', '--state', 'open', '--limit', '40', '--json', 'number,title,state,createdAt,labels,body']);
    parts.push('\n## Open issues\n' + open.map(i => `- #${i.number} [${(i.labels || []).map(l => l.name).join(',')}] ${i.title}`).join('\n') + '\n');
  } catch {}
  try {
    const closed = ghJson(['issue', 'list', '--state', 'closed', '--limit', '30', '--json', 'number,title,closedAt']);
    parts.push('\n## Recently closed issues (avoid duplicates)\n' + closed.map(i => `- #${i.number} ${i.title}`).join('\n') + '\n');
  } catch {}
  try {
    const prs = ghJson(['pr', 'list', '--state', 'merged', '--limit', '15', '--json', 'number,title,mergedAt']);
    parts.push('\n## Recently merged PRs\n' + prs.map(p => `- #${p.number} ${p.title}`).join('\n') + '\n');
  } catch {}
  try {
    const d = ghJson(['issue', 'list', '--state', 'all', `--label=${LABEL}`, '--limit', '40', '--json', 'number,title,state,createdAt']);
    parts.push('\n## Previously proposed pm-proposal issues\n' + (d.map(i => `- #${i.number} [${i.state}] ${i.title}`).join('\n') || '(none)') + '\n');
  } catch {}

  const out = parts.join('\n');
  writeFileSync(CONTEXT_FILE, out);
  return out;
}

function resolvePi() {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d || d.includes('node_modules')) continue;
    const c = path.join(d, 'pi');
    if (existsSync(c)) return c;
  }
  return 'pi';
}

// ── main ──
function main() {
  loadDotEnv();
  mkdirSync(LOG_DIR, { recursive: true });
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
  const now = new Date();

  const today = dayKey(now);
  const dailyUsed = countSince(today).length;
  const weeklyUsed = countSince(weekAgoKey(now)).length;
  const slots = Math.max(0, Math.min(CFG.dailyCap - dailyUsed, CFG.weeklyCap - weeklyUsed));
  const due = isDue(state, now);
  const windowOpen = inOffPeakWindow(now);

  if (CHECK) {
    console.log(JSON.stringify({
      now: now.toISOString(),
      schedule: `daily at ${CFG.hourUtc}:00 UTC, window ${CFG.winStart}–${CFG.winEnd} UTC (off-peak)`,
      offPeakWindowOpenNow: windowOpen,
      todayTarget: todayTarget(now).toISOString(),
      lastRun: state.lastRun || null,
      due, dailyUsed, dailyCap: CFG.dailyCap, weeklyUsed, weeklyCap: CFG.weeklyCap,
      slotsLeft: slots,
      model: `${CFG.provider}/${CFG.model}`,
      braveKey: !!process.env.BRAVE_API_KEY,
    }, null, 2));
    return;
  }

  if (!due) { log(`not due yet (target ${todayTarget(now).toISOString()}). skip.`); return; }
  // a dry run creates nothing, so it ignores the quota (but still needs --force
  // to bypass the schedule/window unless it is genuinely due)
  if (slots === 0 && !DRY) { log(`quota reached (today ${dailyUsed}/${CFG.dailyCap}, 7d ${weeklyUsed}/${CFG.weeklyCap}). skip.`); return; }
  if (!windowOpen && !FORCE) {
    log(`outside DeepSeek off-peak window (${CFG.winStart}–${CFG.winEnd} UTC), now ${utcDecimalHour(now).toFixed(2)}h UTC — waiting. Use --force to override.`);
    return;
  }
  if (!process.env.BRAVE_API_KEY) log('⚠️  BRAVE_API_KEY missing — research will be GitHub/curl only');

  log(`starting PM run — model=${CFG.provider}/${CFG.model}, slots=${slots}${DRY ? ' (dry-run)' : ''}${FORCE ? ' [forced]' : ''}`);

  rmSync(WT, { recursive: true, force: true });
  sh('git', ['fetch', 'origin', 'master', '--quiet']);
  sh('git', ['worktree', 'add', '--detach', WT, 'origin/master']);

  try {
    buildContext();

    const runtime = `\n\n---\n\n# 本次运行\n- 当前时间(UTC): ${now.toISOString()}\n- 今日剩余提案名额: **${DRY ? Math.max(slots, 1) : slots}**${DRY ? '（DRY RUN 演练：请列出候选但不要创建）' : ''}（每日上限 ${CFG.dailyCap}，7 天滚动上限 ${CFG.weeklyCap}；今日已用 ${dailyUsed}，近 7 天已用 ${weeklyUsed}）\n- 目标：**只做 1 个最有价值的提案**（深度优先，宁可 0 个也不要凑数）\n- 你的长期记忆文件: \`docs/product-review.md\`（在工作目录内，请更新它）\n- 上下文包(绝对路径): \`${CONTEXT_FILE}\`\n- 工作目录: \`${WT}\`（本仓库的独立 worktree，可读全部代码）\n- 调研工具: \`.agents/skills/brave-search/search.sh\` / \`fetch.sh\`（BRAVE_API_KEY 已在环境变量中），以及 \`gh search repos\`\n${DRY ? '- ⚠️ DRY RUN：**不要**创建任何 GitHub issue，只在最终输出里列出候选提案。\n' : ''}`;

    const promptFile = path.join(PM_DIR, 'prompt.md');
    const piArgs = [
      '-p', '--mode', 'text',
      '--provider', CFG.provider, '--model', CFG.model,
      '--session-id', 'pm-agent-daily',
      '--system-prompt', 'You are an autonomous daily Product Manager agent. Follow the appended instructions strictly.',
      '--append-system-prompt', promptFile,
      '--exclude-tools', 'ask_user_question,review_loop',
      '--no-approve',
      `现在执行今日产品调研任务。先更新 docs/product-review.md，再做竞品调研，最后${DRY ? '列出候选提案（不要建 issue）' : `创建不超过 ${slots} 个 pm-proposal issue（优先 1 个最有价值的）`}。`,
    ];

    log('invoking pi (this may take a few minutes)…');
    const res = spawnSync(resolvePi(), piArgs, { cwd: WT, encoding: 'utf8', timeout: 0, env: process.env });
    const out = (res.stdout || '') + (res.stderr ? `\n[stderr]\n${res.stderr}` : '');

    writeFileSync(path.join(LOG_DIR, `${today}.md`), `# PM run ${new Date().toISOString()}\n\nmodel: ${CFG.provider}/${CFG.model}\nslots: ${slots}\n\n---\n\n${out}\n`);
    log(`pi finished (exit=${res.status})`);

    if (!DRY) {
      let committed = false;
      try {
        sh('git', ['add', 'docs/product-review.md'], { cwd: WT });
        sh('git', ['-c', 'user.name=pm-agent', '-c', 'user.email=pm-agent@users.noreply.github.com',
          'commit', '-m', 'docs: product review update [pm]'], { cwd: WT });
        committed = true;
      } catch { log('no product-review change to commit'); }
      if (committed) {
        try { sh('git', ['push', 'origin', 'HEAD:master'], { cwd: WT }); log('pushed docs/product-review.md → master'); }
        catch {
          log('push rejected, rebasing once…');
          try {
            sh('git', ['fetch', 'origin', 'master', '--quiet'], { cwd: WT });
            sh('git', ['rebase', 'origin/master'], { cwd: WT });
            sh('git', ['push', 'origin', 'HEAD:master'], { cwd: WT });
            log('pushed after rebase');
          } catch (e2) { log('push failed: ' + String(e2.message).slice(0, 200)); }
        }
      }
    }

    const created = (out.match(/https:\/\/github\.com\/[^\s)]+\/issues\/\d+/g) || []);
    if (!DRY) {
      state.lastRun = now.toISOString();
      state.lastSlots = slots;
      state.lastCreated = created;
      state.lastModel = `${CFG.provider}/${CFG.model}`;
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } else {
      state.lastDryRun = now.toISOString();
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    }
    log(created.length ? `created: ${created.join(', ')}` : 'no issues created this run');
    log(`log: ${path.join(LOG_DIR, `${today}.md`)}`);
  } finally {
    try { sh('git', ['worktree', 'remove', WT, '--force']); } catch {}
    try { sh('git', ['worktree', 'prune']); } catch {}
    rmSync(WT, { recursive: true, force: true });
  }
}

main();
