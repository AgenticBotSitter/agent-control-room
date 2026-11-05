import { createHash } from "node:crypto";
import { parseStrictJsonV1 } from "../../installer/shared/strict-json.mjs";
import { assertNoSecretMaterial } from "../../security";
import { WebAccessError } from "./access-verifier";
import { loopProviderRouteSchemaV1 } from "./improve-control-room-loop-adapter";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new WebAccessError("invalid_request");
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

/** Decoded validation also catches escaped member names and encoded secret values. */
export function parseLoopSettingsV1(text: string, layer = false): ObjectValue {
  try {
    const value: unknown = parseStrictJsonV1(text, { maxBytes: 65536 });
    if (!object(value) || layer && Object.hasOwn(value, "overrides")) throw invalid();
    const visit = (child: unknown) => {
      if (typeof child === "number" && !Number.isFinite(child)) throw invalid();
      if (Array.isArray(child)) { for (const item of child) visit(item); }
      else if (object(child)) for (const key of Object.keys(child)) {
        if (forbidden.has(key) || key === "paid" || key === "paidPin") throw invalid();
        visit(child[key]);
      }
    };
    visit(value); assertNoSecretMaterial(value);
    if (Object.hasOwn(value, "providerRoute") && !loopProviderRouteSchemaV1.safeParse(value.providerRoute).success) throw invalid();
    return value;
  } catch { throw invalid(); }
}
function merge(base: unknown, edit: unknown): unknown {
  if (!object(edit)) return edit;
  const result: ObjectValue = Object.create(null);
  if (object(base)) for (const key of Object.keys(base)) result[key] = base[key];
  for (const key of Object.keys(edit)) result[key] = merge(result[key], edit[key]);
  return result;
}
// Encode directly: JSON.stringify reorders integer-like keys even after sorting.
function encode(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${encode(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function composeLoopSettingsV1(input: { defaultsText: string; project?: string; selection?: string; runEdits?: string }) {
  let value: unknown = parseLoopSettingsV1(input.defaultsText);
  for (const [key, layer] of [["project", true], ["selection", true], ["runEdits", false]] as const) {
    const text = input[key];
    if (text !== undefined) value = merge(value, parseLoopSettingsV1(text, layer));
  }
  // Validate the resulting object as well as every independently supplied route.
  parseLoopSettingsV1(encode(value));
  const text = input.project === undefined && input.selection === undefined && input.runEdits === undefined
    ? input.defaultsText : `${encode(value)}\n`;
  if (Buffer.byteLength(text, "utf8") > 65536) throw invalid();
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}

const lockPath = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;
export function normalizeLoopLockedPathsV1(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 100 || input.some(path => typeof path !== 'string' || path.length > 256
    || !lockPath.test(path) || path.split('.').some(segment => forbidden.has(segment))) || new Set(input).size !== input.length) throw invalid();
  return [...input].sort();
}
function atPath(value: unknown, path: string): { exists: boolean; value?: unknown } {
  for (const segment of path.split('.')) {
    if (!object(value) || !Object.hasOwn(value, segment)) return { exists: false };
    value = value[segment];
  }
  return { exists: true, value };
}
/** Compare effective values to defaults + project, including absent descendants. */
export function differingLoopLockedPathsV1(baseText: string, candidateText: string, paths: readonly string[]): string[] {
  const base = parseLoopSettingsV1(baseText), candidate = parseLoopSettingsV1(candidateText);
  return paths.filter(path => {
    const before = atPath(base, path), after = atPath(candidate, path);
    if (!before.exists) throw invalid();
    return !after.exists || encode(before.value) !== encode(after.value);
  });
}
export function validateLoopLockedPathsV1(baseText: string, paths: readonly string[]) {
  const base = parseLoopSettingsV1(baseText);
  if (paths.some(path => !atPath(base, path).exists)) throw invalid();
}
