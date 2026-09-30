/** Shared fail-closed guards for portable inert JSON contracts. */
/* eslint-disable no-control-regex */
export const PORTABLE_PRINTABLE_TEXT_V1 = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]*$/;

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
