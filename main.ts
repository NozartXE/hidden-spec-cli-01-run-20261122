// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; next: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines: its break (CRLF when the first LF follows a CR), its lines, whether it ends with a break. */
interface FileModel { br: string; lines: string[]; final: boolean; }
function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}
function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}
const trail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const lead = (s: string): string => { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; };
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trail(a) === trail(b);
  return stripBoth(a) === stripBoth(b);
}
function occurrences(fileLines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) if (!lineEq(fileLines[i + j]!, o[j]!, tier)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
/** First tier (0,1,2) with at least one occurrence at/after `from`; strict tries tier 0 only. */
function findTier(fileLines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(fileLines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}
/** Re-indent N lines at tier 2 (F/P leading-whitespace substitution); tiers 0/1 write N as-is. */
function reindent(n: string[], o: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2 || o.length === 0) return [...n];
  const f = lead(fileLines[pos]!);
  const p = lead(o[0]!);
  return n.map((l) => {
    if (l === '' || l.trim() === '') return l;
    return l.startsWith(p) ? f + l.slice(p.length) : l;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

interface UnifiedHunk { a: number; body: string[]; }
interface UnifiedSection { oldPath: string | null; newPath: string | null; create: boolean; del: boolean; hunks: UnifiedHunk[]; }

function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  const n = lines.length;
  const parseHunkHeader = (line: string, idx: number): number => {
    const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
    return Number(m[1]);
  };
  while (i < n) {
    const line = lines[i]!;
    let sec: UnifiedSection | null = null;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldPath: m[1]!, newPath: m[2]!, create: false, del: false, hunks: [] };
      i += 1;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldPath: stripPrefix(headerPath(line)), newPath: stripPrefix(headerPath(lines[i + 1]!)), create: false, del: false, hunks: [] };
      i += 2;
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
      continue;
    }
    sections.push(sec);
    // Header phase: before the first hunk.
    let inHeader = true;
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) break;
      if (inHeader && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        sec.oldPath = stripPrefix(headerPath(l));
        sec.newPath = stripPrefix(headerPath(lines[i + 1]!));
        i += 2;
        continue;
      }
      if (inHeader && l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('@@')) {
        inHeader = false;
        const a = parseHunkHeader(l, i);
        i += 1;
        const body: string[] = [];
        while (i < n) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\') || b === '') { body.push(b); i += 1; }
          else break;
        }
        while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
        sec.hunks.push({ a, body });
        continue;
      }
      if (!inHeader && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (inHeader) {
        if (l.startsWith('rename from ')) sec.oldPath = l.slice('rename from '.length).trim();
        else if (l.startsWith('rename to ')) sec.newPath = l.slice('rename to '.length).trim();
        else if (l.startsWith('new file mode')) sec.create = true;
        else if (l.startsWith('deleted file mode')) sec.del = true;
        i += 1;
        continue;
      }
      // After hunks: prose / fences ignored.
      i += 1;
    }
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.oldPath;
    const newPath = sec.newPath;
    const isCreate = oldPath === '/dev/null' || sec.create;
    const isDelete = newPath === '/dev/null' || sec.del;
    if (isCreate) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusNoEol = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k += 1) {
          const b = h.body[k]!;
          if (b.startsWith('+')) {
            plus.push(b.slice(1));
            lastPlusNoEol = (h.body[k + 1] ?? '') === '\\' || (h.body[k + 1] ?? '').startsWith('\\');
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const isMove = oldPath !== null && newPath !== null && oldPath !== newPath;
    const p = oldPath!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (isMove && !safe(newPath!)) throw new Fail('unsafe', newPath!);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    let model = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      model = applyUnifiedHunk(model, h, d, strict, p);
      d += hunkDelta(h);
    }
    const out = joinFile(model);
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(newPath!, out);
      tree.moves.push({ old: p, next: newPath! });
    } else {
      tree.now.set(p, out);
    }
  };
}

function hunkDelta(h: UnifiedHunk): number {
  let o = 0;
  let nn = 0;
  for (const b of h.body) {
    if (b.startsWith(' ') || b.startsWith('-')) o += 1;
    if (b.startsWith(' ') || b.startsWith('+')) nn += 1;
  }
  return nn - o;
}

