/** Shared fail-closed guards for portable inert JSON contracts. */
/* eslint-disable no-control-regex */
export const PORTABLE_PRINTABLE_TEXT_V1 = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]*$/;

/**
 * Every Unicode format, private-use, unassigned or surrogate code point (each
 * is invisible-by-design or reserved for private or unknown use), the
 * line/paragraph separators, the soft hyphen, the combining grapheme joiner,
 * the Mongolian free variation selectors, the Hangul filler characters, and
 * every variation selector except U+FE0E/U+FE0F. `\p{Cf}` alone already
 * covers bidi embeddings/overrides/isolates ("trojan source"), zero-width
 * characters, the byte order mark, and the Unicode tag characters.
 */
const HIDDEN_TEXT_ALWAYS_V1 =
  /\p{Cf}|\p{Co}|\p{Cn}|\p{Cs}|[\u{2028}\u{2029}\u{00AD}\u{034F}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{180B}\u{180C}\u{FE00}-\u{FE0D}]|[\u{E0100}-\u{E01EF}]/u;
const PRESENTATION_SELECTOR_V1 = /[\u{FE0E}\u{FE0F}]/u;
const EXTENDED_PICTOGRAPHIC_V1 = /\p{Extended_Pictographic}/u;

/**
 * Refuses every character a reviewer or a prompt consumer would not actually
 * see: this is an allowlist by construction (only ordinary letters, marks,
 * numbers, punctuation, symbols and whitespace ever pass), not a list of
 * known bad characters. The one exception is U+FE0E/U+FE0F immediately after
 * the pictograph whose text/emoji presentation they select; two in a row, or
 * either one without a pictograph first, is refused like any other hidden
 * character.
 */
export function assertNoHiddenTextV1(text: string, code: string): void {
  const characters = Array.from(text);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    if (PRESENTATION_SELECTOR_V1.test(character)) {
      const previous = characters[index - 1];
      if (previous === undefined || !EXTENDED_PICTOGRAPHIC_V1.test(previous)) throw new Error(code);
      continue;
    }
    if (HIDDEN_TEXT_ALWAYS_V1.test(character)) throw new Error(code);
  }
}

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /BEGIN [A-Z0-9 ]*PRIVATE KEY/,
  /:\/\/[^/\s]*:[^/\s]*@/,
  /(api[_-]?key|secret|passwd|password|bearer|session[_-]?token)\s*[:=]/i,
];
const AUTHORITY_PATTERNS: readonly RegExp[] = [
  /(grant|revoke|allow|deny|permit)\s+(access|permission|role|rights)/i,
  /\b(sudo|chmod|chown|setuid)\b/i,
  /\brole\s*[:=]/i,
];
const EXECUTABLE_PATTERNS: readonly RegExp[] = [/<script[\s>]/i, /javascript:/i, /\son[a-z]+\s*=/i, /\$\(/];
const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function assertPortableInputSizeV1(prefix: string, value: unknown, maxBytes: number): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    throw new Error(`${prefix}_malformed`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new Error(`${prefix}_input_oversized`);
}

export function assertNoPortablePrototypePollutionV1(
  prefix: string,
  value: unknown,
  maxDepth: number,
  depth = 0,
): void {
  if (depth > maxDepth) throw new Error(`${prefix}_input_too_deep`);
  if (Array.isArray(value)) {
    for (const item of value) assertNoPortablePrototypePollutionV1(prefix, item, maxDepth, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (PROTOTYPE_POLLUTION_KEYS.has(key)) throw new Error(`${prefix}_prototype_pollution_key`);
      assertNoPortablePrototypePollutionV1(prefix, (value as Record<string, unknown>)[key], maxDepth, depth + 1);
    }
  }
}

export function assertPortableGuardedTextV1(prefix: string, field: string, value: string): void {
  if (!PORTABLE_PRINTABLE_TEXT_V1.test(value)) throw new Error(`${prefix}_${field}_not_printable`);
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(value)) throw new Error(`${prefix}_${field}_credential_shaped`);
  }
  for (const pattern of AUTHORITY_PATTERNS) {
    if (pattern.test(value)) throw new Error(`${prefix}_${field}_authority_shaped`);
  }
  for (const pattern of EXECUTABLE_PATTERNS) {
    if (pattern.test(value)) throw new Error(`${prefix}_${field}_executable_content`);
  }
}
