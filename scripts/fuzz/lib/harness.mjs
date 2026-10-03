import { types } from "node:util";
import { Rng } from "./rng.mjs";

// F13 values cannot originate in JSON; retain diagnostics without treating those
// out-of-contract exceptions as release blockers. Bypasses and hangs still fail.
export function containsExotic(value, depth = 0) {
  if (depth > 64) return false;
  const t = typeof value;
  if (["symbol", "bigint", "function", "undefined"].includes(t)) return true;
  if (t === "number" && !Number.isFinite(value)) return true;
  if (value === null || t !== "object") return false;
  if (types.isProxy(value) || ArrayBuffer.isView(value) || value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set) return true;
  if (Array.isArray(value)) return value.some(item => containsExotic(item, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return true;
  return Object.keys(value).some(key => Object.getOwnPropertyDescriptor(value, key)?.get || containsExotic(value[key], depth + 1));
}

/** Only the report's F13 host-value exceptions are diagnostic. Transport bytes,
 * optional wrapper fields and MCP Proxy replies must not mask real failures. */
export function isF13ExoticCase(name, input) {
  if (name === "config:nightly-backup" || name === "config:local-owner-session-profile") return containsExotic(input);
  if (name === "hermes-native-frame") return !(input instanceof Uint8Array) && containsExotic(input);
  const fields = {
    "release:connector-advertisement": ["ad", "trust", "floor"],
    "release:key-rotation": ["rotation", "trust"],
    "release:key-revocations": ["rev", "trust"],
    "release:signed-directory": ["record", "installed", "builtFrom", "rollback"],
  }[name];
  return fields ? fields.some(key => input?.[key] !== undefined && containsExotic(input[key])) : false;
}

export function leaksInternals(text) {
  return typeof text === "string" && (/\n\s+at\s+\S+\s+\(/u.test(text) || /\/Users\/|\/home\/|\/private\/tmp\/|node_modules\//u.test(text));
}

export async function regenerateCase(target, seed, index) {
  const rng = new Rng(seed);
  const corpus = typeof target.corpus === "function" ? await target.corpus() : target.corpus ?? [];
  let generated;
  for (let i = 0; i <= index; i++) generated = target.generate(rng, corpus, i);
  return { input: generated?.$input !== undefined ? generated.$input : generated, label: generated?.$label };
}
