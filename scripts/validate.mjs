#!/usr/bin/env node
// validate.mjs — the maintenance repo's own "build + test" (dogfooded by Agent C).
// Checks: syntax of all mjs/sh, SKILL.md frontmatter, template completeness,
// doctor self-check, and that the live .agent/ copies match templates/ (no drift).
import { execFileSync, spawnSync } from 'node:child_process';
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

// 7d) **下发前令牌特征拦截**必须存在且真的会拦（lessons #28：真令牌曾被 shell 展开
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

  // 7d-2) `redactSecrets` 功能测试（issue #21）：脱敏后的文本**不含完整令牌**，
  //        能被 assertNoSecrets 放行，幂等，只留 4 位前缀，正常文本零误报。
  {
    if (typeof lib.redactSecrets !== 'function') fail('templates/lib.mjs 缺少 redactSecrets()');
    else {
      const tok = ['gho_' + 'A1b2'.repeat(9), 'github_pat_' + 'Z9'.repeat(15), 'sk-' + 'q7'.repeat(12), 'AKIA' + 'Q1'.repeat(8), 'xoxb-' + '12'.repeat(8)];
      const problems = [];
      for (const t of tok) {
        const line = `日志行/反馈正文里混进了凭据 ${t} 之后还有中文。`;
        const red = lib.redactSecrets(line);
        if (red.includes(t)) problems.push(`未脱敏 ${t.slice(0, 4)}…`);
        if (lib.countSecretMatches(red) !== 0) problems.push(`脱敏结果仍命中令牌特征 ${t.slice(0, 4)}…`);
        try { lib.assertNoSecrets(red); } catch (e) { problems.push(`assertNoSecrets(redactSecrets(x)) 未放行 ${t.slice(0, 4)}…: ${e.message}`); }
        if (lib.redactSecrets(red) !== red) problems.push(`redactSecrets 不幂等 ${t.slice(0, 4)}…`);
        // 只留 4 位前缀（足以辨认凭据类型），其余一律抹掉
        const marker = red.match(/<redacted:[^>]*>/);
        if (!marker) problems.push(`没有 <redacted:…> 标记 ${t.slice(0, 4)}…`);
        else if (marker[0].length > '<redacted:'.length + 4 + 1) problems.push(`脱敏标记暴露超过 4 位前缀: ${marker[0]}`);
        else if (!marker[0].startsWith(`<redacted:${t.slice(0, 4)}>`)) problems.push(`脱敏标记丢失类型前缀: ${marker[0]}`);
      }
      // 正常文本（中文 / URL / 形近单词）绝对不能误报
      const normal = [
        '普通正文，不含任何凭据。',
        'https://github.com/azumag/IRLight/issues/468',
        'task-oriented skill-oriented risk-oriented work',
        'sk-learn 和 sk- 开头的短词不算令牌',
        'gho_ 只是类型前缀，后面没有 16 位以上字符',
      ];
      for (const n of normal) {
        if (lib.redactSecrets(n) !== n) problems.push(`正常文本被误改: ${n} → ${lib.redactSecrets(n)}`);
        if (lib.countSecretMatches(n) !== 0) problems.push(`正常文本被误判为凭据: ${n}`);
      }
      // 多处命中都要脱敏，且计数正确
      const multi = `a ${tok[0]} b ${tok[2]}`;
      if (lib.countSecretMatches(multi) !== 2) problems.push(`countSecretMatches 多处命中计数错: ${lib.countSecretMatches(multi)}`);
      if (lib.countSecretMatches(lib.redactSecrets(multi)) !== 0) problems.push('多处命中未全部脱敏');
      problems.length
        ? fail(`redactSecrets: ${problems.join('; ')}`)
        : ok('redactSecrets: 脱敏后不含完整令牌 + assertNoSecrets 放行 + 幂等 + 只留 4 位前缀 + 正常文本零误报');
    }
  }
}

// 7e) **结构性 lint**：出站正文的防线不能靠「记得在三个地方加」（issue #21）。
//     每个 `'--body'` 调用点都必须在**同一行**出现 assertNoSecrets( 或 redactSecrets(，
//     新增调用点不包裹 → 这里直接红。规则二分：agent 自己撰写的正文硬拦截，
//     「必须留下审计记录」的通道（筛选判定 / issue 正文 / 上游 feedback / 日志）脱敏后发送。
const BODY_WRAPPERS = ['assertNoSecrets(', 'redactSecrets('];
const lintBodyCallSites = (src) => {
  const bad = [];
  String(src).split('\n').forEach((line, i) => {
    if (!/'--body'/.test(line)) return;
    if (!BODY_WRAPPERS.some(w => line.includes(w))) bad.push(i + 1);
  });
  return bad;
};
{
  const problems = [];
  // 破坏性自检：lint 自身必须能抓到裸调用（否则「绿」毫无意义）
  const synthetic = "gh(['issue', 'comment', '1', '--body', body]);\n";
  if (lintBodyCallSites(synthetic).length !== 1) problems.push('lint 自检失败：裸 `\'--body\'` 未被判定为违规');
  const syntheticOk = "gh(['issue', 'comment', '1', '--body', assertNoSecrets(body)]);\ngh(['issue', 'edit', '1', '--body', redactSecrets(b)]);\n";
  if (lintBodyCallSites(syntheticOk).length !== 0) problems.push('lint 自检失败：已包裹的调用被误报');

  for (const f of ['templates/pipeline.mjs', 'templates/pm/screen.mjs']) {
    const bad = lintBodyCallSites(readFileSync(path.join(ROOT, f), 'utf8'));
    if (bad.length) problems.push(`${f} 的 '--body' 调用点未包裹凭据防线（行 ${bad.join(',')}）`);
  }
  // 提示词的示范不得教事故写法（7b 只 grep 存在 --body-file，矛盾示范能长期存活）
  for (const dir of ['templates/prompts', 'templates/pm']) {
    for (const f of readdirSync(path.join(ROOT, dir)).filter(n => n.endsWith('.md'))) {
      const t = readFileSync(path.join(ROOT, dir, f), 'utf8');
      if (t.includes('--body "')) problems.push(`${dir}/${f} 仍含 \`--body "\` 事故写法（必须改 --body-file）`);
    }
  }
  problems.length ? fail(`出站正文 lint (7e): ${problems.join('; ')}`) : ok("出站正文 lint (7e): 每个 '--body' 调用点都被 assertNoSecrets/redactSecrets 包裹；提示词无 `--body \"` 示范");
}

