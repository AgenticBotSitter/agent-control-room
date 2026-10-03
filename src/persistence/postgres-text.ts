/** PostgreSQL UTF-8 text/jsonb cannot represent NUL or unpaired UTF-16
 * surrogates. Unicode mode treats a valid surrogate pair as one code point. */
export function isPostgresTextV1(value: string): boolean {
  return !/[\u0000\uD800-\uDFFF]/u.test(value);
}

/** Apply the same text rule to every string and key of already-parsed JSON.
 * Callers bound and parse the wire body before this traversal. */
export function isPostgresJsonTextV1(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string" && !isPostgresTextV1(item)) return false;
    if (item !== null && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (!isPostgresTextV1(key)) return false;
        pending.push(child);
      }
    }
  }
  return true;
}
