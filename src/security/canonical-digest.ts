import { createHash } from "node:crypto";

function canonicalize(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number at ${path}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => {
      const child = record[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") {
        throw new Error(`Non-JSON value at ${path}.${key}`);
      }
      return `${JSON.stringify(key)}:${canonicalize(child, `${path}.${key}`)}`;
    }).join(",")}}`;
  }
  throw new Error(`Non-JSON value at ${path}`);
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, "$");
}

export function sha256Digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
