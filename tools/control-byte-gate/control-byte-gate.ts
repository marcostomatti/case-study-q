/**
 * Control-byte gate:
 * A raw C0 control byte in a tracked text file breaks two tools at once,
 * and both failures are silent false negatives:
 *
 *   - git classifies the blob as binary, so every diff renders as
 *     `Bin N -> M bytes` and the file can never be reviewed again.
 *   - POSIX grep reports NO MATCH for strings that are present in the
 *     file, so any absence check built on grep passes vacuously.
 *
 * Source must spell control characters as language escapes (the
 * six-character backslash-u form), never as the literal byte. Runtime
 * behaviour is identical; tool visibility is not.
 *
 * Usage:
 *   bun run gate:control-bytes                # all tracked files
 *   bun tools/control-byte-gate/control-byte-gate.ts --staged
 *                                             # staged files only
 *   bun tools/control-byte-gate/control-byte-gate.ts --include-untracked
 *                                             # + files not yet git-added
 *   bun tools/control-byte-gate/control-byte-gate.ts --root <repo-root>
 *
 * Exit codes: 0 clean, 1 findings, 2 the gate could not run.
 * 2 is distinct from 0 on purpose — a gate that cannot run must never be
 * mistaken for a gate that passed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The NUL character and the escape spelling this gate recommends, built
 * from code points rather than written as escapes. A backslash-u escape
 * with four hex digits is valid JSON, so content carrying one through a
 * JSON-decoding write path (an agent tool call) arrives with the escape
 * already collapsed to the real byte — the exact accident this gate
 * exists to catch. Built this way, this file can never seed it.
 */
const NUL = String.fromCharCode(0);
const BACKSLASH_U = String.fromCharCode(92) + 'u';

/**
 * Bytes that must never appear raw in a tracked text file: every C0
 * control character except TAB/LF/CR, plus DEL. NUL (0x00) is the one
 * git and grep key their binary classification on; ESC (0x1b) does not
 * trip the classifier but makes a file unreadable and unmatchable by
 * edit tools.
 */
export const FORBIDDEN_BYTES: ReadonlySet<number> = new Set([
  ...Array.from({ length: 0x20 }, (_, b) => b).filter(
    (b) => b !== 0x09 && b !== 0x0a && b !== 0x0d,
  ),
  0x7f,
]);

/**
 * Codepoints that are invisible or misleading rather than merely control
 * bytes. These encode as bytes >= 0x80, so the byte scan above cannot
 * see them — a Trojan Source payload (CVE-2021-42574) is entirely in
 * this set.
 *
 * Kept deliberately in sync with `ar/no-unsafe-unicode` in
 * `unsafeUnicode.mjs` at the repo root; control-byte-gate.test.ts
 * asserts the two agree. The duplication is on purpose: this gate
 * imports nothing, so it runs on a bare checkout with no install.
 */
export const FORBIDDEN_CODEPOINTS: ReadonlySet<number> = new Set([
  // Bidirectional overrides and isolates — Trojan Source.
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
  // Invisible / default-ignorable.
  0x00ad, 0x200b, 0x200e, 0x200f, 0x2060, 0xfeff,
  // Parser-splitting separators.
  0x2028, 0x2029,
]);

/** Legitimate between two emoji, suspicious anywhere else. */
export const EMOJI_JOINERS: ReadonlySet<number> = new Set([0x200c, 0x200d]);

const EMOJI_ADJACENT =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}]/u;

/**
 * Extensions whose files are legitimately binary. This is an ALLOWLIST,
 * and it is the gate's only escape hatch: anything not listed here is
 * scanned. The inverse design — skipping unknown extensions — is what
 * lets a control byte slip through unnoticed, so do not invert it.
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'icns', 'bmp', 'tiff',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'zip', 'gz', 'tgz', 'br', 'xz', '7z',
  'mp3', 'mp4', 'webm', 'wav', 'mov', 'ogg',
  'wasm', 'bin', 'lockb', 'node', 'dylib', 'so', 'class', 'jar',
  'p12', 'der', 'keystore', 'jks',
]);

/** Explicit per-path exemptions. Keep empty unless a file truly cannot comply. */
export const ALLOWLISTED_PATHS: ReadonlySet<string> = new Set<string>([]);

/** Per-file reporting cap: a truly binary file would otherwise flood the log. */
export const MAX_REPORTED_PER_FILE = 10;

