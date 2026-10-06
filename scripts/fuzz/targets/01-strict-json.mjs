// The one JSON boundary every HTTP body on the owner website and fleet gateway crosses.
import { safeStringify } from "../lib/rng.mjs";
import { parseStrictJsonV1 } from "../../../src/installer/shared/strict-json.mjs";

const corpus = [
  '{"code":"crj_x","workerKind":"codex","credentialDigest":"sha256:00","platform":"darwin","architecture":"arm64","connectorVersion":"1.2.3","clientNonce":"n"}',
  '{"ownerCode":"abcdefghijklmnopqrstuvwxyz0123"}',
  '{"summary":"done","idempotencyKey":"k-123456789012","files":[{"name":"a.txt","mediaType":"text/plain","contentBase64":"aGk="}]}',
  '{"a":{"b":{"c":[1,2,3,{"d":null}]}},"e":"\\u00e9\\ud83d\\ude00","f":-1.5e-3,"g":true}',
  "[]", "{}", '""', "0", "null", '"\\"escaped\\""', "[1,[2,[3,[4]]]]", '{"k":"v","k2":"v2"}',
];

/** Independent duplicate-member detector (JSON grammar already validated by JSON.parse). */
function hasDuplicateKeys(text) {
  const stack = []; let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1; while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (expectKey) { const key = JSON.parse(text.slice(i, end + 1)); const set = stack.at(-1); if (set.has(key)) return true; set.add(key); expectKey = false; }
      i = end;
    } else if (c === "{") { stack.push(new Set()); expectKey = true; }
    else if (c === "[") { stack.push(null); expectKey = false; }
    else if (c === "}" || c === "]") { stack.pop(); expectKey = false; }
    else if (c === ",") expectKey = stack.at(-1) instanceof Set;
  }
  return false;
}
function depthOf(value, d = 0) {
  if (value && typeof value === "object") { let m = d; for (const v of Object.values(value)) m = Math.max(m, depthOf(v, d + 1)); return m; }
  return d;
}

export const target = {
  name: "strict-json",
  corpus,
  generate(rng, corpus, i) {
    const r = rng.float();
    if (r < 0.4) return { $label: "mutate-text", $input: rng.mutateText(rng.pick(corpus), rng.int(1, 3)) };
    if (r < 0.6) return { $label: "random-value", $input: safeStringify(rng.jsonValue(0, 6)) };
    if (r < 0.7) return { $label: "deep", $input: "[".repeat(rng.int(100, 3000)) + "]".repeat(rng.int(100, 3000)) };
    if (r < 0.78) { const n = rng.int(1000, 60000); return { $label: "wide", $input: "[" + "1,".repeat(n) + "1]" }; }
    if (r < 0.86) { const k = rng.ascii(rng.int(1, 6)); const esc = [...k].map(c => rng.bool() ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c).join(""); return { $label: "escaped-dup-key", $input: `{"${k}":1,"${esc}":2}` }; }
    if (r < 0.93) return { $label: "raw-bytes", $input: Buffer.from(rng.bytes(rng.int(1, 64))).toString("latin1") };
    return { $label: "ws-pad", $input: rng.pick([" ", "\t", "\n", "\r", " ", "﻿", " "]).repeat(rng.int(1, 5)) + rng.pick(corpus) + rng.pick(["", " ", "\n", "\u0000", "x"]) };
  },
  invoke(text) {
    const value = parseStrictJsonV1(text, { maxBytes: 1024 * 1024 });
    return { outcome: "accepted", value };
  },
  expectedErrors: error => error instanceof SyntaxError && /^json_(invalid|size_refused|depth_refused|nodes_refused|duplicate_key)$|^Unexpected|^Expected|^Bad|^Unterminated|JSON/u.test(error.message) || error instanceof SyntaxError,
  oracle(text, result) {
    if (result.outcome !== "accepted") return undefined;
    let native; try { native = JSON.parse(text); } catch { return "accepted text that native JSON.parse refuses"; }
    if (JSON.stringify(native) !== JSON.stringify(result.value)) return "accepted value differs from JSON.parse";
    if (hasDuplicateKeys(text)) return "accepted a document with duplicate member names";
    if (depthOf(native) > 128) return "accepted nesting deeper than maxDepth";
    if (Buffer.byteLength(text) > 1024 * 1024) return "accepted a body over maxBytes";
    const polluted = ({}).polluted !== undefined || Object.prototype.hasOwnProperty.call(Object.prototype, "polluted");
    if (polluted) return "Object.prototype polluted";
    return undefined;
  },
};
