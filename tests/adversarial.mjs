// Adversarial self-tests for SPEC sentences the practice set does not show.
// Run: node tests/adversarial.mjs  (from repo root). Exits 0 iff all pass.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts');
let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name} ${extra}`); }
}
function runCase(files, argv, stdin = '') {
  const dir = mkdtempSync(join(tmpdir(), 'mend-adv-'));
  try {
    for (const [p, text] of Object.entries(files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...argv], { cwd: dir, input: stdin, encoding: 'utf8', timeout: 10000 });
    const after = {};
    for (const p of Object.keys(files)) {
      const f = join(dir, ...p.split('/'));
      after[p] = existsSync(f) ? readFileSync(f, 'utf8') : null;
    }
    return { exit: r.status, stdout: r.stdout ?? '', after };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 1. Tier-2 re-indent with mixed indents (SEARCH/REPLACE).
// File indented with 4 spaces; O written with 2 spaces (tier 2); N line starting
// with P (2 spaces) gets F (4 spaces); N line with a different indent is as-is.
{
  const patch = 'a.py\n<<<<<<< SEARCH\n  x = 1\n  y = 2\n=======\n  x = 9\n\ty = 8\nz = 7\n>>>>>>> REPLACE\n';
  const r = runCase({ 'a.py': '    x = 1\n    y = 2\n', 'p.txt': patch }, ['p.txt']);
  check('1 tier2-reindent-mixed', r.exit === 0 && r.after['a.py'] === '    x = 9\n\ty = 8\nz = 7\n',
    `exit=${r.exit} out=${JSON.stringify(r.stdout)} file=${JSON.stringify(r.after['a.py'])}`);
}

// 2. Empty-O insert at end-of-file with a '\' marker: result has no final break.
{
  const patch = 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -2,0 +3,2 @@\n+last1\n+last2\n\\ No newline at end of file\n';
  const r = runCase({ 'f.txt': 'one\ntwo\n', 'p.diff': patch }, ['p.diff']);
  check('2 empty-O-insert-EOF-noeol', r.exit === 0 && r.after['f.txt'] === 'one\ntwo\nlast1\nlast2',
    `exit=${r.exit} out=${JSON.stringify(r.stdout)} file=${JSON.stringify(r.after['f.txt'])}`);
}

// 3. V4A cursor across two chunks sharing the same anchor text.
{
  const patch = '*** Begin Patch\n*** Update File: d.txt\n@@ dup\n-AAA\n+AAA1\n@@ dup\n-AAA\n+AAA2\n*** End Patch\n';
  const r = runCase({ 'd.txt': 'dup\nAAA\nmid\ndup\nAAA\ntail\n', 'p.txt': patch }, ['p.txt']);
  check('3 v4a-cursor-shared-anchor', r.exit === 0 && r.after['d.txt'] === 'dup\nAAA1\nmid\ndup\nAAA2\ntail\n',
    `exit=${r.exit} out=${JSON.stringify(r.stdout)} file=${JSON.stringify(r.after['d.txt'])}`);
}

// 4. Unified hunk with a blank context line lacking its leading space.
{
  const patch = 'diff --git a/g.txt b/g.txt\n--- a/g.txt\n+++ b/g.txt\n@@ -1,3 +1,3 @@\n top\n\n-bottom\n+middle\n';
  const r = runCase({ 'g.txt': 'top\n\nbottom\n', 'p.diff': patch }, ['p.diff']);
  check('4 unified-blank-context-no-space', r.exit === 0 && r.after['g.txt'] === 'top\n\nmiddle\n',
    `exit=${r.exit} out=${JSON.stringify(r.stdout)} file=${JSON.stringify(r.after['g.txt'])}`);
}

// 5. --check with a failing edit: exit 1, files untouched.
{
  const patch = 'h.txt\n<<<<<<< SEARCH\nnope\n=======\nnew\n>>>>>>> REPLACE\n';
  const r = runCase({ 'h.txt': 'keep me\n', 'p.txt': patch }, ['--check', 'p.txt']);
  check('5 check-failing-untouched', r.exit === 1 && r.stdout === 'error: no-match h.txt\nfailed: 1 of 1 edits\n' && r.after['h.txt'] === 'keep me\n',
    `exit=${r.exit} out=${JSON.stringify(r.stdout)} file=${JSON.stringify(r.after['h.txt'])}`);
}

// 6. Unsafe path in a later edit after an earlier edit fails: both reported, in order.
{
  const patch = 'm.txt\n<<<<<<< SEARCH\nnope\n=======\nnew\n>>>>>>> REPLACE\n../evil.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n';
  const r = runCase({ 'm.txt': 'keep\n', 'p.txt': patch }, ['p.txt']);
  check('6 unsafe-after-failure', r.exit === 1 && r.stdout === 'error: no-match m.txt\nerror: unsafe ../evil.txt\nfailed: 2 of 2 edits\n' && r.after['m.txt'] === 'keep\n',
    `exit=${r.exit} out=${JSON.stringify(r.stdout)}`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