export interface Finding {
  file: string;
  line: number;
  column: number;
  byte: number;
  snippet: string;
}

export function isScannable(relPath: string): boolean {
  if (ALLOWLISTED_PATHS.has(relPath)) return false;
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return true; // extensionless and dotfiles are scanned
  return !BINARY_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * Render a line for display with every forbidden byte replaced by
 * `<0xNN>`, so the gate's own output can never carry the byte into a
 * terminal or CI log. Segments between control bytes are decoded as
 * UTF-8 so multi-byte characters survive intact.
 */
export function renderSafe(buf: Buffer): string {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (!FORBIDDEN_BYTES.has(buf[i]!)) continue;
    parts.push(buf.subarray(start, i).toString('utf8'));
    parts.push(`<0x${buf[i]!.toString(16).padStart(2, '0')}>`);
    start = i + 1;
  }
  parts.push(buf.subarray(start).toString('utf8'));
  return parts.join('').trim()
    .slice(0, 160);
}

/**
 * Every forbidden CODEPOINT in the decoded text, with 1-based
 * line/column. Runs alongside the byte scan: bytes catch NUL/ESC,
 * codepoints catch BiDi and the invisible set.
 */
export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n') {
      line += 1;
      lineStart = i + 1;
      continue;
    }
    const code = text.codePointAt(i)!;
    if (code === 0xfeff && i === 0) continue; // leading BOM is an encoding artifact

    if (EMOJI_JOINERS.has(code)) {
      const prev = codePointBefore(text, i);
      const next = i + 1 < text.length
        ? text.codePointAt(i + 1)!
        : -1;
      const ok =
        prev >= 0 && next >= 0 &&
        EMOJI_ADJACENT.test(String.fromCodePoint(prev)) &&
        EMOJI_ADJACENT.test(String.fromCodePoint(next));
      if (ok) continue;
    } else if (!FORBIDDEN_CODEPOINTS.has(code)) {
      continue;
    }

    let lineEnd = text.indexOf('\n', i);
    if (lineEnd === -1) lineEnd = text.length;
    findings.push({
      file,
      line,
      column: i - lineStart + 1,
      byte: code,
      snippet: renderSafeText(text.slice(lineStart, lineEnd)),
    });
  }
  return findings;
}

/**
 * Code point ending at `i`, walking back over a surrogate pair. Reading
 * `text[i - 1]` yields a lone low surrogate for any astral emoji, which
 * never matches a Unicode property escape — that reads every real emoji
 * ZWJ sequence as a violation.
 */
function codePointBefore(text: string, i: number): number {
  if (i <= 0) return -1;
  const lo = text.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = text.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) {
      return (hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
    }
  }
  return lo;
}

/** Like `renderSafe`, for text: replaces flagged codepoints with `<U+XXXX>`. */
export function renderSafeText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    const flagged =
      FORBIDDEN_CODEPOINTS.has(code) ||
      EMOJI_JOINERS.has(code) ||
      FORBIDDEN_BYTES.has(code);
    out += flagged
      ? `<U+${code.toString(16).toUpperCase()
        .padStart(4, '0')}>`
      : text[i];
  }
  return out.trim().slice(0, 160);
}

/** Every forbidden byte in `buf`, with 1-based line/column. */
export function scanBuffer(file: string, buf: Buffer): Finding[] {
  const findings: Finding[] = [];
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i]!;
    if (byte === 0x0a) {
      line += 1;
      lineStart = i + 1;
      continue;
    }
    if (!FORBIDDEN_BYTES.has(byte)) continue;
    let lineEnd = buf.indexOf(0x0a, i);
    if (lineEnd === -1) lineEnd = buf.length;
    findings.push({
      file,
      line,
      column: i - lineStart + 1,
      byte,
      snippet: renderSafe(buf.subarray(lineStart, lineEnd)),
    });
  }
  return findings;
}

/**
 * Paths git knows about, NUL-delimited so filenames with newlines cannot
 * split a record. Throws when git cannot answer — callers must exit 2,
 * not 0.
 */
