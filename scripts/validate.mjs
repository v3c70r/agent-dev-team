#!/usr/bin/env node
// validate.mjs — the maintenance repo's own "build + test" (dogfooded by Agent C).
// Checks: syntax of all mjs/sh, SKILL.md frontmatter, template completeness,
// doctor self-check, and that the live .agent/ copies match templates/ (no drift).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lib from '../templates/lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const fail = (m) => { console.error('✗ ' + m); failures++; };
const ok = (m) => console.log('✓ ' + m);

// 1. node --check every .mjs
for (const f of ['templates/pipeline.mjs', 'templates/lib.mjs', 'templates/pm/run.mjs', 'scripts/validate.mjs', 'scripts/doctor.mjs']) {
  try { execFileSync('node', ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); ok(`syntax ${f}`); }
  catch (e) { fail(`syntax ${f}: ${e.stderr}`); }
}

// 2. bash -n every .sh
for (const f of ['templates/supervisor.sh', 'templates/pm/supervisor.sh', 'templates/brave-search/search.sh', 'templates/brave-search/fetch.sh']) {
  try { execFileSync('bash', ['-n', path.join(ROOT, f)], { stdio: 'pipe' }); ok(`syntax ${f}`); }
  catch (e) { fail(`syntax ${f}`); }
}

// 3. SKILL.md frontmatter
{
  const md = readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m || !/^name:\s*\S+/m.test(m[1]) || !/^description:\s*\S+/m.test(m[1])) fail('SKILL.md frontmatter (name/description)');
  else ok('SKILL.md frontmatter');
}

// 4. required templates exist
const REQUIRED = [
  'templates/issue-agent.yml', 'templates/pipeline.mjs', 'templates/lib.mjs', 'templates/supervisor.sh',
  'templates/prompts/implementer.md', 'templates/prompts/reviewer.md',
  'templates/pm/run.mjs', 'templates/pm/prompt.md', 'templates/pm/supervisor.sh',
  'templates/pm/screener.md', 'templates/pm/screen.mjs',
  'templates/config.json', 'templates/gitignore.snippet',
  'docs/lessons.md', 'docs/architecture.md', 'docs/feedback.md', 'README.md', 'LICENSE',
];
for (const f of REQUIRED) existsSync(path.join(ROOT, f)) ? ok(`exists ${f}`) : fail(`missing ${f}`);

// 5. workflow placeholder resolved (the live copy must not ship the placeholder)
{
  const wf = readFileSync(path.join(ROOT, '.github/workflows/issue-agent.yml'), 'utf8');
  if (wf.includes('{{GITHUB_OWNER}}')) fail('live workflow still contains {{GITHUB_OWNER}}');
  else ok('live workflow parameterized');
}

// 6. no drift: live .agent/ files must match templates/ (dogfood discipline)
const PAIRS = [
  ['templates/pipeline.mjs', '.agent/pipeline.mjs'],
  ['templates/lib.mjs', '.agent/lib.mjs'],
  ['templates/supervisor.sh', '.agent/supervisor.sh'],
  ['templates/prompts/implementer.md', '.agent/prompts/implementer.md'],
  ['templates/prompts/reviewer.md', '.agent/prompts/reviewer.md'],
  ['templates/pm/run.mjs', '.agent/pm/run.mjs'],
  ['templates/pm/prompt.md', '.agent/pm/prompt.md'],
  ['templates/pm/supervisor.sh', '.agent/pm/supervisor.sh'],
  ['templates/pm/screener.md', '.agent/pm/screener.md'],
  ['templates/pm/screen.mjs', '.agent/pm/screen.mjs'],
];
for (const [t, live] of PAIRS) {
  const lp = path.join(ROOT, live);
  if (!existsSync(lp)) { ok(`(skipped) ${live} not installed`); continue; }
  const a = readFileSync(path.join(ROOT, t), 'utf8');
  const b = readFileSync(lp, 'utf8');
  if (a === b) ok(`in-sync ${live}`);
  else fail(`DRIFT: ${live} differs from ${t} — update both (the loop must keep them identical)`);
}

