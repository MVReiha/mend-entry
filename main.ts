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
  readonly moves: [string, string][] = [];
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

// ---- line model (SPEC.md section 3) ----
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}
function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---- tier matching (SPEC.md section 5) ----
const trimT = (s: string): string => s.replace(/[ \t]+$/, '');
const trimB = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimT(a) === trimT(b);
  return trimB(a) === trimB(b);
}
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
function findTier(O: string[], lines: string[], from: number, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    if (occurrences(O, lines, t, from).length > 0) return t;
  }
  return -1;
}
/** Build the replacement lines for N. ctxO[i] is the index in O of N[i] when it is a context line, else -1. */
function buildN(N: string[], ctxO: (number | -1)[], fileLines: string[], pos: number, tier: number, O: string[]): string[] {
  const out: string[] = [];
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = /^[ \t]*/.exec(fileLines[pos]!)![0];
    P = /^[ \t]*/.exec(O[0]!)![0];
  }
  for (let i = 0; i < N.length; i++) {
    const ci = ctxO[i]!;
    if (ci >= 0) {
      out.push(fileLines[pos + ci]!);
      continue;
    }
    const line = N[i]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) out.push(F + line.slice(P.length));
    else out.push(line);
  }
  return out;
}

interface Hunk {
  a: number;
  o: string[];
  n: string[];
  ctxO: (number | -1)[];
  plus: string[];
  noEolAfterLast: boolean;
  plusNoEol: boolean;
}
function makeHunk(A: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: string[] = [];
  const ctxO: (number | -1)[] = [];
  const plus: string[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((b, idx) => {
    if (b === '' || b.startsWith(' ')) {
      const t = b === '' ? '' : b.slice(1);
      ctxO.push(o.length);
      o.push(t);
      n.push(t);
      lastCtxPlus = idx;
    } else if (b.startsWith('-')) {
      o.push(b.slice(1));
    } else if (b.startsWith('+')) {
      const t = b.slice(1);
      n.push(t);
      ctxO.push(-1);
      plus.push(t);
      lastCtxPlus = idx;
      lastPlus = idx;
    }
  });
  const noEolAfterLast = lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.startsWith('\\');
  const plusNoEol = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { a: A, o, n, ctxO, plus, noEolAfterLast, plusNoEol };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const state = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), state.lines.length);
      const wasEnd = at === state.lines.length;
      state.lines.splice(at, 0, ...h.n);
      if (wasEnd) state.final = !h.noEolAfterLast;
      d += h.n.length;
    } else {
      const tier = findTier(h.o, state.lines, 0, strict);
      if (tier < 0) throw new Fail('no-match', path);
      const occ = occurrences(h.o, state.lines, tier, 0);
      const target = h.a - 1 + d;
      let best = occ[0]!;
      for (const p of occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const touchesEnd = best + h.o.length === state.lines.length;
      const repl = buildN(h.n, h.ctxO, state.lines, best, tier, h.o);
      state.lines.splice(best, h.o.length, ...repl);
      if (touchesEnd) state.final = !h.noEolAfterLast;
      d += h.n.length - h.o.length;
    }
  }
  return joinFile(state);
}

// ---- unified diffs (SPEC.md section 6) ----
function parsePath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  return t;
}
interface Section {
  oldP: string | null | undefined;
  newP: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  hasPair: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}
