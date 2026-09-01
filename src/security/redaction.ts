const secretKey = /(?:password|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|session[_-]?cookie)/i;
const referenceKey = /(?:ref|refs|id|ids|digest|hash)$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[a-z0-9._~+/=-]{12,}/i,
  /(?:api[_-]?key|password|passphrase|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]{6,}/i,
  /(?:X-Amz-Signature|X-Amz-Credential)=/i,
  /\b(?:ghp|github_pat|sk_live|sk_test)_[a-z0-9_-]{12,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

const nativeArrayIsArray = Array.isArray, nativeArrayJoin = Array.prototype.join,
  nativeArrayPush = Array.prototype.push, nativeObjectDefineProperty = Object.defineProperty,
  nativeError = Error, nativeObjectEntries = Object.entries,
  nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor,
  nativeReflectApply = Reflect.apply, nativeRegExpExec = RegExp.prototype.exec;

function matches(pattern: RegExp, value: string): boolean {
  return nativeReflectApply(nativeRegExpExec, pattern, [value]) !== null;
}

function matchesAny(patterns: readonly RegExp[], value: string): boolean {
  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index];
    if (pattern && matches(pattern, value)) return true;
  }
  return false;
}

function append<T>(values: T[], value: T): void {
  nativeReflectApply(nativeArrayPush, values, [value]);
}

export interface RedactionResult<T = unknown> {
  value: T;
  redactedPaths: string[];
}

function keyCarriesSecret(key: string): boolean {
  return matches(secretKey, key) && !matches(referenceKey, key);
}

export function containsSecretMaterial(value: unknown, path = "$", findings: string[] = []): string[] {
  if (typeof value === "string") {
    if (matchesAny(secretPatterns, value)) append(findings, path);
  } else if (nativeArrayIsArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      containsSecretMaterial(value[index], `${path}[${index}]`, findings);
    }
  } else if (value && typeof value === "object") {
    const entries = nativeObjectEntries(value as Record<string, unknown>);
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      const key = entry[0], child = entry[1];
      const childPath = `${path}.${key}`;
      if (keyCarriesSecret(key) && child !== null && child !== undefined) append(findings, childPath);
      else containsSecretMaterial(child, childPath, findings);
    }
  }
  return findings;
}

export function assertNoSecretMaterial(value: unknown, label = "value"): void {
  const findings = containsSecretMaterial(value);
  if (findings.length) {
    throw new nativeError(`${label} contains secret material at ${nativeReflectApply(nativeArrayJoin, findings, [", "])}`);
  }
}

export function redactSecrets(value: unknown): RedactionResult {
  const redactedPaths: string[] = [];
  const visit = (child: unknown, path: string, key?: string): unknown => {
    if (key && keyCarriesSecret(key) && child !== null && child !== undefined) {
      append(redactedPaths, path);
      return "[REDACTED]";
    }
    if (typeof child === "string" && matchesAny(secretPatterns, child)) {
      append(redactedPaths, path);
      return "[REDACTED]";
    }
    if (nativeArrayIsArray(child)) {
      const projected: unknown[] = [];
      projected.length = child.length;
      for (let index = 0; index < child.length; index += 1) {
        if (!nativeObjectGetOwnPropertyDescriptor(child, `${index}`)) continue;
        projected[index] = visit(child[index], `${path}[${index}]`);
      }
      return projected;
    }
    if (child && typeof child === "object") {
      const projected: Record<string, unknown> = {}, entries = nativeObjectEntries(child as Record<string, unknown>);
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (!entry) continue;
        const childKey = entry[0];
        nativeObjectDefineProperty(projected, childKey, {
          value: visit(entry[1], `${path}.${childKey}`, childKey), enumerable: true, configurable: true, writable: true,
        });
      }
      return projected;
    }
    return child;
  };
  return { value: visit(value, "$"), redactedPaths };
}
