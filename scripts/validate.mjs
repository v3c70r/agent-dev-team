#!/usr/bin/env node
// validate.mjs — the maintenance repo's own "build + test" (dogfooded by Agent C).
// Checks: syntax of all mjs/sh, SKILL.md frontmatter, template completeness,
// doctor self-check, and that the live .agent/ copies match templates/ (no drift).
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