export function listFiles(
  root: string,
  staged: boolean,
  includeUntracked = false,
): string[] {
  const run = (args: string[]): string[] => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split(NUL)
    .filter(Boolean);

  if (staged) {
    return run(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
  }

  const tracked = run(['ls-files', '-z']);
  if (!includeUntracked) return tracked;

  // New skill/agent/context files are usually written before they are
  // added. `--exclude-standard` keeps .gitignore honoured, so
  // node_modules and build output stay out.
  const untracked = run(['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...tracked, ...untracked])];
}

/** Worktree content, or null when the path is not a readable regular file. */
export function readWorktree(root: string, rel: string): Buffer | null {
  const full = join(root, rel);
  try {
    if (!statSync(full).isFile()) return null; // submodule / gone
  } catch {
    return null; // staged deletion, or a path removed from the worktree
  }
  return readFileSync(full);
}

/**
 * Content of the STAGED (index) version. The pre-commit hook must judge
 * what the commit will actually contain: a byte staged and then cleaned
 * up in the worktree would otherwise sail through.
 */
export function readStaged(root: string, rel: string): Buffer | null {
  try {
    return execFileSync('git', ['cat-file', 'blob', `:${rel}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export function scanFiles(
  root: string,
  relPaths: string[],
  read: (rel: string) => Buffer | null = (rel) => readWorktree(root, rel),
): Finding[] {
  const findings: Finding[] = [];
  for (const rel of relPaths) {
    if (!isScannable(rel)) continue;
    const content = read(rel);
    if (content === null) continue;
    findings.push(...scanBuffer(rel, content));
    // Byte scan first (NUL/ESC), then the decoded scan (BiDi/invisible).
    // A file that is not valid UTF-8 still gets the byte scan, which is
    // the one that matters for git's binary classification.
    findings.push(...scanText(rel, content.toString('utf8')));
  }
  return findings;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const staged = argv.includes('--staged');
  const includeUntracked = argv.includes('--include-untracked');
  const rootFlag = argv.indexOf('--root');
  const root = rootFlag > -1
    ? argv[rootFlag + 1]!
    : process.cwd();

  let files: string[] = [];
  try {
    files = listFiles(root, staged, includeUntracked);
  } catch (err) {
    const message = err instanceof Error
      ? err.message
      : String(err);
    console.error(`[control-byte-gate] FAIL — git could not list files: ${message}`);
    process.exit(2);
  }

  const scannable = files.filter(isScannable);

  // Vacuity guard: in full-repo mode an empty file list means the gate
  // was pointed somewhere wrong, not that the repo is clean. Reporting
  // OK here would be exactly the false all-clear this gate exists to
  // prevent.
  if (!staged && scannable.length === 0) {
    console.error(
      '[control-byte-gate] FAIL — 0 scannable files found. Refusing to report' +
        ' a pass; check --root points at the repository.',
    );
    process.exit(2);
  }

  // Say plainly when there was nothing to look at. "OK - 0 files
  // scanned" reads like a verification that happened; it is the absence
  // of one.
  if (staged && scannable.length === 0) {
    console.log('[control-byte-gate] nothing staged to scan.');
    process.exit(0);
  }

  const findings = scanFiles(
    root,
    scannable,
    staged
      ? (rel) => readStaged(root, rel)
      : undefined,
  );

  if (findings.length === 0) {
    console.log(
      `[control-byte-gate] OK — ${scannable.length} file(s) scanned, no unsafe characters.`,
    );
    process.exit(0);
  }

  console.error(
    `[control-byte-gate] FAIL — ${findings.length} unsafe character(s) in ` +
      `${new Set(findings.map((f) => f.file)).size} file(s):`,
  );
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  for (const [file, list] of byFile) {
    for (const f of list.slice(0, MAX_REPORTED_PER_FILE)) {
      const hexByte = `0x${f.byte.toString(16).padStart(2, '0')}`;
      console.error(`  ${file}:${f.line}:${f.column}  ${hexByte}`);
      console.error(`    ${f.snippet}`);
    }
    if (list.length > MAX_REPORTED_PER_FILE) {
      console.error(
        `  ${file}: ... and ${list.length - MAX_REPORTED_PER_FILE} more in this file`,
      );
    }
  }
  console.error(
    `\n  Write the character as a language escape instead (e.g. ${BACKSLASH_U}0000).`,
  );
  console.error(
    '  Runtime behaviour is unchanged; a literal byte makes git render the',
  );
  console.error(
    '  file as `Bin` and makes grep report no match for text that is present.',
  );
  process.exit(1);
}
