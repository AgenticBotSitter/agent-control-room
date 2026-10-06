import { types } from "node:util";
// Seeded generator for the hardening fuzzers. No dependencies: fast-check is not
// in the tree, so this is a xorshift128+ stream plus the mutation operators the
// targets need. Every run is reproducible from `seed`.

export class Rng {
  constructor(seed) {
    // SplitMix64-style seeding of two 32-bit halves from a 32-bit seed.
    let s = (seed >>> 0) || 0x9e3779b9;
    const next = () => { s = (s + 0x9e3779b9) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0; z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0; return (z ^ (z >>> 16)) >>> 0; };
    this.a = next() || 1; this.b = next() || 2; this.c = next() || 3; this.d = next() || 4;
    this.seed = seed;
  }
  // xorshift128 (32-bit lanes), uniform in [0, 2^32)
  u32() {
    let t = this.d; const s = this.a; this.d = this.c; this.c = this.b; this.b = s;
    t ^= t << 11; t ^= t >>> 8; this.a = (t ^ s ^ (s >>> 19)) >>> 0; return this.a;
  }
  float() { return this.u32() / 4294967296; }
  int(min, max) { return min + Math.floor(this.float() * (max - min + 1)); }
  bool(p = 0.5) { return this.float() < p; }
  pick(items) { return items[this.int(0, items.length - 1)]; }
  weighted(entries) { // [[weight, value], ...]
    const total = entries.reduce((sum, [w]) => sum + w, 0); let r = this.float() * total;
    for (const [w, v] of entries) { r -= w; if (r <= 0) return v; }
    return entries[entries.length - 1][1];
  }
  shuffle(items) { const out = [...items]; for (let i = out.length - 1; i > 0; i--) { const j = this.int(0, i); [out[i], out[j]] = [out[j], out[i]]; } return out; }
  bytes(length) { const out = new Uint8Array(length); for (let i = 0; i < length; i++) out[i] = this.u32() & 0xff; return out; }

  // --- strings ---------------------------------------------------------------
  ascii(len, alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
    let s = ""; for (let i = 0; i < len; i++) s += alphabet[this.int(0, alphabet.length - 1)]; return s;
  }
  hex(len) { return this.ascii(len, "0123456789abcdef"); }
  /** A hostile-ish string: control chars, bidi, zero-width, surrogates, emoji, long runs. */
  nasty(maxLen = 64) {
    const kind = this.int(0, 13);
    switch (kind) {
      case 0: return "";
      case 1: return this.ascii(this.int(1, maxLen));
      case 2: return String.fromCharCode(this.int(0, 0x1f));
      case 3: return "\u200b\u200e\u202e".slice(0, this.int(1, 3)) + this.ascii(this.int(0, 8));
      case 4: return "\ud800"; // lone high surrogate
      case 5: return "\udc00" + this.ascii(3); // lone low surrogate
      case 6: return "\u{1F600}\ufe0f".repeat(this.int(1, 4));
      case 7: return "x".repeat(this.int(maxLen, maxLen * 64));
      case 8: return this.pick(["__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty"]);
      case 9: return this.pick(["javascript:alert(1)", "<script>", "role: admin", "password=1", "BEGIN RSA PRIVATE KEY", "$(id)", " onload=", "http://u:p@h/"]);
      case 10: return "\ufeff" + this.ascii(4);
      case 11: return "\u0000" + this.ascii(2);
      case 12: return this.ascii(this.int(1, 6)) + "\n" + this.ascii(this.int(1, 6));
      default: return this.unicode(this.int(1, maxLen));
    }
  }
  unicode(len) {
    let s = "";
    for (let i = 0; i < len; i++) {
      const r = this.float();
      const cp = r < 0.5 ? this.int(0x20, 0x7e) : r < 0.7 ? this.int(0x80, 0x7ff) : r < 0.85 ? this.int(0x800, 0xd7ff) : r < 0.95 ? this.int(0xe000, 0xffff) : this.int(0x10000, 0x10ffff);
      s += String.fromCodePoint(cp);
    }
    return s;
  }
  number() {
    return this.pick([0, -0, 1, -1, 2, 7, 1e3, 2 ** 31 - 1, 2 ** 31, 2 ** 32, 2 ** 53 - 1, 2 ** 53, -(2 ** 53), 1e308, -1e308, 0.5, -0.5, 1.5, 1e-9, NaN, Infinity, -Infinity, this.int(-1e6, 1e6), this.float() * 1e12]);
  }