function parseUnified(lines: string[], strict: boolean): Edit[] {
  let section: Section | null = null;
  const sections: Section[] = [];
  const newSection = (): void => {
    if (section) sections.push(section);
    section = { oldP: undefined, newP: undefined, renameFrom: undefined, renameTo: undefined, diffOld: undefined, diffNew: undefined, hasPair: false, newFile: false, deletedFile: false, hunks: [] };
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      newSection();
      section!.diffOld = m[1]!;
      section!.diffNew = m[2]!;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (section && section.hunks.length === 0 && !section.hasPair) {
        section.oldP = parsePath(l);
        section.newP = parsePath(lines[i + 1]!);
        section.hasPair = true;
        i += 2;
        continue;
      }
      newSection();
      section!.oldP = parsePath(l);
      section!.newP = parsePath(lines[i + 1]!);
      section!.hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (section && section.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (!section) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(hm[1]!, 10);
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      section.hunks.push(makeHunk(A, body));
      continue;
    }
    if (section && section.hunks.length === 0) {
      if (l.startsWith('rename from ')) section.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) section.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) section.newFile = true;
      else if (l.startsWith('deleted file mode')) section.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  if (section) sections.push(section);
  return sections.map((s) => {
    const oldP = s.hasPair ? s.oldP : (s.renameFrom ?? s.diffOld);
    const newP = s.hasPair ? s.newP : (s.renameTo ?? s.diffNew);
    return (tree: Tree) => {
      if (oldP === null || s.newFile) {
        const p = newP;
        if (p === null || p === undefined) throw new Fail('unsafe', '/dev/null');
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let noEol = false;
        let sawPlus = false;
        for (const h of s.hunks) {
          plus.push(...h.plus);
          if (h.plus.length > 0) {
            sawPlus = true;
            noEol = h.plusNoEol;
          }
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (sawPlus && !noEol ? '\n' : ''));
        return;
      }
      if (newP === null || s.deletedFile) {
        const p = oldP;
        if (p === null || p === undefined) throw new Fail('unsafe', '/dev/null');
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const oldS = oldP as string;
      const newS = newP as string;
      if (oldS !== newS) {
        if (!safe(oldS)) throw new Fail('unsafe', oldS);
        if (!safe(newS)) throw new Fail('unsafe', newS);
        const before = tree.get(oldS);
        if (before === null) throw new Fail('missing', oldS);
        if (tree.get(newS) !== null) throw new Fail('exists', newS);
        const out = applyHunks(before, s.hunks, strict, oldS);
        tree.now.set(newS, out);
        tree.now.set(oldS, null);
        tree.moves.push([oldS, newS]);
        return;
      }
      if (!safe(oldS)) throw new Fail('unsafe', oldS);
      const before = tree.get(oldS);
      if (before === null) throw new Fail('missing', oldS);
      tree.now.set(oldS, applyHunks(before, s.hunks, strict, oldS));
    };
  });
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let path: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLine}`);
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '=======') {
          eq = j;
          break;
        }
        if (t === '>>>>>>> REPLACE') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
      const oldLines = lines.slice(i + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (oldLines.length === 0) {
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
          return;
        }
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const state = splitFile(before);
        const tier = findTier(oldLines, state.lines, 0, strict);
        if (tier < 0) throw new Fail('no-match', p);
        const occ = occurrences(oldLines, state.lines, tier, 0);
        if (occ.length > 1) throw new Fail('ambiguous', p);
        const pos = occ[0]!;
        const repl = buildN(newLines, newLines.map(() => -1 as const), state.lines, pos, tier, oldLines);
        state.lines.splice(pos, oldLines.length, ...repl);
        tree.now.set(p, joinFile(state));
      });
      prevPath = p;
      prevEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----
interface VChunk {
  anchor: string | null;
  eof: boolean;
  hunk: Hunk;
}
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const m = /^\*\*\* (Add|Delete|Update) File: ?(.*)$/.exec(l);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    const headerLine = i + 1;
    i++;
    const bodyStart = i;
    while (i < last) {
      const b = lines[i]!;
      if (/^\*\*\* (Add|Delete|Update) File: ?/.test(b)) break;
      i++;
    }
    let bodyEnd = i;
    while (bodyEnd > bodyStart && blank(lines[bodyEnd - 1]!)) bodyEnd--;
    const body = lines.slice(bodyStart, bodyEnd);
    const bodyNum = (idx: number): number => bodyStart + idx + 1;
    if (kind === 'Add') {
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const b = body[k]!;
        if (b === '') fileLines.push('');
        else if (b.startsWith('+')) fileLines.push(b.slice(1));
        else throw new Exit2(`error: parse ${bodyNum(k)}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'Delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${bodyNum(0)}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to:')) {
        moveTo = body[0]!.slice('*** Move to:'.length).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; lines: string[] } | null = null;
      let firstChunk = true;
      const closeChunk = (): void => {
        if (cur) {
          chunks.push({ anchor: cur.anchor, eof: cur.eof, hunk: makeHunk(0, cur.lines) });
          cur = null;
        }
      };
      for (; k < body.length; k++) {
        const b = body[k]!;
        if (b.startsWith('@@')) {
          closeChunk();
          const a = b.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, lines: [] };
          firstChunk = false;
        } else if (b.trimEnd() === '*** End of File') {
          if (!cur) throw new Exit2(`error: parse ${bodyNum(k)}`);
          cur.eof = true;
          closeChunk();
          firstChunk = false;
        } else if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (!cur) {
            if (!firstChunk) throw new Exit2(`error: parse ${bodyNum(k)}`);
            cur = { anchor: null, eof: false, lines: [] };
            firstChunk = false;
          }
          cur.lines.push(b);
        } else {
          throw new Exit2(`error: parse ${bodyNum(k)}`);
        }
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      const mv = moveTo;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const state = splitFile(before);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            let found = -1;
            const maxT = strict ? 0 : 2;
            for (let t = 0; t <= maxT && found < 0; t++) {
              for (let j = cursor; j < state.lines.length; j++) {
                if (lineEq(chunk.anchor, state.lines[j]!, t)) {
                  found = j;
                  break;
                }
              }
            }
            if (found < 0) throw new Fail('no-match', path);
            cursor = found + 1;
          }
          const h = chunk.hunk;
          if (h.o.length === 0) {
            const at = chunk.eof ? state.lines.length : cursor;
            state.lines.splice(at, 0, ...h.n);
            cursor = at + h.n.length;
          } else {
            const tier = findTier(h.o, state.lines, cursor, strict);
            if (tier < 0) throw new Fail('no-match', path);
            const occ = occurrences(h.o, state.lines, tier, cursor);
            let pos = occ[0]!;
            if (chunk.eof) {
              const ok = occ.filter((p) => p + h.o.length === state.lines.length);
              if (ok.length === 0) throw new Fail('no-match', path);
              pos = ok[0]!;
            }
            const repl = buildN(h.n, h.ctxO, state.lines, pos, tier, h.o);
            state.lines.splice(pos, h.o.length, ...repl);
            cursor = pos + repl.length;
          }
        }
        const out = joinFile(state);
        if (mv !== null) {
          tree.now.set(mv, out);
          tree.now.set(path, null);
          tree.moves.push([path, mv]);
        } else {
          tree.now.set(path, out);
        }
      });
    }
  }
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const suppressed = new Set<string>();
  const outRows: { key: string; line: string }[] = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      outRows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!suppressed.has(p)) outRows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  outRows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = outRows.map((r) => r.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