/** Split a hunk body into O lines, N lines (with per-line context flags), and the no-EOL flag. */
function hunkParts(h: UnifiedHunk): { o: string[]; n: string[]; ctx: boolean[]; noEol: boolean } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: boolean[] = [];
  let noEol = false;
  let lastCtxOrPlus = -1;
  for (let k = 0; k < h.body.length; k += 1) {
    const b = h.body[k]!;
    if (b.startsWith(' ')) { o.push(b.slice(1)); n.push(b.slice(1)); ctx.push(true); lastCtxOrPlus = k; }
    else if (b === '') { o.push(''); n.push(''); ctx.push(true); lastCtxOrPlus = k; }
    else if (b.startsWith('-')) { o.push(b.slice(1)); }
    else if (b.startsWith('+')) { n.push(b.slice(1)); ctx.push(false); lastCtxOrPlus = k; }
    else if (b.startsWith('\\')) {
      if (lastCtxOrPlus === k - 1) noEol = true;
    }
  }
  return { o, n, ctx, noEol };
}

function applyUnifiedHunk(model: FileModel, h: UnifiedHunk, d: number, strict: boolean, path: string): FileModel {
  const { o, n, ctx, noEol } = hunkParts(h);
  const lines = model.lines;
  if (o.length === 0) {
    const at = Math.max(0, Math.min(h.a + d, lines.length));
    const atEnd = at === lines.length;
    const out = [...lines.slice(0, at), ...n, ...lines.slice(at)];
    return { br: model.br, lines: out, final: atEnd ? !noEol : model.final };
  }
  const found = findTier(lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - (h.a - 1 + d));
  for (const pos of found.occ) {
    const dist = Math.abs(pos - (h.a - 1 + d));
    if (dist < bestDist) { best = pos; bestDist = dist; }
  }
  const pos = best;
  const atEnd = pos + o.length === lines.length;
  // Build N: context lines as the file's own matched lines, other lines re-indented at tier 2.
  const ren = reindent(n.filter((_, k) => !ctx[k]), o, lines, pos, found.tier);
  const built: string[] = [];
  let ri = 0;
  let oi = 0;
  for (const b of h.body) {
    if (b.startsWith(' ')) { built.push(lines[pos + oi]!); oi += 1; }
    else if (b === '') { built.push(lines[pos + oi]!); oi += 1; }
    else if (b.startsWith('-')) { oi += 1; }
    else if (b.startsWith('+')) { built.push(ren[ri]!); ri += 1; }
  }
  const out = [...lines.slice(0, pos), ...built, ...lines.slice(pos + o.length)];
  return { br: model.br, lines: out, final: atEnd ? !noEol : model.final };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i + 1;
    // Path: nearest line before SEARCH, after the previous block, not blank, not starting with ```.
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    let rep = -1;
    for (let k = i + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '=======') { eq = k; break; }
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq >= 0) {
      for (let k = eq + 1; k < n; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { rep = k; break; }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const built = reindent(newLines, oldLines, model.lines, pos, found.tier);
    const out = [...model.lines.slice(0, pos), ...built, ...model.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile({ br: model.br, lines: out, final: model.final }));
  };
}

