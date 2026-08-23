const secretKey = /(?:password|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|session[_-]?cookie)/i;
const referenceKey = /(?:ref|refs|id|ids|digest|hash)$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[a-z0-9._~+/=-]{12,}/i,
  /(?:api[_-]?key|password|passphrase|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,;]{6,}/i,
  /(?:X-Amz-Signature|X-Amz-Credential)=/i,
  /\b(?:ghp|github_pat|sk_live|sk_test)_[a-z0-9_-]{12,}/i,
];

export interface RedactionResult<T = unknown> {
  value: T;
  redactedPaths: string[];
}

function keyCarriesSecret(key: string): boolean {
  return secretKey.test(key) && !referenceKey.test(key);
}

export function containsSecretMaterial(value: unknown, path = "$", findings: string[] = []): string[] {
  if (typeof value === "string") {
    if (secretPatterns.some((pattern) => pattern.test(value))) findings.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((child, index) => containsSecretMaterial(child, `${path}[${index}]`, findings));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if (keyCarriesSecret(key) && child !== null && child !== undefined) findings.push(childPath);
      else containsSecretMaterial(child, childPath, findings);
    }
  }
  return findings;
}

export function assertNoSecretMaterial(value: unknown, label = "value"): void {
  const findings = containsSecretMaterial(value);
  if (findings.length) throw new Error(`${label} contains secret material at ${findings.join(", ")}`);
}

export function redactSecrets(value: unknown): RedactionResult {
  const redactedPaths: string[] = [];
  const visit = (child: unknown, path: string, key?: string): unknown => {
    if (key && keyCarriesSecret(key) && child !== null && child !== undefined) {
      redactedPaths.push(path);
      return "[REDACTED]";
    }
    if (typeof child === "string" && secretPatterns.some((pattern) => pattern.test(child))) {
      redactedPaths.push(path);
      return "[REDACTED]";
    }
    if (Array.isArray(child)) return child.map((item, index) => visit(item, `${path}[${index}]`));
    if (child && typeof child === "object") {
      return Object.fromEntries(Object.entries(child as Record<string, unknown>).map(([childKey, item]) => [childKey, visit(item, `${path}.${childKey}`, childKey)]));
    }
    return child;
  };
  return { value: visit(value, "$"), redactedPaths };
}
