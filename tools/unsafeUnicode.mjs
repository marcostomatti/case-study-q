/**
 * `ar/no-unsafe-unicode`
 *
 * Flags characters that are invisible or misleading in a source file, and
 * that defeat the tools we rely on to review it:
 *
 *   - C0 controls / DEL. A NUL makes git classify the blob as binary, so
 *     every later diff renders `Bin N -> M bytes`, and makes POSIX grep
 *     report NO MATCH for text that is present. Both are silent false
 *     negatives. ESC lets file content rewrite a terminal that prints it.
 *   - BiDi overrides (Trojan Source, CVE-2021-42574). These make source
 *     display in a different order than it compiles, so review and
 *     compiler disagree.
 *   - Zero-width and default-ignorable characters. Invisible to a
 *     reviewer, fully present in what a parser or a model consumes.
 *   - U+2028 / U+2029, which historically split JS and JSON parsers.
 *
 * None of this is caught by anything in `eslint:recommended`. In
 * particular `no-irregular-whitespace` defaults to `skipStrings: true`,
 * so it exempts string literals — exactly where these characters land.
 *
 * The fix is always the same: write the escape (the six-character backslash-u form),
 * never the literal character. Runtime behaviour is identical; tool
 * visibility is not.
 *
 * ZWJ/ZWNJ inside an emoji sequence are legitimate and are not reported —
 * a rule with false positives is a rule someone turns off.
 *
 * The byte-level floor under this rule is
 * `tools/control-byte-gate/control-byte-gate.ts`, which scans every
 * tracked file (linted or not) on a bare checkout. Its test suite asserts
 * the two implementations agree on what counts as unsafe.
 */

/** C0 controls except TAB/LF/CR, plus DEL. */
const C0_AND_DEL = new Set([
  ...Array.from({ length: 0x20 }, (_, c) => c).filter(
    (c) => c !== 0x09 && c !== 0x0a && c !== 0x0d,
  ),
  0x7f,
]);

/** Bidirectional overrides and isolates — the Trojan Source set. */
const BIDI = new Set([
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2066, 0x2067, 0x2068, 0x2069,
]);

/** Invisible / default-ignorable characters with no business in source. */
const INVISIBLE = new Set([
  0x00ad, // SOFT HYPHEN
  0x200b, // ZERO WIDTH SPACE
  0x200e, // LEFT-TO-RIGHT MARK
  0x200f, // RIGHT-TO-LEFT MARK
  0x2060, // WORD JOINER
  0xfeff, // ZERO WIDTH NO-BREAK SPACE (BOM when leading)
]);

/** Parser-splitting separators. */
const SEPARATORS = new Set([0x2028, 0x2029]);

/** Legitimate inside emoji sequences, suspicious anywhere else. */
const EMOJI_JOINERS = new Set([0x200c, 0x200d]);

// Deliberately not \p{Emoji_Component}: that property includes ASCII
// digits, `#` and `*`, which would let `1<ZWJ>2` pass as an "emoji
// sequence". Regional indicators and the keycap mark are left out too —
// flags and keycap sequences never use ZWJ, and both trip
// `no-misleading-character-class`.
const EMOJI_ADJACENT =
  /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}]/u;

/**
 * Code point ending at `i`, walking back over a surrogate pair. Indexing
 * with `text[i - 1]` returns a lone low surrogate for any astral emoji,
 * which never matches a Unicode property escape — that read every real
 * person-plus-laptop ZWJ sequence as a violation.
 */
function codePointBefore(text, i) {
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

const isEmojiAdjacent = (code) => code >= 0 && EMOJI_ADJACENT.test(String.fromCodePoint(code));

const label = (code) => {
  if (C0_AND_DEL.has(code)) return 'control character';
  if (BIDI.has(code)) return 'bidirectional override (Trojan Source)';
  if (SEPARATORS.has(code)) return 'line/paragraph separator';
  if (EMOJI_JOINERS.has(code)) return 'zero-width joiner outside an emoji sequence';
  return 'invisible character';
};

const hex = (code) => `U+${code.toString(16).toUpperCase()
  .padStart(4, '0')}`;

/**
 * Every unsafe character in `text`, as `{ index, code, kind }`.
 * Exported so the repo-wide control-byte gate can assert the two agree.
 */
export function findUnsafeUnicode(text) {
  const found = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);

    // A leading BOM is a file-encoding artifact, not a smuggled character.
    if (code === 0xfeff && i === 0) continue;

    // ZWJ/ZWNJ are how emoji sequences are built (e.g. a person + a
    // laptop). Only report one that is not doing that job.
    if (EMOJI_JOINERS.has(code)) {
      const prev = codePointBefore(text, i);
      const next = i + 1 < text.length
        ? text.codePointAt(i + 1)
        : -1;
      if (isEmojiAdjacent(prev) && isEmojiAdjacent(next)) continue;
      found.push({ index: i, code, kind: label(code) });
      continue;
    }

    if (
      C0_AND_DEL.has(code) ||
      BIDI.has(code) ||
      INVISIBLE.has(code) ||
      SEPARATORS.has(code)
    ) {
      found.push({ index: i, code, kind: label(code) });
    }
  }
  return found;
}

/** 1-based line, 0-based column (the shape ESLint's `loc` wants). */
function locAt(text, index) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: index - lineStart };
}

export const noUnsafeUnicode = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow control, bidirectional-override and invisible characters in source; write them as escapes instead.',
    },
    schema: [],
    messages: {
      unsafe:
        '{{kind}} {{hex}} written literally. Use the escape "\\u{{escape}}" instead — a literal one is invisible in review and can make git and grep report nothing.',
    },
  },
  create(context) {
    const check = () => {
      const { text } = context.sourceCode;
      for (const { index, code, kind } of findUnsafeUnicode(text)) {
        const start = locAt(text, index);
        context.report({
          loc: { start, end: { line: start.line, column: start.column + 1 } },
          messageId: 'unsafe',
          data: {
            kind: kind.charAt(0).toUpperCase() + kind.slice(1),
            hex: hex(code),
            escape: code.toString(16).toUpperCase()
              .padStart(4, '0'),
          },
        });
      }
    };
    // `Program` covers JS/TS and the jsonc parser; `root` covers mdast, so
    // one rule serves the code, JSON and Markdown blocks of the base
    // config.
    return { Program: check, root: check };
  },
};

export default {
  meta: { name: 'ar' },
  rules: { 'no-unsafe-unicode': noUnsafeUnicode },
};