// 7e-2) **终端收口 lint**（Agent B review 第 2 轮）：`sh()` 抛出的 `e.message` 里带
//       `execFileSync` 拼进来的 stderr 原文（远端 URL 内嵌凭据的报错），原样 console.warn/error
//       就进了 tmux 窗格 / CI 日志 / 截图。pipeline 必须在**模块级单一收口点**（cwarn/cerr）
//       过 redactSecrets，禁止直接调 console.warn/console.error。
const lintTerminalExit = (src) => {
  const bad = [];
  String(src).split('\n').forEach((line, i) => {
    if (!/console\.(warn|error)\(/.test(line)) return;
    bad.push(i + 1);
  });
  return bad;
};
{
  const problems = [];
  // 破坏性自检：lint 必须能抓到“把 e.message 直接打终端”
  if (lintTerminalExit("console.error(e.message);\n").length !== 1) problems.push('lint 自检失败：裸 console.error(e.message) 未被判定为违规');
  if (lintTerminalExit("cerr(e.message);\ncwarn('x', err);\n").length !== 0) problems.push('lint 自检失败：收口点调用被误报');
  const pipeSrc = readFileSync(path.join(ROOT, 'templates/pipeline.mjs'), 'utf8');
  const bad = lintTerminalExit(pipeSrc);
  if (bad.length) problems.push(`templates/pipeline.mjs 仍有裸 console.warn/error（行 ${bad.join(',')}）—— 请改用 cwarn/cerr`);
  if (!/function cwarn\(/.test(pipeSrc) || !/function cerr\(/.test(pipeSrc)) problems.push('templates/pipeline.mjs 缺少 cwarn/cerr 收口点');
  const wrapped = (pipeSrc.match(/\b(?:cwarn|cerr)\(/g) || []).length;
  if (wrapped < 10) problems.push(`cwarn/cerr 使用点过少（${wrapped}）——收口可能没接上`);
  // `description`：错误栈也必须过收口（main().catch 打完整 stack）
  if (!/main\(\)\.catch\(e => \{\s*cerr\(e\)/.test(pipeSrc.replace(/\n\s*/g, ' '))) problems.push('main().catch 未走 cerr（未捕获异常的完整 stack 会裸打终端）');
  problems.length
    ? fail(`终端出站 lint (7e-2): ${problems.join('; ')}`)
    : ok(`终端出站 lint (7e-2): pipeline 无裸 console.warn/error，全部走 cwarn/cerr（${wrapped} 处），main().catch 也过收口`);
}

// 7f) **离线端到端**：脱敏不只是纯函数。用假 `gh` 跑真实 pipeline（mkdir 临时仓）。
//     (1) `feedback` 子命令 → 上游 issue 的 title/body 均无完整令牌，且带上「已脱敏 N 处」
//     (2) `retry --issue N` → 落盘日志 .agent/logs/issue-N.md 无完整令牌
{
  const TOK = 'gho_' + 'S3cr3t'.repeat(6);
  const mkHarness = (stateObj) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-redact-'));
    mkdirSync(path.join(tmp, '.agent'), { recursive: true });
    copyFileSync(path.join(ROOT, 'templates/pipeline.mjs'), path.join(tmp, '.agent/pipeline.mjs'));
    copyFileSync(path.join(ROOT, 'templates/lib.mjs'), path.join(tmp, '.agent/lib.mjs'));
    writeFileSync(path.join(tmp, '.agent/state.json'), JSON.stringify(stateObj, null, 2));
    writeFileSync(path.join(tmp, '.agent/config.json'), JSON.stringify({ upstream: 'acme/agent-dev-team', feedbackOptIn: true }, null, 2));
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin, { recursive: true });
    const logFile = path.join(tmp, 'gh-calls.log');
    writeFileSync(logFile, '');
    const ghPath = path.join(bin, 'gh');
    writeFileSync(ghPath, [
      '#!/usr/bin/env node',
      "const a = process.argv.slice(2);",
      "const fs = require('node:fs');",
      "const log = (p) => { if (process.env.FAKE_GH_LOG) fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(p) + '\\n'); };",
      "if (a[0] === 'issue' && a[1] === 'list') { log(a); process.stdout.write('[]'); process.exit(0); }",
      "if (a[0] === 'issue' && a[1] === 'create') { log(a); process.exit(0); }",
      "if (a[0] === 'issue' && a[1] === 'comment') { log(a); process.exit(0); }",
      "if (a[0] === 'issue' && a[1] === 'view') { process.stdout.write(process.env.FAKE_GH_ISSUE || '{\"labels\":[]}'); process.exit(0); }",
      'process.exit(1);',
      '',
    ].join('\n'));
    chmodSync(ghPath, 0o755);
    return { tmp, logFile };
  };
  const run = (h, args) => {
    try {
      const out = execFileSync('node', [path.join(h.tmp, '.agent/pipeline.mjs'), ...args], {
        cwd: h.tmp, encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, PATH: path.join(h.tmp, 'bin') + path.delimiter + (process.env.PATH || ''), FAKE_GH_LOG: h.logFile },
      });
      return { code: 0, out };
    } catch (e) { return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') }; }
  };
  const tidies = [];
  try {
    // (1) 上游 feedback：跨仓库出站点，必须先脱敏再发
    const h1 = mkHarness({}); tidies.push(h1.tmp);
    const r1 = run(h1, ['feedback', `push 失败 ${TOK}`, `远端报错: remote https://x-access-token:${TOK}@github.com refused\n${'x'.repeat(10)}`]);
    const calls = readFileSync(h1.logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const creates = calls.filter(a => a[0] === 'issue' && a[1] === 'create');
    const problems = [];
    if (r1.code !== 0) problems.push(`feedback 子命令 exit ${r1.code}: ${r1.err}`);
    if (!creates.length) problems.push('没有调用 issue create（reportGap 未执行）');
    for (const a of creates) {
      const joined = a.join(' ');
      if (joined.includes(TOK)) problems.push('上游 feedback 正文/标题含完整令牌（跨仓库公开泄漏）');
      if (!joined.includes('<redacted:')) problems.push('上游 feedback 未见脱敏标记（无法确认脱敏生效）');
      const bodyArg = a[a.indexOf('--body') + 1] || '';
      const titleArg = a[a.indexOf('--title') + 1] || '';
      if (!/已自动脱敏 \d+ 处疑似凭据/.test(bodyArg)) problems.push('脱敏命中时正文未附「已自动脱敏 N 处」审计行');
      if (!/^\[skill-feedback\]/.test(titleArg)) problems.push('title 前缀被破坏: ' + titleArg);
    }
    problems.length ? fail(`reportGap 脱敏 (7f-1): ${problems.join('; ')}`)
      : ok('reportGap 脱敏 (7f-1): 上游 issue 的 title/body 均无完整令牌，且正文附「已自动脱敏 N 处」');

    // (2) 日志落盘也必须脱敏（人类排障会把日志贴进 issue）
    const h2 = mkHarness({ 7: { status: 'needs_human', pr: 5, error: `push failed for https://${TOK}@github.com/acme/x` } });
    tidies.push(h2.tmp);
    const r2 = run(h2, ['retry', '--issue', '7']);
    const logPath = path.join(h2.tmp, '.agent/logs/issue-7.md');
    const bad2 = [];
    if (r2.code !== 0) bad2.push(`retry exit ${r2.code}: ${r2.err}`);
    if (!existsSync(logPath)) bad2.push('未写 .agent/logs/issue-7.md');
    else {
      const text = readFileSync(logPath, 'utf8');
      if (text.includes(TOK)) bad2.push('.agent/logs/issue-N.md 含完整令牌（日志是出站点）');
      if (!text.includes('<redacted:')) bad2.push('日志未见脱敏标记');
      if (!/已脱敏 \d+ 处/.test(text)) bad2.push('日志未注明已脱敏处数');
    }
    bad2.length ? fail(`日志脱敏 (7f-2): ${bad2.join('; ')}`) : ok('日志脱敏 (7f-2): .agent/logs/issue-N.md 无完整令牌 + 留下脱敏痕迹');
  } catch (e) {
    fail(`脱敏端到端 (7f): ${e.message}`);
  } finally {
    for (const t of tidies) rmSync(t, { recursive: true, force: true });
  }
}

// 7g) **`docs/proposal-audit.md` 是硬出站点**（Agent B review #1）：它被 `git commit` +
//     `git push HEAD:<BASE>` 写进**提交历史**（不允许“发错了再删”）。W写入内容来自模型生成的
//     WHY / SPLIT_PLAN 与外部 issue 标题。这里跑**真实** `screen.mjs`（假 `gh`/`git`/`pi`，
//     离线）：假 pi 在 WHY 里吐令牌 → 断言**被 push 的那份文件**与终端输出均无完整令牌。
{
  const TOKA = 'ghp_' + 'Ab1'.repeat(8);   // 24 位，命中 GitHub PAT 形态
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-audit-'));
  try {
    mkdirSync(path.join(tmp, '.agent/pm'), { recursive: true });
    copyFileSync(path.join(ROOT, 'templates/pm/screen.mjs'), path.join(tmp, '.agent/pm/screen.mjs'));
    copyFileSync(path.join(ROOT, 'templates/lib.mjs'), path.join(tmp, '.agent/lib.mjs'));
    copyFileSync(path.join(ROOT, 'templates/pm/screener.md'), path.join(tmp, '.agent/pm/screener.md'));
    writeFileSync(path.join(tmp, '.agent/config.json'), JSON.stringify({ screenAutoApprove: false }, null, 2));
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin, { recursive: true });
    const capture = path.join(tmp, 'pushed-audit.md');
    const ghLog = path.join(tmp, 'gh-calls.log');
    writeFileSync(ghLog, '');

    // 假 gh：label create / issue list → 空；issue view → 给定 issue；comment/edit/close → 记下参数
    writeFileSync(path.join(bin, 'gh'), [
      '#!/usr/bin/env node',
      'const a = process.argv.slice(2);',
      "const fs = require('node:fs');",
      "const rec = () => fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + '\\n');",
      "if (a[0] === 'label') process.exit(0);",
      "if (a[0] === 'issue' && a[1] === 'list') { process.stdout.write('[]'); process.exit(0); }",
      "if (a[0] === 'issue' && a[1] === 'view') { process.stdout.write(process.env.FAKE_GH_ISSUE); process.exit(0); }",
      "if (a[0] === 'issue' && ['comment','edit','close'].includes(a[1])) { rec(); process.exit(0); }",
      'process.exit(1);',
      '',
    ].join('\n'));

    // 假 pi：返回一份 REJECT 的筛选结果，WHY 里**故意**带令牌（模拟模型复述提案原文/报错）
    writeFileSync(path.join(bin, 'pi'), [
      '#!/usr/bin/env node',
      'process.stdout.write([',
      "  'WHY: 提案正文里贴了 ' + process.env.FAKE_TOK + ' 这种令牌示例，属于凭据泄露风险。',",
      "  'SCOPE: templates/lib.mjs',",
      "  'TESTABILITY: 离线断言',",
      "  'RESULT: REJECT',",
      "].join('\\n') + '\\n');",
      'process.exit(0);',
      '',
    ].join('\n'));

    // 假 git：worktree add 建目录；push 时把待推送的 audit 文件**拷出来**（WT 会被 finally 删掉）
    writeFileSync(path.join(bin, 'git'), [
      '#!/usr/bin/env node',
      'const a = process.argv.slice(2);',
      "const fs = require('node:fs'); const p = require('node:path');",
      "if (a[0] === 'worktree' && a[1] === 'add') { fs.mkdirSync(a[3], { recursive: true }); process.exit(0); }",
      "if (a[0] === 'push') {",
      "  const f = p.join(process.cwd(), 'docs/proposal-audit.md');",
      "  if (fs.existsSync(f)) fs.writeFileSync(process.env.FAKE_GIT_CAPTURE, fs.readFileSync(f));",
      '  process.exit(0);',
      '}',
      "if (['fetch','add','commit','rebase','worktree','rev-parse','symbolic-ref','ls-remote','-c'].includes(a[0])) process.exit(0);",
      'process.exit(1);',
      '',
    ].join('\n'));
    for (const f of ['gh', 'pi', 'git']) chmodSync(path.join(bin, f), 0o755);

    const issueJson = JSON.stringify({ number: 42, title: `提案：日志里出现 ${TOKA} 的处置`, body: `正文也带 ${TOKA}`, labels: [] });
    let stdout = '';
    let code = 0;
    try {
      stdout = execFileSync('node', [path.join(tmp, '.agent/pm/screen.mjs'), '--issue', '42', '--force'], {
        cwd: tmp, encoding: 'utf8', stdio: 'pipe',
        env: {
          ...process.env,
          PATH: bin + path.delimiter + (process.env.PATH || ''),
          PI_BIN: path.join(bin, 'pi'),
          FAKE_GH_ISSUE: issueJson,
          FAKE_GH_LOG: ghLog,
          FAKE_GIT_CAPTURE: capture,
          FAKE_TOK: TOKA,
        },
      });
    } catch (e) { code = e.status ?? 1; stdout = String(e.stdout || '') + String(e.stderr || ''); }

    const problems = [];
    if (code !== 0) problems.push(`screen.mjs exit ${code}: ${stdout.split('\n').slice(-3).join(' ')}`);
    if (!existsSync(capture)) problems.push('没有捕获到被 push 的 docs/proposal-audit.md（recordRejection 未走到推送）');
    else {
      const audit = readFileSync(capture, 'utf8');
      if (audit.includes(TOKA)) problems.push('docs/proposal-audit.md（提交历史）含完整令牌');
      if (!audit.includes('<redacted:ghp_>')) problems.push('audit 未见脱敏标记');
      if (!/^## REJECT/m.test(audit) || !/- \d{4}-\d{2}-\d{2} \| #42 \|/.test(audit)) problems.push('audit 条目结构被破坏:`n' + audit.slice(0, 200));
    }
    if (stdout.includes(TOKA)) problems.push('screen.mjs 终端输出（/日志）含完整令牌');
    if (!/已脱敏/.test(stdout)) problems.push('脱敏命中时未在日志里留痕「已脱敏 N 处」');
    const ghCalls = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean);
    if (ghCalls.some(l => l.includes(TOKA))) problems.push('出站 gh 调用（评论/正文）含完整令牌');
    const commentCall = ghCalls.map(l => JSON.parse(l)).find(a => a[0] === 'issue' && a[1] === 'comment');
    if (!commentCall) problems.push('未发出判定评论（筛选判定不能丢）');
    else if (!commentCall.join(' ').includes('<redacted:')) problems.push('判定评论未见脱敏标记');

    problems.length
      ? fail(`审计出站脱敏 (7g): ${problems.join('; ')}`)
      : ok('审计出站脱敏 (7g): recordRejection 推送到 BASE 的 docs/proposal-audit.md（及判定评论/终端）无完整令牌');
  } catch (e) {
    fail(`审计出站脱敏 (7g): ${e.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 7h) **终端出站端到端**（Agent B review 第 2 轮）：`sh()` 把 stderr 原文拼进 `e.message`，
//     所以「gh 远端 URL 内嵌凭据」的报错会原样跑到 `console.warn/error`（tmux 窗格 /
//     CI 日志 / 截图）。这里用假 `gh` 往 stderr 写带令牌的错误，断言进程输出里没有完整令牌。
{
  const TOKT = 'gho_' + 'Stderr'.repeat(6);   // 36 位，命中 GitHub token 形态
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-term-'));
  try {
    mkdirSync(path.join(tmp, '.agent'), { recursive: true });
    copyFileSync(path.join(ROOT, 'templates/pipeline.mjs'), path.join(tmp, '.agent/pipeline.mjs'));
    copyFileSync(path.join(ROOT, 'templates/lib.mjs'), path.join(tmp, '.agent/lib.mjs'));
    // feedback 通道（opt-in + upstream）同时开启，用于覆盖 cwarn 路径（reportGap 的 catch）
    writeFileSync(path.join(tmp, '.agent/config.json'), JSON.stringify({ upstream: 'acme/agent-dev-team', feedbackOptIn: true }));
    writeFileSync(path.join(tmp, '.agent/state.json'), JSON.stringify({
      7: { status: 'needs_human', pr: 5, error: `merge failed: https://x-access-token:${TOKT}@github.com/acme/x` },
    }, null, 2));
    const bin = path.join(tmp, 'bin');
    mkdirSync(bin, { recursive: true });
    // 假 gh：每个调用都失败，并把“远端 URL 内嵌凭据”写到 stderr（node 会拼进 e.message）
    writeFileSync(path.join(bin, 'gh'), [
      '#!/usr/bin/env node',
      "process.stderr.write('remote: refusing: https://x-access-token:' + process.env.FAKE_TOK + '@github.com/acme/x\\n');",
      'process.exit(1);',
      '',
    ].join('\n'));
    chmodSync(path.join(bin, 'gh'), 0o755);
    // 假 git：同样吐带令牌的 stderr（覆盖 run/实现分支里的 git 报错路径）
    writeFileSync(path.join(bin, 'git'), [
      '#!/usr/bin/env node',
      "process.stderr.write('fatal: unable to access https://x-access-token:' + process.env.FAKE_TOK + '@github.com/acme/x\\n');",
      'process.exit(1);',
      '',
    ].join('\n'));
    chmodSync(path.join(bin, 'git'), 0o755);
    // spawnSync（不是 execFileSync）：成功退出时也要拿到 stderr —— cwarn 走 stderr，
    // 而 console.error/execFileSync 的成功路径不返回 stderr，会让断言变成假绿。
    const run = (args) => {
      const r = spawnSync('node', [path.join(tmp, '.agent/pipeline.mjs'), ...args], {
        cwd: tmp, encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, PATH: bin + path.delimiter + (process.env.PATH || ''), FAKE_TOK: TOKT },
      });
      return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
    };
    const problems = [];
    const cases = [
      // (1) `retry` 查标签失败 → cerr(e.message)（:769）
      ['retry', ['retry', '--issue', '7'], 2],
      // (2) `run` 失败 → main().catch(e => cerr(e))（完整 stack）
      ['run', ['run', '--issue', '7'], null],
      // (3) `status` 打印 state.json（error/lastError 是原始报错）
      ['status', ['status'], 0],
      // (4) `feedback` → reportGap 的 catch 走 cwarn(e.message)（gh 失败带令牌 stderr）
      ['feedback', ['feedback', 't', 'b'], 0],
    ];
    for (const [label, args, expectCode] of cases) {
      const r = run(args);
      const all = `${r.out || ''}\n${r.err || ''}`;
      if (expectCode !== null && r.code !== expectCode) problems.push(`${label}: exit ${r.code}（期望 ${expectCode}）`);
      if (expectCode === null && r.code === 0) problems.push(`${label}: 应该失败但 exit 0`);
      if (all.includes(TOKT)) problems.push(`${label}: 终端输出（stdout/stderr）含完整令牌`);
      if (!all.includes('<redacted:')) problems.push(`${label}: 终端输出未见脱敏标记（脱敏可能未生效）`);
    }
    problems.length
      ? fail(`终端出站脱敏 (7h): ${problems.join('; ')}`)
      : ok('终端出站脱敏 (7h): retry / run（完整 stack）/ status 的终端输出均无完整令牌（cwarn/cerr 收口）');
  } catch (e) {
    fail(`终端出站脱敏 (7h): ${e.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
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

    // 16b-2) `retry --list` 是**终端出站点**（Agent B review #2）：`state.error` 常是原始
    //        报错（远端 URL 内嵌凭据的 push 失败）→ 原样打终端就是 tmux 窗格/CI 日志泄漏。
    const TOKR = 'gho_' + 'T0k'.repeat(8);   // 24 位，命中 GitHub token 形态
    const missTok = [];
    const rawErr = `push failed for https://${TOKR}@github.com/acme/x`;
    const withTok = lib.formatRetryList({ 8: { status: 'needs_human', pr: 1, error: rawErr } }).join('\n');
    if (withTok.includes(TOKR)) missTok.push('--list 行含完整令牌（终端/CI 日志泄漏）');
    if (!withTok.includes('<redacted:')) missTok.push('--list 行未见脱敏标记');
    if (!withTok.includes('error=push failed for https://<redacted:gho_>@github.com/acme/x')) missTok.push(`脱敏破坏了行格式: ${withTok}`);
    if (lib.formatRetryList({ 8: { status: 'needs_human', error: 'plain error' } }).join('') !== '#8 needs_human pr=- retries=0 error=plain error') missTok.push('正常 error 文本被改动');
    missTok.length
      ? fail(`formatRetryList 脱敏: ${missTok.join('; ')}`)
      : ok('formatRetryList 脱敏: retry --list 不再把 state.error 里的令牌打到终端');
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

// 17. 模型不可用是「有截止时间的事实」（issue #25）
//     真实事故：主审查模型返回
//     `429 {"code":"1310","message":"…您的限额将在 2026-10-19 07:47:19 重置。"}`
//     回退生效了，但没有**记忆**：每个审查轮都重试一次已死的模型（PR #22 上 3 条
//     一模一样的 ⚠️ 评论）、上游两条同标题 feedback（#23/#24）、日志把回退轮记成主模型。
//     这里锁住四件事：解析重置时间 / 冷却跳过 / 一次中断只上报一次 / 如实记账。
{
  const RESET_ERR = '429: {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 2026-10-19 07:47:19 重置。"}';
  const problems = [];

  // 17a. 纯函数：parseModelResetAt / shouldUsePrimary（不修改入参）
  if (typeof lib.parseModelResetAt !== 'function' || typeof lib.shouldUsePrimary !== 'function') {
    fail('templates/lib.mjs 缺少 parseModelResetAt() / shouldUsePrimary()');
  } else {
    const now = new Date('2026-10-18T17:00:00Z');
    const nowMs = now.getTime();
    const LO = nowMs + 5 * 60_000;
    const HI = nowMs + 7 * 864e5;
    const inRange = (iso) => Number.isFinite(Date.parse(iso)) && Date.parse(iso) >= LO && Date.parse(iso) <= HI;

    // (1) #23/#24 的真实报错原文：必须解析出重置时间，且落在钳制区间内
    const real = lib.parseModelResetAt(RESET_ERR, now);
    if (!inRange(real?.until)) problems.push(`真实 429 报错解析出的 until 不在 [now+5min, now+7d] 内: ${JSON.stringify(real)}`);
    if (real?.kind !== 'reset-at') problems.push(`真实 429 报错解析类型期望 reset-at 实得 ${real?.kind}`);
    if (Math.abs(Date.parse(real?.until) - Date.parse('2026-10-19T07:47:19Z')) > 0) problems.push(`真实 429 报错应按 UTC 解释为 2026-10-19T07:47:19Z，实得 ${real?.until}`);

    // (2) 相对时间：try again in 20 minutes ≈ now+20min；Retry-After: 120 = now+120s（钳到下限）
    const rel = lib.parseModelResetAt('service busy, try again in 20 minutes', now);
    if (rel?.kind !== 'try-again') problems.push(`try-again 类型期望 try-again 实得 ${rel?.kind}`);
    if (Math.abs(Date.parse(rel?.until) - (nowMs + 20 * 60_000)) > 60_000) problems.push(`try again in 20 minutes 期望 ≈ now+20min 实得 ${rel?.until}`);
    const ra = lib.parseModelResetAt('HTTP 429 Too Many Requests; Retry-After: 120', now);
    if (ra?.kind !== 'retry-after') problems.push(`Retry-After 类型期望 retry-after 实得 ${ra?.kind}`);
    if (Date.parse(ra?.until) < nowMs + 60_000) problems.push(`Retry-After: 120 应至少冷却 1 分钟实得 ${ra?.until}`);
    const ep = lib.parseModelResetAt('X-RateLimit-Reset: 1760000000', now);
    if (ep?.kind !== 'epoch-reset') problems.push(`X-RateLimit-Reset 类型期望 epoch-reset 实得 ${ep?.kind}`);

    // (3) 解析不出/已过期 → 默认冷却（默认 30min）与钳制下限（now+5min）
    const dflt = lib.parseModelResetAt('模型暂时不可用', now);
    if (dflt?.kind !== 'default') problems.push(`无法解析时期望 kind=default 实得 ${dflt?.kind}`);
    if (Math.abs(Date.parse(dflt?.until) - (nowMs + 30 * 60_000)) > 60_000) problems.push(`默认冷却期望 ≈ now+30min 实得 ${dflt?.until}`);
    const past = lib.parseModelResetAt('限额将在 2020-01-01 00:00:00 重置', now);
    if (Date.parse(past?.until) !== LO) problems.push(`过去时间应钳到 now+5min，实得 ${past?.until}`);
    const far = lib.parseModelResetAt('reset at 2027-12-31T00:00:00Z', now);
    if (Date.parse(far?.until) !== HI) problems.push(`超过 7 天的重置时间应钳到 now+7d，实得 ${far?.until}`);
    const custom = lib.parseModelResetAt('boom', now, { cooldownMin: 90 });
    if (Math.abs(Date.parse(custom?.until) - (nowMs + 90 * 60_000)) > 60_000) problems.push(`cooldownMin 覆盖未生效: ${custom?.until}`);

    // (4) shouldUsePrimary 真值表（含 hasFallback:false → 恒 true 的安全边界）
    const healthEntry = { until: real.until, kind: real.kind, reason: 'x', observedAt: now.toISOString() };
    const entrySnapshot = JSON.stringify(healthEntry);
    const table = [
      ['冷却中（#23 真实重置时间）', healthEntry, {}, false],
      ['冷却中但无回退模型 → 仍用主模型（否则没模型可用）', healthEntry, { hasFallback: false }, true],
      ['无健康条目', null, {}, true],
      ['空对象', {}, {}, true],
      ['until 非法', { until: 'garbage' }, {}, true],
      ['until 缺失', { kind: 'default' }, {}, true],
      ['until 已过', { until: new Date(nowMs - 1000).toISOString() }, {}, true],
      ['until 恰好现在（边界，按已过处理）', { until: now.toISOString() }, {}, true],
      ['until 未来', { until: new Date(nowMs + 60_000).toISOString() }, {}, false],
    ];
    for (const [label, h, opts, expect] of table) {
      let got;
      try { got = lib.shouldUsePrimary(h, { now, ...opts }); }
      catch (e) { problems.push(`shouldUsePrimary(${label}) 抛错: ${e.message}`); continue; }
      if (got !== expect) problems.push(`shouldUsePrimary(${label}): 期望 ${expect} 实得 ${got}`);
    }
    if (JSON.stringify(healthEntry) !== entrySnapshot) problems.push('shouldUsePrimary 修改了入参 health（必须是纯函数）');
    if (now.toISOString() !== '2026-10-18T17:00:00.000Z') problems.push('parseModelResetAt 修改了入参 now（必须是纯函数）');
    if (lib.modelCooldownMinutes({}) !== 30 || lib.modelCooldownMinutes({ MODEL_COOLDOWN_MIN: '45' }) !== 45) problems.push('modelCooldownMinutes 默认值/覆盖不对');

    problems.length ? fail(`模型重置时间解析 (17a): ${problems.join('; ')}`)
      : ok('模型重置时间解析 (17a): #23 真实 429 原文 → reset-at 且落在 [now+5min, now+7d]；try-again/Retry-After/X-RateLimit-Reset/默认/钳制；shouldUsePrimary 真值表（无回退模型恒用主模型）+ 不修改入参');
  }

  // 17b. 结构性断言：健康检查必须在主模型 runPi 之前 / 成功删条目 / 去重 / 如实记账
  {
    const pipe = readFileSync(path.join(ROOT, 'templates/pipeline.mjs'), 'utf8');
    const miss = [];
    if (!/function loadModelHealth\(/.test(pipe) || !/function saveModelHealth\(/.test(pipe)) miss.push('缺少 loadModelHealth/saveModelHealth');
    if (!/process\.env\.MODEL_HEALTH_FILE/.test(pipe)) miss.push('MODEL_HEALTH_FILE 不可用 env 覆盖（测试/多环境无法隔离）');
    const save = pipe.split('function saveModelHealth(')[1]?.split('\n}')[0] || '';
    if (!/\.tmp/.test(save) || !/renameSync\(/.test(save)) miss.push('saveModelHealth 不是原子写（应写 .tmp 后 rename）');
    if (!/mkdirSync\(path\.dirname\(MODEL_HEALTH_FILE\)/.test(save)) miss.push('saveModelHealth 未自动创建目录');
    const load = pipe.split('function loadModelHealth(')[1]?.split('\n}')[0] || '';
    if (!/catch \{ return \{\}; \}/.test(load)) miss.push('loadModelHealth 解析失败未按空对象处理（fail-open 到用主模型）');
    const iHealth = pipe.indexOf('shouldUsePrimary(');
    const iPrimaryCall = pipe.indexOf('runPi(`agent-review-');
    if (iHealth === -1) miss.push('runReviewRound 未调用 shouldUsePrimary（冷却不会被跳过）');
    else if (iPrimaryCall === -1 || iHealth > iPrimaryCall) miss.push('健康检查没有发生在主模型 runPi( 之前');
    if (!/delete health\[primaryKey\]/.test(pipe)) miss.push('主模型成功后未删除健康条目');
    if (!/modelWarned/.test(pipe)) miss.push('缺少 modelWarned（每条 PR 每天只警告一次）');
    if (!/\.reviewedBy\s*=\s*res\.model/.test(pipe)) miss.push('approve 时未写 state[issue].reviewedBy = 实际模型');
    // Agent B review #1（真实 bug）：审查循环必须在 runReviewRound **之后**重读 state，
    // 否则随后的 state.save(旧对象)（整文件覆盖）会抹掉刚写的 modelWarned。
    const loop = pipe.split('for (let r = 0; r < maxRounds; r++) {')[1]?.split('// 3) TEST')[0] || '';
    const iRun = loop.indexOf('await runReviewRound(');
    const iReload = loop.indexOf('fresh = state.load()');
    if (iRun === -1) miss.push('审查循环未调用 runReviewRound（无法断言重读顺序）');
    else if (iReload === -1 || iReload < iRun) miss.push('审查循环在 runReviewRound 之前 load state → 随后的 save 会覆盖刚写入的 modelWarned（同一条 PR 会每轮重复警告）');
    if (!/reviewedBy/.test(pipe.split('async function finishMerge(')[1]?.split('\n}')[0] || '')) miss.push('finishMerge 的批准说明未带上审查模型');
    if (/verdict=\$\{verdict\} \(\$\{source\}, model=\$\{describeModel\(REVIEW\)\}\)/.test(pipe)) miss.push('日志仍把回退轮记成主模型（model= 必须取实际模型）');
    // reportGap 去重必须在 issue create 之前
    const gap = pipe.split('function reportGap(')[1]?.split('// ── tiny helpers ──')[0] || '';
    const iDedupe = gap.indexOf('recent.some(');
    const iCreate = gap.indexOf("'issue', 'create'");
    if (iDedupe === -1) miss.push('reportGap 缺少同标题去重（#23/#24 重复上报会重演）');
    else if (iCreate === -1 || iDedupe > iCreate) miss.push('reportGap 的去重必须发生在 issue create 之前');
    miss.length ? fail(`模型健康记忆结构 (17b): ${miss.join('; ')}`)
      : ok('模型健康记忆结构 (17b): 先查健康再 runPi / 成功后删条目 / modelWarned 去重 / reviewedBy 记账 / reportGap 发送前按标题去重');
  }

  // 17c. 离线端到端：真 pipeline + 假 pi（计数）+ 假 gh（记录出站）+ 临时 MODEL_HEALTH_FILE
  {
    const mkHarness = () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-health-'));
      mkdirSync(path.join(tmp, '.agent/prompts'), { recursive: true });
      copyFileSync(path.join(ROOT, 'templates/pipeline.mjs'), path.join(tmp, '.agent/pipeline.mjs'));
      copyFileSync(path.join(ROOT, 'templates/lib.mjs'), path.join(tmp, '.agent/lib.mjs'));
      copyFileSync(path.join(ROOT, 'templates/prompts/reviewer.md'), path.join(tmp, '.agent/prompts/reviewer.md'));
      writeFileSync(path.join(tmp, '.agent/state.json'), '{}');
      writeFileSync(path.join(tmp, '.agent/config.json'), JSON.stringify({ upstream: 'acme/agent-dev-team', feedbackOptIn: true }, null, 2));
      const bin = path.join(tmp, 'bin');
      mkdirSync(bin, { recursive: true });
      const ghLog = path.join(tmp, 'gh-calls.log');
      const piLog = path.join(tmp, 'pi-calls.log');
      writeFileSync(ghLog, ''); writeFileSync(piLog, '');
      writeFileSync(path.join(bin, 'gh'), [
        '#!/usr/bin/env node',
        'const a = process.argv.slice(2);',
        "const fs = require('node:fs');",
        "const rec = () => fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + '\\n');",
        "if (a[0] === 'issue' && a[1] === 'list') { process.stdout.write(process.env.FAKE_GH_UPSTREAM || '[]'); process.exit(0); }",
        "if (a[0] === 'issue' && a[1] === 'create') { rec(); process.exit(0); }",
        "if (a[0] === 'pr' && a[1] === 'comment') { rec(); process.exit(0); }",
        "if (a[0] === 'issue' && a[1] === 'comment') { rec(); process.exit(0); }",
        'process.exit(1);',
        '',
      ].join('\n'));
      chmodSync(path.join(bin, 'gh'), 0o755);
      // 假 pi：记录 (provider, model)；主模型（含 glm）在 FAKE_PI_MODE!=ok 时失败，
      // stderr 里是 #23 的真实额度报错原文（stdout 必须为空，否则 runPi 会当成功）
      writeFileSync(path.join(bin, 'pi'), [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        'const a = process.argv.slice(2);',
        "const model = a[a.indexOf('--model') + 1] || '(default)';",
        "const provider = a[a.indexOf('--provider') + 1] || '(default)';",
        "fs.appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify({ provider, model }) + '\\n');",
        "if (process.env.FAKE_PI_MODE !== 'ok' && String(model).includes('glm')) {",
        "  process.stderr.write(process.env.FAKE_PI_ERR + '\\n');",
        '  process.exit(1);',
        '}',
        "process.stdout.write('RESULT: APPROVE\\n');",
        'process.exit(0);',
        '',
      ].join('\n'));
      chmodSync(path.join(bin, 'pi'), 0o755);
      return { tmp, bin, ghLog, piLog, healthFile: path.join(tmp, 'model-health.json') };
    };
    const runReview = (h, extraEnv = {}) => {
      try {
        const r = spawnSync('node', [path.join(h.tmp, '.agent/pipeline.mjs'), 'review', '--pr', '1', '--issue', '1'], {
          cwd: h.tmp, encoding: 'utf8', stdio: 'pipe',
          env: {
            ...process.env,
            PATH: h.bin + path.delimiter + (process.env.PATH || ''),
            PI_BIN: path.join(h.bin, 'pi'),
            FAKE_GH_LOG: h.ghLog,
            FAKE_PI_LOG: h.piLog,
            FAKE_PI_ERR: RESET_ERR,
            MODEL_HEALTH_FILE: h.healthFile,
            REVIEW_PROVIDER: 'zai-coding-cn',
            REVIEW_MODEL: 'glm-5.3-flash',
            REVIEW_FALLBACK_PROVIDER: 'deepseek',
            REVIEW_FALLBACK_MODEL: 'deepseek-v4-flash',
            ...extraEnv,
          },
        });
        return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
      } catch (e) { return { code: 1, out: '', err: String(e.message) }; }
    };
    const ghCalls = (h) => readFileSync(h.ghLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const piCalls = (h) => readFileSync(h.piLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const prComments = (h) => ghCalls(h).filter(a => a[0] === 'pr' && a[1] === 'comment');
    const feedbacks = (h) => ghCalls(h).filter(a => a[0] === 'issue' && a[1] === 'create');
    const primaryCalls = (h) => piCalls(h).filter(c => String(c.model).includes('glm')).length;
    const readHealth = (h) => { try { return JSON.parse(readFileSync(h.healthFile, 'utf8')); } catch { return null; } };

    const tidies = [];
    try {
      const h = mkHarness(); tidies.push(h.tmp);
      const nowMs = Date.now();
      // ── 第 1 轮：主模型 429 → 写健康条目 + 1 条 PR 警告 + 1 条上游反馈
      const r1 = runReview(h);
      const p1 = [];
      if (r1.code !== 0) p1.push(`第 1 轮 exit ${r1.code}: ${r1.err.split('\n').slice(-2).join(' ')}`);
      const hc1 = readHealth(h);
      const entry = hc1?.['zai-coding-cn/glm-5.3-flash'];
      if (!entry) p1.push('健康文件未写入主模型条目');
      else {
        const t = Date.parse(entry.until);
        if (!Number.isFinite(t) || t < nowMs + 5 * 60_000 || t > nowMs + 7 * 864e5) p1.push(`until 不在钳制区间: ${entry.until}`);
        if (entry.kind !== 'reset-at') p1.push(`kind 期望 reset-at 实得 ${entry.kind}`);
        if (!entry.reason || entry.reason.length > 200) p1.push(`reason 缺失或超 200 字: ${String(entry.reason).length}`);
        if (!entry.observedAt) p1.push('缺少 observedAt');
      }
      if (prComments(h).length !== 1) p1.push(`PR 警告评论期望 1 条实得 ${prComments(h).length}`);
      if (!/审查模型不可用/.test(prComments(h)[0]?.join(' ') || '')) p1.push('PR 警告评论文案不含「审查模型不可用」');
      if (feedbacks(h).length !== 1) p1.push(`上游 feedback 期望 1 条实得 ${feedbacks(h).length}`);
      if (!/^\[skill-feedback\]/.test(String(feedbacks(h)[0]?.[feedbacks(h)[0].indexOf('--title') + 1] || ''))) p1.push('上游 feedback 标题缺 [skill-feedback] 前缀');
      if (!/VERDICT: APPROVE/.test(r1.out)) p1.push(`第 1 轮未按回退模型的结果输出 VERDICT: APPROVE: ${r1.out.split('\n').slice(-2).join(' ')}`);
      p1.length ? fail(`模型健康记忆端到端·第 1 轮 (17c): ${p1.join('; ')}`)
        : ok('模型健康记忆端到端·第 1 轮 (17c): 429 → 健康文件写入 until（钳制区间内）/ PR 仅 1 条警告 / 上游仅 1 条反馈');

      // ── 第 2 轮：主模型**零调用**，无第 2 条警告、无第 2 条反馈
      const r2 = runReview(h);
      const p2 = [];
      if (r2.code !== 0) p2.push(`第 2 轮 exit ${r2.code}: ${r2.err.split('\n').slice(-2).join(' ')}`);
      if (primaryCalls(h) !== 1) p2.push(`主模型总调用次数期望 1（第 1 轮那次）实得 ${primaryCalls(h)}`);
      if (piCalls(h).filter(c => String(c.model).includes('deepseek')).length !== 2) p2.push(`回退模型调用期望 2 次实得 ${piCalls(h).filter(c => String(c.model).includes('deepseek')).length}`);
      if (prComments(h).length !== 1) p2.push(`第 2 轮不应再发 PR 警告（期望 1 条实得 ${prComments(h).length}）`);
      if (feedbacks(h).length !== 1) p2.push(`第 2 轮不应再上报上游（期望 1 条实得 ${feedbacks(h).length}）`);
      const logText = existsSync(path.join(h.tmp, '.agent/logs/issue-1.md')) ? readFileSync(path.join(h.tmp, '.agent/logs/issue-1.md'), 'utf8') : '';
      if (!/主模型冷却中/.test(logText)) p2.push('日志缺少「主模型冷却中（至 …）」记录（跳过不可见）');
      if (!/model=deepseek\/deepseek-v4-flash/.test(logText)) p2.push('日志未如实记录本轮实际使用的回退模型');
      if (/model=zai-coding-cn\/glm-5\.3-flash(?!.*回退)/.test(logText.split('主模型冷却中')[1] || '')) p2.push('冷却轮的 verdict 行把回退记成了主模型');
      p2.length ? fail(`模型健康记忆端到端·第 2 轮 (17c): ${p2.join('; ')}`)
        : ok('模型健康记忆端到端·第 2 轮 (17c): 主模型 0 次调用（累计仅 1）/ 无第 2 条警告 / 无第 2 条反馈 / 日志显示“主模型冷却中”且记账为回退模型');

      // ── 第 3 轮：冷却到期 + 主模型恢复 → 健康条目被删除
      writeFileSync(h.healthFile, JSON.stringify({ 'zai-coding-cn/glm-5.3-flash': { until: new Date(Date.now() - 60_000).toISOString(), kind: 'reset-at', reason: 'x', observedAt: new Date().toISOString() } }, null, 2));
      runReview(h, { FAKE_PI_MODE: 'ok' });
      const p3 = [];
      if (primaryCalls(h) !== 2) p3.push(`冷却到期后应再调用主模型（累计期望 2 实得 ${primaryCalls(h)}）`);
      const hc3 = readHealth(h);
      if (hc3 && hc3['zai-coding-cn/glm-5.3-flash']) p3.push('主模型成功后健康条目未被删除');
      p3.length ? fail(`模型健康记忆端到端·恢复 (17c): ${p3.join('; ')}`)
        : ok('模型健康记忆端到端·恢复 (17c): 冷却到期后主模型被重试，成功后健康条目自动删除');

      // ── 上游去重：24h 内已有同标题 feedback → 只写本地日志，不发新 issue
      const h2 = mkHarness(); tidies.push(h2.tmp);
      const existing = JSON.stringify([{ number: 23, title: '[skill-feedback] 审查模型不可用（zai-coding-cn/glm-5.3-flash）' }]);
      const r4 = runReview(h2, { FAKE_GH_UPSTREAM: existing });
      const p4 = [];
      if (r4.code !== 0) p4.push(`第 4 轮 exit ${r4.code}: ${r4.err.split('\n').slice(-2).join(' ')}`);
      if (feedbacks(h2).length !== 0) p4.push(`同标题已存在时不应再发 upstream issue（实发 ${feedbacks(h2).length} 条）`);
      if (prComments(h2).length !== 1) p4.push(`PR 警告仍应照常发（期望 1 条实得 ${prComments(h2).length}）`);
      if (!/已有同标题/.test(r4.err)) p4.push('去重时未在日志/终端留痕');
      p4.length ? fail(`上游反馈去重 (17c): ${p4.join('; ')}`)
        : ok('上游反馈去重 (17c): 24h 内已有同标题 [skill-feedback] → 不再新建 issue（PR 警告不受影响）');
    } catch (e) {
      fail(`模型健康回忆端到端 (17c): ${e.message}`);
    } finally {
      for (const t of tidies) rmSync(t, { recursive: true, force: true });
    }
  }

  // 17d. `.agent/model-health.json` 必须在三处忽略清单里（否则 git add -A 会把它扫进 PR — lessons #9）
  {
    const where = [['.gitignore', readFileSync(path.join(ROOT, '.gitignore'), 'utf8')],
      ['templates/gitignore.snippet', readFileSync(path.join(ROOT, 'templates/gitignore.snippet'), 'utf8')],
      ['scripts/doctor.mjs 必需规则', readFileSync(path.join(ROOT, 'scripts/doctor.mjs'), 'utf8')]];
    const miss = where.filter(([, txt]) => !txt.includes('.agent/model-health.json')).map(([n]) => n);
    miss.length ? fail(`运行时文件忽略规则 (17d): ${miss.join(' / ')} 缺少 .agent/model-health.json`)
      : ok('运行时文件忽略规则 (17d): .gitignore / templates/gitignore.snippet / doctor 必需规则 均含 .agent/model-health.json');
  }

  // 17e. 离线端到端·**审查循环路径**（Agent B review #1）：17c 只跑单独的 `review` 子命令，
  //      每个进程只跑一轮，永远不进入 processIssueInner 的循环 → 掩盖了「循环里先 load、
  //      runReviewRound 写 modelWarned、随后 save(旧对象) 整文件覆盖」的 bug。
  //      这里用假 pi / 假 gh / 假 git 跑**真实** `run --issue`，同一进程连走 2 个审查轮，
  //      断言：警告评论只有 1 条、主模型只调 1 次、modelWarned 活到最后一轮、记账为回退模型。
  {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-loop-'));
    try {
      mkdirSync(path.join(tmp, '.agent/prompts'), { recursive: true });
      copyFileSync(path.join(ROOT, 'templates/pipeline.mjs'), path.join(tmp, '.agent/pipeline.mjs'));
      copyFileSync(path.join(ROOT, 'templates/lib.mjs'), path.join(tmp, '.agent/lib.mjs'));
      copyFileSync(path.join(ROOT, 'templates/prompts/reviewer.md'), path.join(tmp, '.agent/prompts/reviewer.md'));
      copyFileSync(path.join(ROOT, 'templates/prompts/implementer.md'), path.join(tmp, '.agent/prompts/implementer.md'));
      writeFileSync(path.join(tmp, '.agent/state.json'), '{}');
      writeFileSync(path.join(tmp, '.agent/config.json'), JSON.stringify({ upstream: 'acme/agent-dev-team', feedbackOptIn: true }, null, 2));
      const bin = path.join(tmp, 'bin');
      mkdirSync(bin, { recursive: true });
      const ghLog = path.join(tmp, 'gh-calls.log');
      const piLog = path.join(tmp, 'pi-calls.log');
      writeFileSync(ghLog, ''); writeFileSync(piLog, '');
      // 健康文件**故意写不进去**（指向一个目录：rename 会 EISDIR，读会 EISDIR）：
      // 这样才能让第 2 轮再次真的调用主模型（否则冷却会掩盖 modelWarned 被覆盖的 bug），
      // 「每条 PR 每天只警告一次」就完全由 modelWarned 承担 —— 正是 Agent B 抓到的路径。
      const healthFile = path.join(tmp, 'blocked');
      mkdirSync(healthFile, { recursive: true });

      writeFileSync(path.join(bin, 'gh'), [
        '#!/usr/bin/env node',
        'const a = process.argv.slice(2);',
        "const fs = require('node:fs');",
        "const rec = () => fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + '\\n');",
        "const out = (s) => { process.stdout.write(s); process.exit(0); };",
        "if (a[0] === 'issue' && a[1] === 'view') {",
        "  const j = a[a.indexOf('--json') + 1] || '';",
        "  if (j === 'labels') out(process.env.FAKE_GH_LABELS || '{\"labels\":[]}');",
        "  out(JSON.stringify({ number: 1, title: 't', body: '', labels: [] }));",
        '}',
        "if (a[0] === 'issue' && a[1] === 'list') out(process.env.FAKE_GH_UPSTREAM || '[]');",
        "if (a[0] === 'issue' && a[1] === 'create') { rec(); process.exit(0); }",
        "if (a[0] === 'issue' && a[1] === 'comment') { rec(); process.exit(0); }",
        "if (a[0] === 'pr' && a[1] === 'list') out(JSON.stringify([{ number: 1, headRefName: 'agent/1', title: 't' }]));",
        "if (a[0] === 'pr' && ['comment', 'review', 'merge'].includes(a[1])) { rec(); process.exit(0); }",
        "if (a[0] === 'pr' && a[1] === 'view') out(JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-19T00:00:00Z', headRefName: 'agent/1' }));",
        'process.exit(1);',
        '',
      ].join('\n'));
      chmodSync(path.join(bin, 'gh'), 0o755);

      // 假 git：一切成功；`ls-remote` 输出空（跳过残留分支清理）；`rev-parse --abbrev-ref` → master
      writeFileSync(path.join(bin, 'git'), [
        '#!/usr/bin/env node',
        'const a = process.argv.slice(2);',
        "if (a[0] === 'symbolic-ref') { process.stdout.write('master\\n'); process.exit(0); }",
        "if (a[0] === 'rev-parse' && a.includes('--abbrev-ref')) { process.stdout.write('master\\n'); process.exit(0); }",
        "if (a[0] === 'rev-parse') { process.stdout.write('0123456789abcdef0123456789abcdef01234567\\n'); process.exit(0); }",
        'process.exit(0);',
        '',
      ].join('\n'));
      chmodSync(path.join(bin, 'git'), 0o755);

      // 假 pi：主模型（glm）在每轮都失败（真 429 原文）；回退模型第 1 次要求修改、第 2 次批准
      writeFileSync(path.join(bin, 'pi'), [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        'const a = process.argv.slice(2);',
        "const sid = a[a.indexOf('--session-id') + 1] || '';",
        "const model = a[a.indexOf('--model') + 1] || '(default)';",
        "const log = process.env.FAKE_PI_LOG;",
        "const prev = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean) : [];",
        "fs.appendFileSync(log, JSON.stringify({ sid, model }) + '\\n');",
        "if (!String(sid).includes('review')) { process.stdout.write('implemented\\n'); process.exit(0); }",
        "if (String(model).includes('glm')) { process.stderr.write(process.env.FAKE_PI_ERR + '\\n'); process.exit(1); }",
        'const fallbackReviews = prev.filter((l) => {',
        '  try { const o = JSON.parse(l); return String(o.sid).includes("review") && !String(o.model).includes("glm"); } catch { return false; }',
        '}).length;',
        "process.stdout.write(fallbackReviews === 0 ? 'RESULT: REQUEST_CHANGES\\n' : 'RESULT: APPROVE\\n');",
        'process.exit(0);',
        '',
      ].join('\n'));
      chmodSync(path.join(bin, 'pi'), 0o755);

      const r = spawnSync('node', [path.join(tmp, '.agent/pipeline.mjs'), 'run', '--issue', '1'], {
        cwd: tmp, encoding: 'utf8', stdio: 'pipe',
        env: {
          ...process.env,
          PATH: bin + path.delimiter + (process.env.PATH || ''),
          PI_BIN: path.join(bin, 'pi'),
          FAKE_GH_LOG: ghLog,
          FAKE_PI_LOG: piLog,
          FAKE_PI_ERR: '429: ' + RESET_ERR,
          MODEL_HEALTH_FILE: healthFile,
          TEST_SKIP: '1',
          MAX_REVIEW_ROUNDS: '3',
          REVIEW_PROVIDER: 'zai-coding-cn',
          REVIEW_MODEL: 'glm-5.3-flash',
          REVIEW_FALLBACK_PROVIDER: 'deepseek',
          REVIEW_FALLBACK_MODEL: 'deepseek-v4-flash',
        },
      });

      const problems = [];
      const allOut = `${r.stdout || ''}\n${r.stderr || ''}`;
      if ((r.status ?? 1) !== 0) problems.push(`run --issue exit ${r.status}: ${allOut.split('\n').slice(-3).join(' ')}`);
      const calls = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      const prComments = calls.filter(a => a[0] === 'pr' && a[1] === 'comment');
      const warningComments = prComments.filter(a => /审查模型不可用/.test(a.join(' ')));
      if (warningComments.length !== 1) problems.push(`两轮审查后 PR 警告评论期望 1 条，实得 ${warningComments.length}（循环里的 state.save 覆盖了 modelWarned → 每轮重复警告）`);
      const piCalls = readFileSync(piLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      const reviewCalls = piCalls.filter(c => String(c.sid).includes('review'));
      const primaryCalls = reviewCalls.filter(c => String(c.model).includes('glm')).length;
      const fallbackCalls = reviewCalls.filter(c => String(c.model).includes('deepseek')).length;
      if (primaryCalls !== 2) problems.push(`健康文件不可用时两轮都应调用主模型（期望 2 次）实得 ${primaryCalls}`);
      if (fallbackCalls !== 2) problems.push(`回退模型审查调用期望 2 次实得 ${fallbackCalls}`);
      let st = {};
      try { st = JSON.parse(readFileSync(path.join(tmp, '.agent/state.json'), 'utf8')); } catch { problems.push('state.json 不可解析'); }
      const entry = st['1'] || {};
      if (entry.status !== 'merged') problems.push(`state#1.status 期望 merged 实得 ${entry.status}`);
      if (entry.reviewedBy !== 'deepseek/deepseek-v4-flash') problems.push(`reviewedBy 期望回退模型实得 ${JSON.stringify(entry.reviewedBy)}`);
      if (entry.reviewedViaFallback !== true) problems.push('reviewedViaFallback 未标为 true（回退未被标注）');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entry.modelWarned?.['zai-coding-cn/glm-5.3-flash'] || ''))) problems.push(`state#1.modelWarned 丢失（循环里的 state.save 覆盖了它）: ${JSON.stringify(entry.modelWarned)}`);
      const mergedComment = calls.filter(a => a[0] === 'issue' && a[1] === 'comment').map(a => a.join(' ')).find(t => /已合并/.test(t)) || '';
      if (!/审查模型：deepseek\/deepseek-v4-flash（回退）/.test(mergedComment)) problems.push(`合并评论未写明审查模型（含“（回退）”标注）: ${mergedComment.slice(0, 200)}`);
      problems.length ? fail(`模型健康记忆·审查循环端到端 (17e): ${problems.join('; ')}`)
        : ok('模型健康记忆·审查循环端到端 (17e): 同一进程两轮均调用主模型（健康文件不可写）→ PR 警告仍只有 1 条、modelWarned 存活、reviewedBy/合并评论标注为回退模型');
    } catch (e) {
      fail(`模型健康记忆·审查循环端到端 (17e): ${e.message}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
