#!/usr/bin/env node
// validate.mjs — the maintenance repo's own "build + test" (dogfooded by Agent C).
// Checks: syntax of all mjs/sh, SKILL.md frontmatter, template completeness,
// doctor self-check, and that the live .agent/ copies match templates/ (no drift).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, mkdtempSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
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

// 7d) **下发前令牌特征拦截**必须存在且真的会拦（lessons #26：真令牌曾被 shell 展开
// 贴进 PR 评论 → GitHub 自动吊销 → 全链路 401）。这里做功能测试，而不是只 grep 源码。
{
  const url = 'file://' + path.join(ROOT, '.agent/pipeline.mjs').replace(/\\/g, '/');
  const probe = `
    const m = await import(${JSON.stringify(url)});
    const bad = ['gho_' + 'a'.repeat(36), 'github_pat_' + 'b'.repeat(30), 'sk-' + 'c'.repeat(24)];
    const msgs = [];
    for (const t of bad) { try { m.assertNoSecrets('正文 ' + t); msgs.push('NOT-BLOCKED'); } catch { msgs.push('blocked'); } }
    let okText = 'ok';
    try { m.assertNoSecrets('普通正文，不含任何凭据。'); } catch (e) { okText = 'FALSE-POSITIVE'; }
    console.log(JSON.stringify({ msgs, okText }));`;
  try {
    const out = execFileSync('node', ['--input-type=module', '-e', probe], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    const r = JSON.parse(out.trim().split('\n').pop());
    if (r.msgs.some(x => x !== 'blocked')) fail('assertNoSecrets 未拦截某些令牌形态: ' + JSON.stringify(r.msgs));
    else if (r.okText !== 'ok') fail('assertNoSecrets 对正常文本误报');
    else ok('assertNoSecrets blocks token shapes, passes normal text');
  } catch (e) {
    fail('assertNoSecrets 功能测试失败: ' + String((e.stderr || e.message) || '').split('\n').slice(0, 3).join(' '));
  }
}

// 8. doctor dogfood self-check: `npm run doctor` must be green in THIS repo
// (its stdout is reused by check 11 so we only pay for the slow model probe once)
//
// 宿主相关检查必须用 `--skip` 排除：tmux / gh 登录 / pi / 模型探针 /
// labels 描述的是**这台机器**，不是这个仓库。它们在没有 tmux / 没有网络 /
// 没有 gh 登录的 CI 容器里必然红 → `npm test` 永远红 → **每个 PR 都被测试卡死**
// （Agent C 实测：容器无 tmux，功能测试失败，见 docs/lessons.md #27）。
// 真机安装的 preflight 仍然要求全绿（SKILL.md）。
const DOCTOR_HOST_CHECKS = ['tmux', 'gh auth', 'gh repo', 'pi', '\u6a21\u578b\u53ef\u7528\u6027', 'reviewer \u8d26\u53f7', 'labels'];
const DOCTOR_SKIP_ARGS = ['--skip', DOCTOR_HOST_CHECKS.join(',')];
let doctorHumanOut = '';
{
  try {
    doctorHumanOut = execFileSync('node', [path.join(ROOT, 'scripts/doctor.mjs'), ...DOCTOR_SKIP_ARGS], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    ok(`doctor green（仓库类检查；宿主相关项已按 CI 跳过：${DOCTOR_HOST_CHECKS.join(', ')}）`);
  } catch (e) {
    doctorHumanOut = String(e.stdout || '');
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
    fail(`doctor not green (仓库类检查):\n${out}`);
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
  const { out: jsonOut, code } = runDoctor(['--json', ...DOCTOR_SKIP_ARGS]);
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

  // 11b. `--skip` 机制本身：跳过生效 + 未知名字必须报错（拼错不能变成“假全绿”）
  {
    const skipped = runDoctor(['--json', '--skip', 'tmux,模型可用性']);
    let d = null;
    try { d = JSON.parse(skipped.out); } catch { /* asserted below */ }
    if (!d?.checks) fail('doctor --json --skip: 输出不可解析');
    else if (d.checks.some(c => c.name === 'tmux')) fail('doctor --skip tmux 未生效（tmux 检查仍在输出里）');
    else if (d.summary.pass + d.summary.fail + d.summary.warn !== d.checks.length) fail('doctor --skip 后 summary 计数与 checks 不符');
    else ok('doctor --skip <name> 生效，且 --json schema 仍自洽');
    const bad = runDoctor(['--json', '--skip', 'tmux,model-availability']);
    let db = null;
    try { db = JSON.parse(bad.out); } catch { /* asserted below */ }
    if (bad.code === 0) fail('doctor --skip <未知检查项> 仍 exit 0（拼错会静默变成假全绿）');
    else if (!db?.checks?.some(c => c.name === '--skip' && c.status === 'fail')) fail('doctor --skip <未知检查项> 未产生 fail 检查项（未明确指出拼错）');
    else ok('doctor --skip <未知检查项> → exit 非 0 且明确指出未知项');
    const fileCheck = runDoctor(['--json', '--skip', 'tmux,模型可用性']);
    let df = null;
    try { df = JSON.parse(fileCheck.out); } catch { /* asserted below */ }
    if (!df?.checks?.some(c => c.name === '.gitignore')) fail('doctor --skip 后仓库类检查（.gitignore）不应被跳过');
    else ok('doctor --skip 只跳过点名项（仓库类检查仍在）');
  }
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
      out = execFileSync('node', [path.join(ROOT, 'scripts/doctor.mjs'), '--json', ...DOCTOR_SKIP_ARGS], {
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

// 16. 终态必须可撤销：needs_human/failed 的人工恢复入口（issue #19）
//     现实：#14 合并已成功却永久停在 needs_human，上游 #18 因 `gh pr create` 失败
//     卡在 needs_human；两类都死胡同，唯一逃生口是未文档化且**会绕过 /reject**
//     的 `run --force`。修法 = 纯确定性的 `retry` 子命令：显式人工动作、可审计
//     （retries/lastError/日志/issue 评论）、且绝不绕过否决。
{
  const problems = [];

  // 16a. retryReset 全分支（纯函数：不得修改入参）
  if (typeof lib.retryReset !== 'function') fail('templates/lib.mjs 缺少 retryReset()');
  else {
    const nh = { status: 'needs_human', pr: 15, branch: 'agent/14', round: 2, fixes: 1, error: 'merge result unknown', title: 't' };
    const r = lib.retryReset(nh);
    if (!r?.ok) problems.push(`needs_human(有 PR) 应可重试，实得 ${JSON.stringify(r)}`);
    else {
      const n = r.next;
      if (n.status !== 'pr_open') problems.push(`needs_human(有 PR) → status 期望 pr_open 实得 ${n.status}`);
      for (const [k, v] of [['pr', 15], ['branch', 'agent/14'], ['round', 2], ['fixes', 1], ['title', 't']]) {
        if (n[k] !== v) problems.push(`retryReset 丢失字段 ${k}（期望 ${JSON.stringify(v)} 实得 ${JSON.stringify(n[k])}）`);
      }
      if (n.retries !== 1) problems.push(`retries 期望 1 实得 ${JSON.stringify(n.retries)}`);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(String(n.retriedAt))) problems.push(`retriedAt 不是 ISO 时间: ${n.retriedAt}`);
      if (n.previousStatus !== 'needs_human') problems.push(`previousStatus 期望 needs_human 实得 ${n.previousStatus}`);
      if ('error' in n) problems.push(`error 未清空（应为 undefined）: ${JSON.stringify(n.error)}`);
      if (n.lastError !== 'merge result unknown') problems.push(`旧 error 未移入 lastError: ${JSON.stringify(n.lastError)}`);
    }
    if (nh.status !== 'needs_human' || 'retries' in nh) problems.push('retryReset 修改了入参（必须是纯函数）');

    const two = lib.retryReset({ status: 'failed', pr: 7, fixes: 2 });
    if (!two?.ok) problems.push(`failed 应可重试，实得 ${JSON.stringify(two)}`);
    else {
      if (two.next.status !== 'pr_open') problems.push(`failed(有 PR) → status 期望 pr_open 实得 ${two.next.status}`);
      if (two.next.fixes !== 2) problems.push(`failed 重试丢失 fixes: ${JSON.stringify(two.next)}`);
      if ('lastError' in two.next) problems.push('无 error 时不应凭空生成 lastError');
    }

    // 无 PR 的 needs_human → `new`（实现入口必须接受 new，否则永久卡在 waiting_pr）
    const noPr = lib.retryReset({ status: 'needs_human', error: 'gh pr create failed: must be a collaborator' });
    if (!noPr?.ok) problems.push(`needs_human(无 PR) 应可重试，实得 ${JSON.stringify(noPr)}`);
    else {
      if (noPr.next.status !== 'new') problems.push(`needs_human(无 PR) → status 期望 new 实得 ${noPr.next.status}`);
      if (noPr.next.lastError !== 'gh pr create failed: must be a collaborator') problems.push('无 PR 分支未保留 lastError');
    }

    // 累加计数（第 N 次重试）
    const again = lib.retryReset({ status: 'failed', pr: 1, retries: 4 });
    if (again?.next?.retries !== 5) problems.push(`retries 累加期望 5 实得 ${JSON.stringify(again?.next?.retries)}`);

    // 拒绝分支：merged / rejected / blocked / pr_open / 无记录 → ok:false, reason 非空, 无 next
    const rejects = [['merged', { status: 'merged', pr: 3 }], ['rejected', { status: 'rejected', pr: 3 }],
      ['blocked', { status: 'blocked' }], ['pr_open', { status: 'pr_open', pr: 3 }], ['无记录', undefined], ['空对象', {}]];
    for (const [label, prev] of rejects) {
      let x;
      try { x = lib.retryReset(prev); } catch (e) { problems.push(`retryReset(${label}) 抛错: ${e.message}`); continue; }
      if (x?.ok !== false) problems.push(`retryReset(${label}) 期望 ok:false 实得 ${JSON.stringify(x)}`);
      if (x && 'next' in x) problems.push(`retryReset(${label}) 拒绝时不得返回 next`);
      if (typeof x?.reason !== 'string' || !x.reason) problems.push(`retryReset(${label}) 拒绝时必须给出 reason`);
    }

    // 重试后的状态必须仍被 watch 取活（不是终态），且 needs_human 仍被跳过（回归）
    const issues = [{ number: 9, labels: ['agent-approved'] }];
    for (const st of ['new', 'pr_open']) {
      const got = lib.selectPendingIssues(issues, { 9: { status: st } }).map(i => i.number);
      if (JSON.stringify(got) !== '[9]') problems.push(`selectPendingIssues(${st}) 应包含 #9 实得 ${JSON.stringify(got)}`);
    }
    const stillSkipped = lib.selectPendingIssues(issues, { 9: { status: 'needs_human' } }).map(i => i.number);
    if (stillSkipped.length) problems.push('needs_human 仍应被 watch 跳过（重试是人工动作，不是自动循环）');

    problems.length ? fail(`retryReset: ${problems.join('; ')}`) : ok('retryReset: needs_human/failed → pr_open|new（保留 pr/round/fixes，retries+1，error→lastError）；merged/rejected/blocked/pr_open/无记录 一律拒绝');
  }

  // 16b. formatRetryList 只列 needs_human/failed（「哪些卡住了」可发现）
  if (typeof lib.formatRetryList !== 'function') fail('templates/lib.mjs 缺少 formatRetryList()');
  else {
    const lines = lib.formatRetryList({
      12: { status: 'needs_human', pr: 15, error: 'merge result\nunknown' },
      7: { status: 'failed', pr: null },
      3: { status: 'merged', pr: 4 },
      4: { status: 'pr_open', pr: 5 },
    });
    const text = lines.join('\n');
    const miss = [];
    if (!/#12 needs_human pr=15 retries=0 error=merge result unknown/.test(text)) miss.push('needs_human 行格式');
    if (!/#7 failed pr=- retries=0 error=-/.test(text)) miss.push('failed 行格式（多行 error 需压平）');
    if (/#3\b/.test(text) || /#4\b/.test(text)) miss.push('merged/pr_open 不应出现在列表');
    // 按 issue 号排序，便于人工扫
    if (lines.length !== 2 || !lines[0].startsWith('#7') || !lines[1].startsWith('#12')) miss.push(`排序/条数异常: ${JSON.stringify(lines)}`);
    if (lib.formatRetryList({}).length !== 0) miss.push('空状态应返回空列表');
    miss.length ? fail(`formatRetryList: ${miss.join('; ')}`) : ok('formatRetryList: 只列 needs_human/failed（按 issue 号排序，error 压平）');
  }

  // 16c. pipeline 的 retry 分支：走纯函数、否决优先、拒绝即 exit 2、绝不 force
  {
    const pipe = readFileSync(path.join(ROOT, 'templates/pipeline.mjs'), 'utf8');
    const blk = pipe.split("cmd === 'retry'")[1]?.split("cmd === 'review'")[0] || '';
    const miss = [];
    if (!blk) miss.push("缺少 retry 子命令分支");
    if (!/retryReset\(/.test(blk)) miss.push('未走 retryReset()');
    if (!/isRejectedIssue\(/.test(blk)) miss.push('未检查 agent-rejected 标签');
    if (!/process\.exit\(2\)/.test(blk)) miss.push('拒绝时未 exit 2');
    if (!/--list/.test(blk) || !/formatRetryList\(/.test(blk)) miss.push('缺少 --list');
    // 只允许「注释里提到 force」；代码里出现 force 参数/变量即视为绕过否决的隐患
    const blkCode = blk.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    if (/\bforce\b/.test(blkCode)) miss.push('retry 分支代码里出现 force（会绕过 /reject）');
    const iReset = blk.indexOf('retryReset(');
    const iVeto = blk.indexOf('isRejectedIssue(');
    const iSave = blk.indexOf('state.save(');
    if (iSave === -1) miss.push('未写 state.json');
    else if (iReset === -1 || iReset > iSave) miss.push('可重试判定必须在写状态之前');
    else if (iVeto === -1 || iVeto > iSave) miss.push('/reject 检查必须在写状态之前（先否决，后复位）');
    // 无 PR 的复位目标是 `new` —— 实现入口必须接受它
    if (!/cur\.status === 'new'/.test(pipe)) miss.push("实现入口未接受 status 'new'（重试会永久卡在 waiting_pr）");
    miss.length ? fail(`pipeline retry 子命令: ${miss.join('; ')}`) : ok('pipeline retry: 纯函数判定 + 先查 /reject 再写状态 + 拒绝即 exit 2 + 无 force');

    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg.scripts?.['agent:retry'] === 'node .agent/pipeline.mjs retry') ok('package.json 提供 npm run agent:retry');
    else fail(`package.json 缺少 "agent:retry": "node .agent/pipeline.mjs retry"（实得 ${JSON.stringify(pkg.scripts?.['agent:retry'])}）`);
  }

  // 16d. CLI 端到端：在 mkdtemp 里跑**真实** pipeline.mjs（STATE_FILE 由文件位置推导，
  //      天然指向临时目录）+ 假 `gh`（离线、无副作用、不打真评论）。
  {
    const mkHarness = (stateObj, labelsJson) => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-retry-'));
      mkdirSync(path.join(tmp, '.agent'), { recursive: true });
      copyFileSync(path.join(ROOT, 'templates/pipeline.mjs'), path.join(tmp, '.agent/pipeline.mjs'));
      copyFileSync(path.join(ROOT, 'templates/lib.mjs'), path.join(tmp, '.agent/lib.mjs'));
      writeFileSync(path.join(tmp, '.agent/state.json'), JSON.stringify(stateObj, null, 2));
      const bin = path.join(tmp, 'bin');
      mkdirSync(bin, { recursive: true });
      const ghPath = path.join(bin, 'gh');
      writeFileSync(ghPath, "#!/usr/bin/env node\nconst a = process.argv.slice(2);\nif (a[0] === 'issue' && (a[1] === 'view' || a[1] === 'comment')) { if (a[1] === 'view') process.stdout.write(process.env.FAKE_GH_ISSUE || '{\\\"labels\\\":[]}'); process.exit(0); }\nprocess.exit(1);\n");
      chmodSync(ghPath, 0o755);
      return tmp;
    };
    const runRetry = (tmp, args, labelsJson) => {
      try {
        const out = execFileSync('node', [path.join(tmp, '.agent/pipeline.mjs'), 'retry', ...args], {
          cwd: tmp, encoding: 'utf8', stdio: 'pipe',
          env: { ...process.env, PATH: path.join(tmp, 'bin') + path.delimiter + (process.env.PATH || ''), FAKE_GH_ISSUE: labelsJson || '{"labels":[]}' },
        });
        return { code: 0, out };
      } catch (e) {
        return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
      }
    };
    const tidies = [];
    try {
      // (1) merged → exit 2，且 state.json 字节级不变
      const sMerged = { 3: { status: 'merged', pr: 9, round: 1 } };
      const t1 = mkHarness(sMerged); tidies.push(t1);
      const before = readFileSync(path.join(t1, '.agent/state.json'), 'utf8');
      const r1 = runRetry(t1, ['--issue', '3']);
      const after = readFileSync(path.join(t1, '.agent/state.json'), 'utf8');
      if (r1.code !== 2) fail(`retry --issue <merged> 应 exit 2，实得 ${r1.code}`);
      else if (before !== after) fail('retry 拒绝时修改了 state.json（必须字节级不变）');
      else ok('retry --issue <merged>: exit 2 + state.json 字节级不变');

      // (2) 带 agent-rejected 标签 → exit 2，不写状态
      const t2 = mkHarness({ 5: { status: 'needs_human', pr: 8 } }); tidies.push(t2);
      const b2 = readFileSync(path.join(t2, '.agent/state.json'), 'utf8');
      const r2 = runRetry(t2, ['--issue', '5'], '{"labels":[{"name":"agent-approved"},{"name":"agent-rejected"}]}');
      const a2 = readFileSync(path.join(t2, '.agent/state.json'), 'utf8');
      if (r2.code !== 2) fail(`retry 带 agent-rejected 标签应 exit 2，实得 ${r2.code}`);
      else if (b2 !== a2) fail('retry 检测到 /reject 后仍写了 state.json');
      else ok('retry 带 agent-rejected 标签: exit 2 + 不写状态（绝不绕过否决）');

      // (3) needs_human（有 PR）→ 成功复位：pr_open，pr/round/fixes 原值保留，error→lastError
      const t3 = mkHarness({ 7: { status: 'needs_human', pr: 15, branch: 'agent/7', round: 2, fixes: 1, error: 'merge result unknown', title: 'x' } });
      tidies.push(t3);
      const r3 = runRetry(t3, ['--issue', '7']);
      const st3 = JSON.parse(readFileSync(path.join(t3, '.agent/state.json'), 'utf8'))['7'];
      const bad3 = [];
      if (r3.code !== 0) bad3.push(`exit ${r3.code}: ${r3.err}`);
      if (st3.status !== 'pr_open') bad3.push(`status=${st3.status}`);
      for (const [k, v] of [['pr', 15], ['branch', 'agent/7'], ['round', 2], ['fixes', 1], ['title', 'x']]) if (st3[k] !== v) bad3.push(`${k}=${JSON.stringify(st3[k])}`);
      if (st3.retries !== 1) bad3.push(`retries=${st3.retries}`);
      if (st3.lastError !== 'merge result unknown') bad3.push(`lastError=${JSON.stringify(st3.lastError)}`);
      if ('error' in st3) bad3.push('error 未清空');
      if (!existsSync(path.join(t3, '.agent/logs/issue-7.md'))) bad3.push('未写 .agent/logs/issue-7.md（审计缺失）');
      bad3.length ? fail(`retry --issue <needs_human>: ${bad3.join('; ')}`) : ok('retry --issue <needs_human>: pr_open + 保留 pr/branch/round/fixes + retries=1 + error→lastError + 写日志');

      // (4) failed 且无 PR → `new`（否则永久卡在 waiting_pr），且接受裸 issue 号
      const t4 = mkHarness({ 9: { status: 'failed', error: 'tests' } }); tidies.push(t4);
      const r4 = runRetry(t4, ['9']);
      const st4 = JSON.parse(readFileSync(path.join(t4, '.agent/state.json'), 'utf8'))['9'];
      if (r4.code !== 0) fail(`retry 9（裸号）应 exit 0，实得 ${r4.code}: ${r4.err}`);
      else if (st4.status !== 'new') fail(`retry failed(无 PR) → status 期望 new 实得 ${st4.status}`);
      else ok('retry <裸号>: failed(无 PR) → new（实现入口会接手）');

      // (5) --list 列出全部 needs_human/failed，不列 merged
      const t5 = mkHarness({ 2: { status: 'needs_human', pr: 4, error: 'boom' }, 6: { status: 'failed' }, 8: { status: 'merged' } }); tidies.push(t5);
      const r5 = runRetry(t5, ['--list']);
      const out5 = r5.out || '';
      if (r5.code !== 0) fail(`retry --list 应 exit 0，实得 ${r5.code}: ${r5.err}`);
      else if (!out5.includes('#2 needs_human') || !out5.includes('#6 failed')) fail(`retry --list 未列出 needs_human/failed: ${out5.trim()}`);
      else if (/#8\b/.test(out5)) fail('retry --list 不应列出 merged 条目');
      else ok('retry --list: 列出全部 needs_human/failed（可发现），排除 merged');
    } catch (e) {
      fail(`retry CLI 端到端: ${e.message}`);
    } finally {
      for (const t of tidies) rmSync(t, { recursive: true, force: true });
    }
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
