import { describe, expect, it } from 'vitest';

import {
  BINARY_EXTENSIONS,
  FORBIDDEN_BYTES,
  isScannable,
  renderSafe,
  scanBuffer,
  scanText,
} from './control-byte-gate';

/**
 * Build fixtures from char codes rather than escapes in this file, so
 * the test source itself can never carry the byte it is testing for. If
 * these were written as literal control characters, this file would
 * become the next unreviewable blob — and the gate would flag its own
 * test suite. The escape SPELLING is assembled too (BSU below): a
 * four-hex backslash-u sequence is valid JSON, so an agent write path
 * that decodes JSON collapses it to the real byte before the file ever
 * hits disk.
 */
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);
const BSU = String.fromCharCode(92) + 'u';
const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('scanBuffer', () => {
  // The mutation check: a scanner that returned [] unconditionally would
  // pass every other assertion here. This is the one that fails if it
  // goes inert.
  it('finds a planted NUL and reports its line and column', () => {
    const found = scanBuffer('f.ts', buf(`const a = 1;\nconst k = \`x${NUL}y\`;\n`));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: 'f.ts', line: 2, column: 13, byte: 0 });
  });

  it('finds a planted ESC', () => {
    const found = scanBuffer('f.ts', buf(`const dim = \`${ESC}[2m\`;`));
    expect(found).toHaveLength(1);
    expect(found[0]!.byte).toBe(0x1b);
  });

  it('reports every occurrence, not just the first', () => {
    const found = scanBuffer('f.ts', buf(`${NUL}a${NUL}b${NUL}`));
    expect(found).toHaveLength(3);
    expect(found.map((f) => f.column)).toEqual([1, 3, 5]);
  });

  it('counts lines across a multi-line file', () => {
    const found = scanBuffer('f.ts', buf(`a\nb\nc\nd${NUL}\n`));
    expect(found[0]!.line).toBe(4);
  });

  it('accepts tab, newline and carriage return', () => {
    expect(scanBuffer('f.ts', buf('a\tb\r\nc\n'))).toEqual([]);
  });

  it('accepts the six-character backslash-u escape, the correct spelling', () => {
    const escaped = 'const k = `${tool}' + BSU + '0000${command}`;';
    expect(escaped).toContain('u0000');
    expect(scanBuffer('registry.ts', buf(escaped))).toEqual([]);
  });

  it('is clean on an empty file', () => {
    expect(scanBuffer('f.ts', Buffer.alloc(0))).toEqual([]);
  });

  // Regression fixtures: the three shapes this repo family actually
  // produced — a compound key joined on a real NUL, a config sentinel
  // wrapped in NULs, and a key-derivation domain separator.
  it('catches the compound-key shape', () => {
    const found = scanBuffer('registry.ts', buf(`seen.add(\`\${tool}${NUL}\${command}\`);`));
    expect(found).toHaveLength(1);
  });

  it('catches the shield-sentinel shape', () => {
    const src = `const sentinel = \`${NUL}__shield_\${nonce}__${NUL}\`;`;
    expect(scanBuffer('loader.ts', buf(src))).toHaveLength(2);
  });

  it('catches the auth key-derivation domain separator', () => {
    const src = `createHash('sha256').update(\`\${secret}${NUL}token-label\`)`;
    expect(scanBuffer('derive.ts', buf(src))).toHaveLength(1);
  });
});

describe('renderSafe', () => {
  it('escapes the offending byte so gate output never carries it', () => {
    const out = renderSafe(buf(`a${NUL}b`));
    expect(out).toBe('a<0x00>b');
    expect(out).not.toContain(NUL);
  });

  it('labels ESC distinctly from NUL', () => {
    expect(renderSafe(buf(`x${ESC}y`))).toBe('x<0x1b>y');
  });

  it('keeps multi-byte UTF-8 intact around the escape', () => {
    expect(renderSafe(buf(`caf\u{00E9}${NUL}\u{2014}ok`))).toBe('caf\u{00E9}<0x00>\u{2014}ok');
  });
});

describe('isScannable', () => {
  it('scans source, config and docs', () => {
    for (const p of [
      'tools/ralph/ralph.ts',
      'packages/service/src/index.ts',
      'README.md',
      'package.json',
      'packages/ui/src/styles/tokens.css',
    ]) {
      expect(isScannable(p), p).toBe(true);
    }
  });

  it('skips genuinely binary assets', () => {
    expect(isScannable('packages/ui/src/assets/logo.png')).toBe(false);
    expect(isScannable('app/fonts/Inter.woff2')).toBe(false);
  });

  // Deny-by-default is the whole design. An extension-skip default is
  // what lets a control byte hide for months.
  it('scans unknown extensions rather than skipping them', () => {
    expect(isScannable('weird/thing.qqq')).toBe(true);
    expect(isScannable('Makefile')).toBe(true);
    expect(isScannable('.gitignore')).toBe(true);
    expect(isScannable('bin/ralph')).toBe(true);
  });

  it('matches extensions case-insensitively', () => {
    expect(isScannable('assets/Logo.PNG')).toBe(false);
  });

  it('does not treat a dotted directory as an extension', () => {
    expect(isScannable('some.dir/file.ts')).toBe(true);
  });
});

