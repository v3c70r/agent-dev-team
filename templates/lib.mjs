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

// Prepare the branch Agent A implements on.
// FIRST round: branch off `origin/<base>`. FIX round: the PR branch already
// exists upstream, so we MUST continue on it — `git checkout -B <branch>
// origin/<base>` would silently RESET it back to base (dropping the previous
// round's commits) and turn the follow-up `git push` into a non-fast-forward
// reject. This is the single, testable place where that decision is made
// (lesson #18). `fetch origin` (all refs) is required so `origin/<branch>`
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
// so state.json could not remember that any fix round happened (lesson #18).
export function mergeIssueState(prev, patch) {
  return { ...(prev || {}), ...patch };
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