interface V4aChunk { anchor: string | null; body: string[]; eof: boolean; }
interface V4aSection { kind: 'add' | 'delete' | 'update'; path: string; lines: string[]; moveTo: string | null; chunks: V4aChunk[]; headerLine: number; }

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k -= 1) if (!blank(lines[k]!)) { last = k; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const isSecStart = (l: string): boolean => l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      const raw: string[] = [];
      let j = i + 1;
      while (j < last && !isSecStart(lines[j]!)) { raw.push(lines[j]!); j += 1; }
      while (raw.length > 0 && raw[raw.length - 1]!.trim() === '') raw.pop();
      for (let k = 0; k < raw.length; k += 1) {
        if (!(raw[k]!.startsWith('+') || raw[k]! === '')) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      sections.push({ kind: 'add', path, lines: raw.map((r) => (r === '' ? '' : r.slice(1))), moveTo: null, chunks: [], headerLine: i + 1 });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      sections.push({ kind: 'delete', path: l.slice('*** Delete File:'.length).trim(), lines: [], moveTo: null, chunks: [], headerLine: i + 1 });
      i += 1;
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const path = l.slice('*** Update File:'.length).trim();
      const raw: Array<{ text: string; idx: number }> = [];
      let j = i + 1;
      while (j < last && !isSecStart(lines[j]!)) { raw.push({ text: lines[j]!, idx: j }); j += 1; }
      while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
        moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
        k = 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (; k < raw.length; k += 1) {
        const e = raw[k]!;
        if (e.text.startsWith('@@')) {
          cur = { anchor: e.text.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
        } else if (e.text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${e.idx + 1}`);
          cur.eof = true;
          cur = null;
        } else if (e.text.startsWith(' ') || e.text.startsWith('-') || e.text.startsWith('+') || e.text === '') {
          if (cur === null) { cur = { anchor: null, body: [], eof: false }; chunks.push(cur); }
          cur.body.push(e.text);
        } else {
          throw new Exit2(`error: parse ${e.idx + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      sections.push({ kind: 'update', path, lines: [], moveTo, chunks, headerLine: i + 1 });
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections.map((sec) => v4aEdit(sec, strict));
}

function v4aChunkParts(body: string[]): { o: string[]; n: string[]; ctx: boolean[] } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: boolean[] = [];
  for (const b of body) {
    if (b.startsWith(' ')) { o.push(b.slice(1)); n.push(b.slice(1)); ctx.push(true); }
    else if (b === '') { o.push(''); n.push(''); ctx.push(true); }
    else if (b.startsWith('-')) { o.push(b.slice(1)); }
    else if (b.startsWith('+')) { n.push(b.slice(1)); ctx.push(false); }
  }
  return { o, n, ctx };
}

function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let model = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let found = -1;
        for (const t of tiers) {
          for (let k = cursor; k < model.lines.length; k += 1) {
            if (lineEq(model.lines[k]!, ch.anchor, t)) { found = k; break; }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', p);
        cursor = found + 1;
      }
      const { o, n, ctx } = v4aChunkParts(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? model.lines.length : cursor;
        const out = [...model.lines.slice(0, at), ...n, ...model.lines.slice(at)];
        model = { br: model.br, lines: out, final: model.final };
        cursor = at + n.length;
        continue;
      }
      const found = findTier(model.lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', p);
      let pos = -1;
      for (const occ of found.occ) {
        if (!ch.eof || occ + o.length === model.lines.length) { pos = occ; break; }
      }
      if (pos < 0) throw new Fail('no-match', p);
      const ren = reindent(n.filter((_, k) => !ctx[k]), o, model.lines, pos, found.tier);
      const built: string[] = [];
      let oi = 0;
      let ri = 0;
      for (const b of ch.body) {
        if (b.startsWith(' ')) { built.push(model.lines[pos + oi]!); oi += 1; }
        else if (b === '') { built.push(model.lines[pos + oi]!); oi += 1; }
        else if (b.startsWith('-')) { oi += 1; }
        else if (b.startsWith('+')) { built.push(ren[ri]!); ri += 1; }
      }
      const out = [...model.lines.slice(0, pos), ...built, ...model.lines.slice(pos + o.length)];
      model = { br: model.br, lines: out, final: model.final };
      cursor = pos + built.length;
    }
    const out = joinFile(model);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push({ old: p, next: sec.moveTo });
    } else {
      tree.now.set(p, out);
    }
  };
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Pair D+A rows that a move chain produced into R rows (SPEC section 2).
  const changed = new Map<string, string | null>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, now);
  }
  const next = new Map<string, string>();
  for (const m of tree.moves) next.set(m.old, m.next);
  const rRows: Array<{ old: string; next: string }> = [];
  const consumed = new Set<string>();
  for (const m of tree.moves) {
    let cur = m.old;
    const seen = new Set<string>([cur]);
    while (next.has(cur) && !seen.has(next.get(cur)!)) { cur = next.get(cur)!; seen.add(cur); }
    const fin = cur;
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(fin) === null && tree.get(fin) !== null) {
      if (!rRows.some((r) => r.old === m.old && r.next === fin)) rRows.push({ old: m.old, next: fin });
      consumed.add(m.old);
      consumed.add(fin);
    }
  }
  const rows: Array<{ key: string; text: string }> = [];
  for (const [p, now] of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const r of rRows) rows.push({ key: r.next, text: `R ${r.old} -> ${r.next}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