describe('FORBIDDEN_BYTES', () => {
  it('covers every C0 control except tab/newline/CR, plus DEL', () => {
    expect(FORBIDDEN_BYTES.size).toBe(0x20 - 3 + 1);
    expect(FORBIDDEN_BYTES.has(0x00)).toBe(true);
    expect(FORBIDDEN_BYTES.has(0x1b)).toBe(true);
    expect(FORBIDDEN_BYTES.has(0x7f)).toBe(true);
    for (const ok of [0x09, 0x0a, 0x0d, 0x20, 0x41]) {
      expect(FORBIDDEN_BYTES.has(ok), String(ok)).toBe(false);
    }
  });

  it('keeps the binary allowlist free of source extensions', () => {
    for (const ext of ['ts', 'tsx', 'js', 'json', 'md', 'yml', 'yaml', 'css', 'sh']) {
      expect(BINARY_EXTENSIONS.has(ext), ext).toBe(false);
    }
  });
});

describe('scanText (codepoint scan)', () => {
  const RLO = String.fromCharCode(0x202e);
  const ZWSP = String.fromCharCode(0x200b);
  const ZWJ = String.fromCharCode(0x200d);
  const LSEP = String.fromCharCode(0x2028);
  const BOM = String.fromCharCode(0xfeff);

  it('catches a Trojan Source bidi override (CVE-2021-42574)', () => {
    const found = scanText('f.ts', `const x = '${RLO}admin';`);
    expect(found).toHaveLength(1);
    expect(found[0]!.byte).toBe(0x202e);
  });

  it('catches every bidi override and isolate', () => {
    for (const cp of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
      expect(scanText('f.ts', `a${String.fromCharCode(cp)}b`), cp.toString(16)).toHaveLength(1);
    }
  });

  it('catches a zero-width space and a line separator', () => {
    expect(scanText('f.ts', `a${ZWSP}b`)).toHaveLength(1);
    expect(scanText('f.ts', `a${LSEP}b`)).toHaveLength(1);
  });

  // The false positive that would fire on real emoji in vendored agent
  // content — a rule with false positives is a rule someone turns off.
  it('allows ZWJ inside an emoji sequence', () => {
    expect(scanText('f.json', `"\u{1F468}${ZWJ}\u{1F4BB}"`)).toEqual([]);
    expect(scanText('f.json', `"\u{1F64B}${ZWJ}\u{2642}"`)).toEqual([]);
    expect(scanText('f.json', `"\u{1F3FB}${ZWJ}\u{1F3EB}"`)).toEqual([]);
  });

  it('flags a ZWJ that is not joining emoji', () => {
    expect(scanText('f.ts', `a${ZWJ}b`)).toHaveLength(1);
    expect(scanText('f.ts', `1${ZWJ}2`)).toHaveLength(1);
  });

  it('allows a leading BOM but flags one mid-file', () => {
    expect(scanText('f.ts', `${BOM}const a = 1;`)).toEqual([]);
    expect(scanText('f.ts', `const a${BOM} = 1;`)).toHaveLength(1);
  });

  it('leaves ordinary source and emoji alone', () => {
    expect(scanText('f.ts', 'const a = 1;\n// caf\u{00E9} \u{2014} ok \u{2705}\n')).toEqual([]);
  });

  it('renders the codepoint safely and never emits it', () => {
    const found = scanText('f.ts', `x${RLO}y`);
    expect(found[0]!.snippet).toBe('x<U+202E>y');
    expect(found[0]!.snippet).not.toContain(RLO);
  });
});

// Two implementations exist on purpose: the gate imports nothing so it
// runs on a bare checkout, while the ESLint rule gives in-editor
// feedback. This asserts they never drift apart on what counts as
// unsafe.
describe('agreement with the ESLint rule', () => {
  it('flags the same characters as ar/no-unsafe-unicode', async () => {
    const mod = await import('../../tools/unsafeUnicode.mjs');
    const findUnsafeUnicode = mod.findUnsafeUnicode as (t: string) => unknown[];
    const probes = [
      0x00, 0x01, 0x1b, 0x7f, 0x00ad, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029,
      0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff,
      0x09, 0x0a, 0x0d, 0x20, 0x41, 0x00e9, 0x2014,
    ];
    for (const cp of probes) {
      const sample = `a${String.fromCharCode(cp)}b`;
      const gate = scanText('f.ts', sample).length + scanBuffer('f.ts', Buffer.from(sample, 'utf8')).length;
      const rule = findUnsafeUnicode(sample).length;
      expect(gate > 0, `U+${cp.toString(16)} gate=${gate} rule=${rule}`).toBe(rule > 0);
    }
  });
});
