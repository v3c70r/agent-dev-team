#!/usr/bin/env node
// validate.mjs — the maintenance repo's own "build + test" (dogfooded by Agent C).
// Checks: syntax of all mjs/sh, SKILL.md frontmatter, template completeness,
// doctor self-check, and that the live .agent/ copies match templates/ (no drift).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
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

// 13. Agent A 的修复轮必须基于 PR 现有分支（lesson #18）
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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