// 7. implementer/reviewer prompts keep the mandatory verdict sentinel rule
{
  const r = readFileSync(path.join(ROOT, 'templates/prompts/reviewer.md'), 'utf8');
  if (!r.includes('RESULT: APPROVE')) fail('reviewer prompt lost the machine-readable verdict rule');
  else ok('reviewer verdict sentinel present');
  // 7b) both prompts must keep the global-auth ban + --body-file rule.
  // Lessons #21: an agent ran `gh auth switch` mid-run, which changed the
  // MACHINE-WIDE gh identity and broke every other session's write access
  // (403s) plus the loop's merge. Lessons #6: comment bodies mangled by shell
  // expansion. Both are prompt-level rules, so guard them in code.
  for (const f of ['templates/prompts/reviewer.md', 'templates/prompts/implementer.md']) {
    const t = readFileSync(path.join(ROOT, f), 'utf8');
    if (!t.includes('禁止修改全局认证状态')) fail(`${f} lost the global-auth-mutation ban (lessons #21)`);
    if (!t.includes('--body-file')) fail(`${f} lost the --body-file rule (lessons #6)`);
  }
  ok('prompt guards: global-auth ban + --body-file present');
}

// 7c) **模块级**运行时守卫：pipeline.mjs 必须能被干净地 import。
// `node --check` 只做语法检查，抓不到初始化顺序错误（TDZ）——2026-10-17 实测过
// `Cannot access 'CFG_JSON' before initialization` 让 watcher 无限崩溃重启，
// 而 validate 当时全绿。import 不触发 main()（有 isMain 守卫）。
{
  const url = 'file://' + path.join(ROOT, '.agent/pipeline.mjs').replace(/\\/g, '/');
  try {
    execFileSync('node', ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    ok('pipeline module imports cleanly (no TDZ / init-order bug)');
  } catch (e) {
    fail('pipeline module failed to import: ' + String((e.stderr || e.message) || '').split('\n').slice(0, 3).join(' '));
  }
}

// 8. doctor dogfood self-check: `npm run doctor` must be green in THIS repo
// (its stdout is reused by check 11 so we only pay for the slow model probe once)
let doctorHumanOut = '';
{
  try {
    doctorHumanOut = execFileSync('node', [path.join(ROOT, 'scripts/doctor.mjs')], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    ok('doctor green');
  } catch (e) {
    doctorHumanOut = String(e.stdout || '');
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
    fail(`doctor not green:\n${out}`);
  }
}

// 9. tester comment must not hardcode a test framework (对外宣称必须与实际执行一致)
{
  const pipe = readFileSync(path.join(ROOT, 'templates/pipeline.mjs'), 'utf8');
  if (pipe.includes('Playwright')) fail('templates/pipeline.mjs still hardcodes Playwright');
  else ok('tester comment generic (no Playwright)');
}

// 10. doctor probes main + fallback with one retry and skips unconfigured fallback
{
  const doc = readFileSync(path.join(ROOT, 'scripts/doctor.mjs'), 'utf8');
  for (const token of ['reviewFallbackModel', '已重试', '未配置回退模型，已跳过']) {
    if (doc.includes(token)) ok(`doctor ${token}`);
    else fail(`doctor missing "${token}"`);
  }
}

// 11. doctor --json: machine-readable output for CI / scripts (issue #7)
{
  const runDoctor = (args) => {
    try {
      return { out: execFileSync('node', [path.join(ROOT, 'scripts/doctor.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }), code: 0 };
    } catch (e) {
      return { out: String(e.stdout || ''), code: e.status };
    }
  };
  const { out: jsonOut, code } = runDoctor(['--json']);
  let data;
  try { data = JSON.parse(jsonOut); } catch (e) { data = null; fail(`doctor --json 输出不是合法 JSON: ${e.message}`); }
  if (data) {
    const problems = [];
    if (!Array.isArray(data.checks) || data.checks.length === 0) problems.push('checks 不是非空数组');
    else for (const c of data.checks) {
      if (typeof c.name !== 'string' || !c.name) problems.push('check 缺 name');
      if (!['pass', 'warn', 'fail'].includes(c.status)) problems.push(`check ${c.name} status 非法: ${c.status}`);
      if (typeof c.detail !== 'string') problems.push(`check ${c.name} 缺 detail`);
    }
    const s = data.summary;
    if (!s || !['pass', 'fail', 'warn'].every(k => Number.isInteger(s[k]))) problems.push('summary 缺整数 pass/fail/warn');
    else {
      if (s.pass + s.fail + s.warn !== data.checks.length) problems.push('summary 计数之和 != checks.length');
      // exit code must be 0 iff there are no failing checks (issue #7 acceptance).
      // Covers both regressions: exits 0 despite failures, and non-zero despite all pass.
      const codeOk = code === 0 ? s.fail === 0 : code > 0 && s.fail > 0;
      if (!codeOk) problems.push(`doctor --json 退出码 ${code} 与 fail 数 ${s.fail} 不符`);
    }
    if (typeof data.ok !== 'boolean') problems.push('ok 不是布尔值');
    else if (data.ok !== (data.summary?.fail === 0)) problems.push('ok 与 summary.fail 不一致');
    problems.length ? fail(`doctor --json schema: ${problems.join('; ')}`) : ok('doctor --json schema');
  }
  const markers = ['🔍 agent-dev-team doctor', '结果：', '─'.repeat(80)];
  const missing = markers.filter(m => !doctorHumanOut.includes(m));
  missing.length ? fail(`doctor 人类表格输出回归（缺: ${missing.join(' / ')}）`) : ok('doctor 人类表格输出未回归');
}

// 12. Agent C 的构建/测试命令必须可配置（lesson #17 的收尾）
//   非 npm 仓库、或没有 build/test scripts 的 Node 仓库，此前在 preflight 就被拦下。
{
  const cases = [
    ['defaults', {}, { build: 'npm run build', test: 'npm test' }],
    ['custom', { AGENT_BUILD_CMD: 'make build', AGENT_TEST_CMD: 'pytest -q' }, { build: 'make build', test: 'pytest -q' }],
    ['empty test = skip', { AGENT_TEST_CMD: '' }, { build: 'npm run build', test: '' }],
    ['trim', { AGENT_BUILD_CMD: '  make build  ' }, { build: 'make build' }],
  ];
  if (typeof lib.resolveTesterCommands !== 'function') fail('templates/lib.mjs 缺少 resolveTesterCommands()');
  else for (const [label, env, expect] of cases) {
    let got;
    try { got = lib.resolveTesterCommands(env); }
    catch (e) { fail(`resolveTesterCommands(${label}) 抛错: ${e.message}`); continue; }
    const bad = Object.entries(expect).filter(([k, v]) => got?.[k] !== v);
    if (bad.length) fail(`resolveTesterCommands(${label}): ${bad.map(([k, v]) => `${k} 期望 ${JSON.stringify(v)} 实得 ${JSON.stringify(got?.[k])}`).join('; ')}`);
    else ok(`resolveTesterCommands(${label})`);
  }
  // pipeline 不得再硬编码 npm 命令（实际执行必须等于可配置值 · lesson #17）
  const pipeSrc = readFileSync(path.join(ROOT, 'templates/pipeline.mjs'), 'utf8');
  const hard = [
    ["['npm', 'run', 'build']", /\[['"]npm['"],\s*['"]run['"],\s*['"]build['"]\]/],
    ["['npm', 'test']", /\[['"]npm['"],\s*['"]test['"]\]/],
  ].filter(([, re]) => re.test(pipeSrc));
  hard.length ? fail(`templates/pipeline.mjs 仍硬编码 npm 命令: ${hard.map(h => h[0]).join(', ')}`) : ok('pipeline tester commands not hardcoded');
  /resolveTesterCommands/.test(pipeSrc) ? ok('pipeline uses resolveTesterCommands') : fail('templates/pipeline.mjs 未使用 resolveTesterCommands');
  // the PR comment must report what actually ran (both pass and fail paths)
  const ranUses = (pipeSrc.match(/\$\{ran\}/g) || []).length;
  if (pipeSrc.includes('实际执行') && ranUses >= 2) ok('tester comment reports the commands actually run');
  else fail(`templates/pipeline.mjs 的测试评论未写明实际执行的命令（实际执行 标记=${pipeSrc.includes('实际执行')}，\${ran} 出现 ${ranUses} 次）`);
  // doctor 在配置了 env 的目录下必须放行（即便没有 package.json）
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-doctor-'));
  try {
    let out = '';
    try {
      out = execFileSync('node', [path.join(ROOT, 'scripts/doctor.mjs'), '--json'], {
        cwd: tmp,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, AGENT_BUILD_CMD: 'make build', AGENT_TEST_CMD: 'pytest -q' },
      });
    } catch (e) { out = String(e.stdout || ''); }
    let data = null;
    try { data = JSON.parse(out); } catch { /* asserted below */ }
    const bt = data?.checks?.find(c => c.name === 'build/test');
    if (!bt) fail('doctor --json 缺少 build/test 检查（无法断言 env 配置路径）');
    else if (bt.status !== 'pass') fail(`doctor 配置 AGENT_BUILD_CMD/AGENT_TEST_CMD 后 build/test 应为 pass，实为 ${bt.status}: ${bt.detail}`);
    else if (!bt.detail.includes('make build') || !bt.detail.includes('pytest -q')) fail(`doctor build/test detail 未显示实际命令: ${bt.detail}`);
    else ok('doctor honours AGENT_BUILD_CMD/AGENT_TEST_CMD (no package.json)');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// 13. Agent A 的修复轮必须基于 PR 现有分支（lesson #19）
//     `git checkout -B <branch> origin/<base>` 会把已存在的分支静默重置回 base，
//     丢掉上一轮实现并让 push 被非快进拒绝。用临时 bare origin + clone 做真集成断言
//     （无网络、无 gh、无 pi 依赖）。
{
  const g = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-branch-'));
  try {
    if (typeof lib.prepareImplementerBranch !== 'function') throw new Error('templates/lib.mjs 缺少 prepareImplementerBranch()');
    if (typeof lib.mergeIssueState !== 'function') throw new Error('templates/lib.mjs 缺少 mergeIssueState()');
    const origin = path.join(tmp, 'origin.git');
    const work = path.join(tmp, 'work');
    g(tmp, 'init', '--bare', origin);
    g(tmp, 'init', '-b', 'master', work);
    // commit identity must be explicit — CI runners often have no global git config
    g(work, 'config', 'user.email', 'agent@test.local');
    g(work, 'config', 'user.name', 'Agent Test');
    writeFileSync(path.join(work, 'base.txt'), 'base\n');
    g(work, 'add', '-A');
    g(work, 'commit', '-m', 'base');
    g(work, 'remote', 'add', 'origin', origin);
    g(work, 'push', '-u', 'origin', 'master');

    const branch = 'agent/13';
    // first round — branch off origin/<base>
    const first = lib.prepareImplementerBranch({ branch, base: 'master', cwd: work });
    if (first?.reused !== false) throw new Error(`首轮 reused 应为 false，实为 ${JSON.stringify(first)}`);
    const baseSha = g(work, 'rev-parse', 'origin/master');
    if (g(work, 'rev-parse', 'HEAD') !== baseSha) throw new Error(`首轮 HEAD != origin/master（${baseSha}）`);

    // simulate Agent A's implementation round on the PR branch
    writeFileSync(path.join(work, 'impl.txt'), 'round 1\n');
    g(work, 'add', '-A');
    g(work, 'commit', '-m', 'impl round 1');
    const implSha = g(work, 'rev-parse', 'HEAD');
    g(work, 'push', '-u', 'origin', branch);

    // fix round — MUST reuse the PR branch, not reset back to base
    const second = lib.prepareImplementerBranch({ branch, base: 'master', cwd: work });
    if (second?.reused !== true) throw new Error(`修复轮 reused 应为 true，实为 ${JSON.stringify(second)}`);
    const remoteSha = g(work, 'rev-parse', `origin/${branch}`);
    if (g(work, 'rev-parse', 'HEAD') !== remoteSha) throw new Error(`修复轮 HEAD != origin/${branch}（${remoteSha}）`);
    if (remoteSha === baseSha) throw new Error('修复轮分支 == base（丢掉上一轮实现）');
    let ancestor = true;
    try { g(work, 'merge-base', '--is-ancestor', implSha, 'HEAD'); } catch { ancestor = false; }
    if (!ancestor) throw new Error('修复轮 HEAD 不含上一轮 commit（impl commit 不是 HEAD 的祖先）');

    // state merge must keep counters written by earlier rounds
    const merged = lib.mergeIssueState({ round: 1, status: 'reviewing' }, { status: 'pr_open', pr: 42 });
    if (merged.round !== 1) throw new Error(`mergeIssueState 丢失 round:1 → ${JSON.stringify(merged)}`);
    if (merged.status !== 'pr_open' || merged.pr !== 42) throw new Error(`mergeIssueState patch 未生效 → ${JSON.stringify(merged)}`);

    // pipeline must route branch prep through the helper, never a bare checkout -B
    const pipe = readFileSync(path.join(ROOT, 'templates/pipeline.mjs'), 'utf8');
    if (!/prepareImplementerBranch\(/.test(pipe)) throw new Error('templates/pipeline.mjs 未调用 prepareImplementerBranch()');
    if (/git',\s*'checkout',\s*'-B'/.test(pipe)) throw new Error("templates/pipeline.mjs 仍有裸 git checkout -B");

    ok('prepareImplementerBranch: fix round reuses PR branch (no reset to base); mergeIssueState keeps counters');
  } catch (e) {
    fail(`修复轮分支准备/状态合并: ${e.message}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// 14. /reject 必须真正取消批准（issue #14）
//     只加否定标签 ≠ 取消：标签驱动的取活逻辑必须把 agent-rejected 当硬排除，
//     且 workflow 的 approve/reject 两个标签互斥（否则"已取消但仍在跑/被自动合并"）。
{
  // 14a. 纯函数 selectPendingIssues：否决优先 + 终态排除
  if (typeof lib.selectPendingIssues !== 'function') {
    fail('templates/lib.mjs 缺少 selectPendingIssues()');
  } else {
    const cases = [
      ['双标签·字符串 labels 被否决优先排除', [{ number: 1, labels: ['agent-approved', 'agent-rejected'] }], {}, []],
      ['双标签·对象 labels 被否决优先排除', [{ number: 1, labels: [{ name: 'agent-approved' }, { name: 'agent-rejected' }] }], {}, []],
      ['state=needs_human 排除', [{ number: 2, labels: ['agent-approved'] }], { 2: { status: 'needs_human' } }, []],
      ['state=merged 排除', [{ number: 3, labels: ['agent-approved'] }], { 3: { status: 'merged' } }, []],
      ['state=failed 排除', [{ number: 4, labels: ['agent-approved'] }], { 4: { status: 'failed' } }, []],
      ['state=rejected 排除', [{ number: 5, labels: ['agent-approved'] }], { 5: { status: 'rejected' } }, []],
      ['全新/进行中的 issue 仍被包含（回归：行为零变化）',
        [{ number: 6, labels: ['agent-approved'] }, { number: 7, labels: ['agent-approved'] }], { 7: { status: 'pr_open' } }, [6, 7]],
    ];
    const problems = [];
    for (const [label, issues, st, expect] of cases) {
      let got;
      try { got = lib.selectPendingIssues(issues, st).map(i => i.number); }
      catch (e) { problems.push(`${label} 抛错: ${e.message}`); continue; }
      if (JSON.stringify(got) !== JSON.stringify(expect)) problems.push(`${label}: 期望 [${expect}] 实得 [${got}]`);
    }
    problems.length ? fail(`selectPendingIssues: ${problems.join('; ')}`) : ok('selectPendingIssues: 否决优先 + 终态排除 + 未批准不回归');
  }

  // 14b. pipeline 走 helper，且把 /reject 落成 rejected 终态
  const pipe = readFileSync(path.join(ROOT, 'templates/pipeline.mjs'), 'utf8');
  if (/selectPendingIssues\(/.test(pipe)) ok('pipeline watch 使用 selectPendingIssues()');
  else fail('templates/pipeline.mjs 未用 selectPendingIssues() 判定待处理 issue');
  if (/\[\s*'merged',\s*'failed',\s*'needs_human',\s*'rejected'\s*\]/.test(pipe)) fail('templates/pipeline.mjs 仍内联写死 pending 终态数组');
  else ok('pipeline 未内联 pending 终态数组');
  if (/isRejectedIssue\(/.test(pipe) && /status[^;]*'rejected'/.test(pipe)) ok('pipeline 把 agent-rejected 的 issue 置为 rejected 终态');
  else fail("templates/pipeline.mjs 未在 processIssue() 开头把 agent-rejected 的 issue 置为 rejected 终态");
  if (/'rejected'/.test(pipe) && /issue',\s*'view'[\s\S]{0,120}labels/.test(pipe)) ok('pipeline 手动 run 路径带上 labels（否决可见）');
  else fail('templates/pipeline.mjs 手动 run 路径未取 labels（无法识别 /reject）');

  // 14b-2. 合并不可逆：finishMerge() 必须在 `gh pr merge` **之前**重新确认否决。
  //         review+test 窗口长达数十分钟，正是用户最想反悔的时候；只在取活时
  //         检查会因为 in-flight 的 processIssueInner 跑完而失效（Agent B #1）。
  {
    const fm = pipe.split('async function finishMerge(')[1]?.split('\n}')[0] || '';
    const iVeto = fm.indexOf('isRejectedIssue');
    const iMerge = fm.indexOf("'merge'");
    if (iVeto === -1) fail('finishMerge() 未在合并前重新检查 isRejectedIssue（运行中 /reject 仍会被自动合并）');
    else if (iMerge === -1 || iVeto > iMerge) fail('finishMerge() 的否决检查必须位于 gh pr merge 之前（否则形同没有）');
    else ok('finishMerge() 在 gh pr merge 之前重新确认 /reject（合并不可逆的唯一守卫）');
    if (/return\s*\{\s*skipped:\s*'rejected'/.test(fm)) ok('finishMerge() 否决时返回 skipped:rejected（不静默吞掉）');
    else fail("finishMerge() 检测到 /reject 时未返回 { skipped: 'rejected' }");
  }

  // 14c. workflow 两个标签互斥（templates 源 + live 副本都要有）
  for (const wfPath of ['templates/issue-agent.yml', '.github/workflows/issue-agent.yml']) {
    const wf = readFileSync(path.join(ROOT, wfPath), 'utf8');
    const rejectBlock = wf.split('// 1) explicit /reject')[1]?.split('// 2) /approve')[0] || '';
    const approveBlock = wf.split('// 2) /approve')[1]?.split('// 3) brand-new')[0] || '';
    if (/removeLabels/.test(rejectBlock) && /agent-approved/.test(rejectBlock)) ok(`${wfPath}: reject 分支移除 agent-approved`);
    else fail(`${wfPath}: reject 分支未同时出现 removeLabels 与 agent-approved（否决必须是真取消）`);
    if (/removeLabels/.test(approveBlock) && /agent-rejected/.test(approveBlock)) ok(`${wfPath}: approve 分支移除 agent-rejected`);
    else fail(`${wfPath}: approve 分支未移除 agent-rejected（改主意后无法重新批准）`);
    // 存量 issue 可能同时带两个标签（旧行为遗留）；/approve 必须能把它救回来，
    // 否则用户看到 approve 什么都没发生（Agent B #2）。
    if (/labels\.includes\(REJECTED\)/.test(approveBlock)) ok(`${wfPath}: approve 分支处理存量双标签（可重新批准）`);
    else fail(`${wfPath}: approve 分支在存量双标签（agent-approved+agent-rejected）issue 上是 no-op`);
  }
}

// 15. 不可逆动作只认「读回的真实状态」（issue #16）
//     真实事故：#14 的 `gh pr merge 15 --squash --delete-branch` 在 detached HEAD
//     下报 `could not determine current branch: ... not on any branch` —— 但合并
//     **已经成功**（mergedAt=17:23:32Z，早于那条报错日志 2 秒）。旧代码把退出码
//     当结果来源 → 误置 needs_human、留言「请手动合并」、远程分支 `agent/14` 残留，
//     状态机因此永久背离现实。修复=读回 PR 真实状态后再判定，读不到则 fail-closed。
{
  // 15a. 纯函数 classifyMergeAttempt：退出码非零但已合并 → 仍是 merged
  if (typeof lib.classifyMergeAttempt !== 'function') {
    fail('templates/lib.mjs 缺少 classifyMergeAttempt()');
  } else {
    const cases = [
      ['已合并（无错误）', { pr: { state: 'MERGED' } }, lib.MERGE_MERGED],
      ['命令报错但已合并（核心回归：#14 真实错误串）',
        { error: 'could not determine current branch: failed to run git: not on any branch',
          pr: { state: 'MERGED', mergedAt: '2026-10-11T17:23:32Z' } }, lib.MERGE_MERGED],
      ['仅凭 mergedAt 也判已合并', { pr: { mergedAt: '2026-10-11T17:23:32Z' } }, lib.MERGE_MERGED],
      ['确认未合并 OPEN', { error: 'x', pr: { state: 'OPEN' } }, lib.MERGE_BLOCKED],
      ['确认未合并 CLOSED', { error: 'x', pr: { state: 'CLOSED' } }, lib.MERGE_BLOCKED],
      ['读不到状态 → fail-closed', { error: 'x', pr: null }, lib.MERGE_UNKNOWN],
      ['无参数 → fail-closed', {}, lib.MERGE_UNKNOWN],
    ];
    const problems = [];
    for (const [label, args, expect] of cases) {
      let got;
      try { got = lib.classifyMergeAttempt(args); }
      catch (e) { problems.push(`${label} 抛错: ${e.message}`); continue; }
      if (got !== expect) problems.push(`${label}: 期望 ${expect} 实得 ${got}`);
    }
    problems.length
      ? fail(`classifyMergeAttempt: ${problems.join('; ')}`)
      : ok('classifyMergeAttempt: 命令报错但 PR 已合并仍判 merged（以读回状态为准）');
  }

  // 15b. finishMerge()：读回 PR 状态必须先于写 needs_human（禁止以退出码为准）
  const pipe = readFileSync(path.join(ROOT, 'templates/pipeline.mjs'), 'utf8');
  const fm = pipe.split('async function finishMerge(')[1]?.split('\n}')[0] || '';
  const iMerge = fm.indexOf("'merge'");          // gh pr merge 调用点
  const iRead = fm.indexOf("'pr', 'view'");      // gh pr view 读回（区分开头的 gh issue view）
  const iClassify = fm.indexOf('classifyMergeAttempt(');
  // lastIndexOf：finishMerge 顶部「无法确认 /reject 标签」的 needs_human 路径也合法存在，
  // 这里要断言的是**合并失败路径**的 needs_human 不在读回之前（否则仍是退出码即结果）。
  const iNeedsHuman = fm.lastIndexOf("'needs_human'");
  if (iMerge === -1) fail('finishMerge() 未找到 gh pr merge 调用');
  else if (iRead === -1 || iRead < iMerge) fail('finishMerge() 必须在 gh pr merge 之后用 `gh pr view` 读回真实状态（禁止只看退出码）');
  else if (iClassify === -1 || iClassify < iMerge) fail('finishMerge() 必须用 classifyMergeAttempt() 判定读回结果（且位于 gh pr merge 之后）');
  else if (iNeedsHuman === -1 || iNeedsHuman < iClassify) fail("finishMerge() 写 needs_human 的代码必须位于读回+判定之后（否则仍会以退出码为准误判合并失败）");
  else ok('finishMerge(): gh pr merge 后读回 PR 状态 + classifyMergeAttempt 分流，needs_human 只在读回之后写入');
  // detached HEAD 兜底：合并前切回 BASE，让 `--delete-branch` 的本地收尾有分支可用
  if (/'rev-parse'[\s\S]{0,90}'HEAD'/.test(fm) && /'checkout'[\s\S]{0,40}BASE/.test(fm)) ok('finishMerge() 在合并前处理 detached HEAD（切回 BASE，best-effort）');
  else fail('finishMerge() 未在合并前检测 detached HEAD 并切回 BASE（`--delete-branch` 会抛 not on any branch）');
  // 合并成功后尽力清理残留远程分支（读回 headRefName → ls-remote → api DELETE，失败只 warn）
  if (/ls-remote/.test(fm) && /git\/refs\/heads/.test(fm)) ok('finishMerge() 合并成功后尽力清理残留远程分支（失败不改变结果）');
  else fail('finishMerge() 未在合并成功后尽力清理残留远程分支（如 agent/14 会无限累积）');
  if (/repos\/\{owner\}\/\{repo\}/.test(fm) || /'api'[\s\S]{0,40}'DELETE'/.test(fm)) ok('finishMerge() 用 gh api DELETE 删远程分支');
  else fail('finishMerge() 未用 gh api DELETE 删远程分支');

  // 15c. docs/lessons.md 条目编号唯一（现存重复 17/18/19 → 文档纪律退化）
  const lessons = readFileSync(path.join(ROOT, 'docs/lessons.md'), 'utf8');
  const nums = [...lessons.matchAll(/^## (\d+)\./gm)].map(m => Number(m[1]));
  const seen = new Set(); const dups = [];
  for (const n of nums) { if (seen.has(n)) dups.push(n); seen.add(n); }
  if (dups.length) fail(`docs/lessons.md 条目编号重复: ${dups.join(', ')}`);
  else ok(`docs/lessons.md 条目编号唯一（共 ${nums.length} 条）`);
}


// 8. workflow inline script: syntax + undefined helper references
//    (a real bug shipped once: the triage script called `ensureLabel` after it
//     had been renamed to `addLabel`, which broke ALL triage runs silently)
{
  const wf = readFileSync(path.join(ROOT, '.github/workflows/issue-agent.yml'), 'utf8');
  const lines = wf.split('\n');
  const start = lines.findIndex(l => /^\s*script:\s*\|\s*$/.test(l));
  if (start === -1) fail('workflow: no inline script block found');
  else {
    const indent = lines[start].match(/^\s*/)[0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      // the block ends at the first non-empty line indented no deeper than `script:`
      if (l.trim() && l.match(/^\s*/)[0].length <= indent) { end = i; break; }
    }
    const body = lines.slice(start + 1, end).map(l => l.slice(Math.min(l.length, indent + 2))).join('\n');
    const tmp = path.join(ROOT, '.agent', 'tmp', 'wf-check.js');
    mkdirSync(path.dirname(tmp), { recursive: true });
    // github-script wraps the body in an async function → wrap the same way so
    // top-level `return`/`await` are legal when we syntax-check it
    writeFileSync(tmp, `(async () => {\n${body}\n})();\n`);
    if (!/github\.rest\.issues/.test(body)) fail('workflow script extraction looks truncated');
    try { execFileSync('node', ['--check', tmp], { stdio: 'pipe' }); ok('workflow script syntax'); }
    catch (e) { fail('workflow script syntax: ' + String(e.stderr || e).slice(0, 200)); }

    const defined = new Set([...body.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
    for (const m of body.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
    // strip comments + string bodies so words inside them cannot look like calls
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    const globals = new Set(['github','context','core','process','JSON','Object','Array','String','Number','Date','Math','console','require','fetch','Promise','Set','Map','parseInt','parseFloat','isNaN','Error','RegExp','setTimeout']);
    // async helpers are always invoked as `await name(...)` in this script
    const called = new Set([...code.matchAll(/await\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
    const undef = [...called].filter(n => !defined.has(n) && !globals.has(n) && !['if','for','while','switch','catch','return','typeof','function'].includes(n));
    if (undef.length) fail('workflow script references undefined helper(s): ' + undef.join(', '));
    else ok('workflow script helpers defined');
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
