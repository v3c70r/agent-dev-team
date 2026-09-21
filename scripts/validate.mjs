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
{
  try {
    execFileSync('node', [path.join(ROOT, 'scripts/doctor.mjs')], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    ok('doctor green');
  } catch (e) {
    const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
    fail(`doctor not green:\n${out}`);
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