  // --- JSON values -------------------------------------------------------------
  jsonValue(depth = 0, maxDepth = 4) {
    const r = this.float();
    if (depth >= maxDepth || r < 0.45) {
      return this.weighted([[3, null], [2, true], [2, false], [5, this.number()], [8, this.nasty()]]);
    }
    if (r < 0.7) { const n = this.int(0, 5); const out = []; for (let i = 0; i < n; i++) out.push(this.jsonValue(depth + 1, maxDepth)); return out; }
    const n = this.int(0, 6); const out = {};
    for (let i = 0; i < n; i++) out[this.bool(0.8) ? this.ascii(this.int(1, 8)) : this.nasty(12)] = this.jsonValue(depth + 1, maxDepth);
    return out;
  }
  deepValue(depth) { let v = []; for (let i = 0; i < depth; i++) v = this.bool() ? [v] : { a: v }; return v; }

  /** Structure-aware mutation of a valid JSON-ish value. Returns a NEW value. */
  mutate(value, rounds = 1) {
    let out = structuredCloneSafe(value);
    for (let i = 0; i < rounds; i++) out = this.mutateOnce(out);
    return out;
  }
  mutateOnce(value) {
    try { return this.mutateOnceUnsafe(value); } catch { return typeSwap(this, value); }
  }
  mutateOnceUnsafe(value) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const proto = Object.getPrototypeOf(value);
      if ((proto !== Object.prototype && proto !== null) || types.isProxy(value)) return this.bool(0.5) ? typeSwap(this, value) : this.jsonValue();
      const keys = Object.keys(value); const op = this.int(0, 9);
      if (op === 0 && keys.length) { delete value[this.pick(keys)]; return value; }
      if (op === 1) { value[this.bool(0.5) ? this.nasty(10) : this.ascii(this.int(1, 10))] = this.jsonValue(); return value; }
      if (op === 2 && keys.length) { const k = this.pick(keys); value[k] = this.jsonValue(); return value; }
      if (op === 3 && keys.length) { const k = this.pick(keys); value[k] = this.mutateOnce(value[k]); return value; }
      if (op === 4 && keys.length) { const k = this.pick(keys); value[k] = typeSwap(this, value[k]); return value; }
      if (op === 5) { Object.defineProperty(value, "__proto__", { value: { polluted: true }, enumerable: true, configurable: true, writable: true }); return value; }
      if (op === 6 && keys.length) { const k = this.pick(keys); value[k + " "] = value[k]; return value; }
      if (op === 7 && keys.length >= 2) { const a = this.pick(keys), b = this.pick(keys); [value[a], value[b]] = [value[b], value[a]]; return value; }
      if (op === 8) return this.jsonValue();
      if (keys.length) { const k = this.pick(keys); value[k] = this.mutateOnce(value[k]); }
      return value;
    }
    if (Array.isArray(value)) {
      const op = this.int(0, 6);
      if (op === 0 && value.length) value.splice(this.int(0, value.length - 1), 1);
      else if (op === 1) value.push(value.length ? structuredCloneSafe(this.pick(value)) : this.jsonValue());
      else if (op === 2 && value.length) { const i = this.int(0, value.length - 1); value[i] = this.mutateOnce(value[i]); }
      else if (op === 3) { const n = this.int(1, 200); for (let i = 0; i < n; i++) value.push(value.length ? structuredCloneSafe(value[0]) : 1); }
      else if (op === 4 && value.length) { value[this.int(0, value.length - 1)] = this.jsonValue(); }
      else if (op === 5) return this.deepValue(this.int(5, 400));
      else if (value.length >= 2) { const i = this.int(0, value.length - 1), j = this.int(0, value.length - 1); [value[i], value[j]] = [value[j], value[i]]; }
      return value;
    }
    if (typeof value === "string") return this.mutateString(value);
    if (typeof value === "number") return this.pick([value + 1, value - 1, -value, value * 2, Math.trunc(value) + 0.5, 0, this.number(), String(value)]);
    if (typeof value === "boolean") return this.pick([!value, 0, 1, "true", null]);
    if (value === null) return this.pick([undefined, 0, "", {}, []]);
    return value;
  }
  mutateString(s) {
    const op = this.int(0, 12);
    const at = s.length ? this.int(0, s.length - 1) : 0;
    switch (op) {
      case 0: return "";
      case 1: return s.slice(0, at);
      case 2: return s + s;
      case 3: return s.slice(0, at) + this.nasty(8) + s.slice(at);
      case 4: return s.toUpperCase();
      case 5: return s + "\n";
      case 6: return " " + s + " ";
      case 7: return s.repeat(this.int(2, 50));
      case 8: return s.slice(0, at) + String.fromCharCode(this.int(0, 0xff)) + s.slice(at + 1);
      case 9: return this.nasty(32);
      case 10: return s.replace(/[0-9a-f]/u, c => this.pick(["g", "G", "0", "f", "Z", "0x"]));
      case 11: return s.split("").reverse().join("");
      default: return s.slice(0, at) + this.unicode(this.int(1, 4)) + s.slice(at);
    }
  }
  /** Byte/text-level mutation of a serialized document (JSON text, line, raw body). */
  mutateText(text, rounds = 1) {
    let out = text;
    for (let i = 0; i < rounds; i++) {
      const at = out.length ? this.int(0, out.length - 1) : 0; const op = this.int(0, 15);
      switch (op) {
        case 0: out = out.slice(0, at); break;
        case 1: out = out.slice(0, at) + out.slice(at + this.int(1, 8)); break;
        case 2: out = out.slice(0, at) + this.pick(["{", "}", "[", "]", ",", ":", "\"", "\\", "\\u", "\\u00", "\\ud800", "\n", "\r", "\u0000", " ", "\t", "\ufeff"]) + out.slice(at); break;
        case 3: out = out.slice(0, at) + this.nasty(16) + out.slice(at); break;
        case 4: out = out + out.slice(0, this.int(0, out.length)); break;
        case 5: out = out.slice(0, at) + String.fromCharCode(this.int(0, 0x7f)) + out.slice(at + 1); break;
        case 6: out = out.replace(/"([^"\\]{1,20})"/u, (m, k) => `"${k}","${k}"`); break; // duplicate-ish
        case 7: out = out.replace(/"([A-Za-z])/u, (m, c) => `"\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`); break; // escaped key spelling
        case 8: out = out.replace(/\d+/u, d => this.pick(["-0", "1e999", "9".repeat(400), "0x10", "01", "1.", ".5", "NaN", "Infinity", "-", "1e", "1e+", `${d}${d}`])); break;
        case 9: out = out.replace(/true|false|null/u, this.pick(["True", "nul", "undefined", "fals", "0", "\"\""])); break;
        case 10: out = "[".repeat(this.int(1, 2000)) + out; break;
        case 11: out = out.slice(0, at) + "\\".repeat(this.int(1, 9)) + out.slice(at); break;
        case 12: out = out + " ".repeat(this.int(1, 4000)); break;
        case 13: out = out.slice(0, at) + "\"" + "a".repeat(this.int(100, 20000)) + "\"" + out.slice(at); break;
        case 14: out = out.replaceAll(":", this.pick([": ", " :", ":\n", "::", ""])); break;
        default: out = out.replace(/"/u, "'"); break;
      }
    }
    return out;
  }
}

function typeSwap(rng, v) {
  const plain = [null, undefined, 0, -1, 1.5, "", "0", "1", "true", true, false, [], {}, [v], { v }, "null", 1e400, NaN];
  const exotic = [Symbol.for("x"), () => v, new Date(0), /x/, BigInt(1), new Uint8Array(2), new Proxy({}, {}), Object.create(null)];
  return rng.bool(0.85) ? rng.pick(plain) : rng.pick(exotic);
}

/** JSON text for values that may carry exotic (non-JSON) members introduced by typeSwap. */
export function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, item) => {
    if (typeof item === "bigint") return Number(item);
    if (typeof item === "symbol") return String(item);
    if (typeof item === "function") return "[function]";
    if (item && typeof item === "object") { if (seen.has(item)) return "[circular]"; seen.add(item); }
    return item;
  });
}

export function structuredCloneSafe(value) {
  try { return structuredClone(value); } catch { return typeof value === "object" && value !== null ? JSON.parse(JSON.stringify(value, (k, x) => typeof x === "bigint" ? Number(x) : x)) : value; }
}
