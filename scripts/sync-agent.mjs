#!/usr/bin/env node
// sync-agent.mjs — copy templates/ → live .agent/ copies (dogfood hygiene).
// The maintenance repo keeps templates/ (what users install) and .agent/ (the
// live loop that maintains this repo) byte-identical. Edit templates/, run
// `npm run sync:agent`, then `npm test`.
import { copyFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

let n = 0;
for (const [src, dest] of PAIRS) {
  const s = path.join(ROOT, src);
  if (!existsSync(s)) { console.warn('skip (missing): ' + src); continue; }
  const d = path.join(ROOT, dest);
  mkdirSync(path.dirname(d), { recursive: true });
  copyFileSync(s, d);
  if (dest.endsWith('.sh')) chmodSync(d, 0o755);
  console.log(`${src} → ${dest}`);
  n++;
}
console.log(`\nsynced ${n} file(s). Now run: npm test`);
