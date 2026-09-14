import { failProjectCoordinationV1 } from "./errors";

/**
 * Strict single-object JSON reader for agent-authored coordination results.
 *
 * `JSON.parse` silently keeps the last of a set of duplicate keys, which would
 * let one result carry two different values for the same field and let a later
 * reader disagree with the value this engine validated. It also tolerates
 * nothing about surrounding prose, but callers frequently strip a code fence
 * first and then trust the remainder. This reader does neither: it consumes the
 * complete input as exactly one JSON object, refuses duplicate keys at any
 * depth, refuses `__proto__`/`constructor` keys, and refuses any byte before or
 * after the object (including a ``` fence or an explanatory sentence).
 */

const RESULT_LIMIT_BYTES = 65_536;
const MAX_DEPTH = 12;

class Reader {
  #index = 0;
  constructor(private readonly text: string) {}

  get index(): number { return this.#index; }

  peek(): string | undefined { return this.text[this.#index]; }

  take(): string {
    const value = this.text[this.#index];
    if (value === undefined) failProjectCoordinationV1("proposal_content_invalid");
    this.#index += 1;
    return value;
  }

  expect(character: string): void {
    if (this.take() !== character) failProjectCoordinationV1("proposal_content_invalid");
  }

  skipWhitespace(): void {
    while (this.#index < this.text.length && " \t\n\r".includes(this.text[this.#index]!)) this.#index += 1;
  }

  atEnd(): boolean { return this.#index >= this.text.length; }

  slice(from: number, to: number): string { return this.text.slice(from, to); }
}

function readString(reader: Reader): string {
  reader.expect("\"");
  let value = "";
  for (;;) {
    const character = reader.take();
    if (character === "\"") return value;
    if (character === "\\") {
      const escape = reader.take();
      switch (escape) {
        case "\"": value += "\""; break;
        case "\\": value += "\\"; break;
        case "/": value += "/"; break;
        case "b": value += "\b"; break;
        case "f": value += "\f"; break;
        case "n": value += "\n"; break;
        case "r": value += "\r"; break;
        case "t": value += "\t"; break;
        case "u": {
          const start = reader.index;
          for (let count = 0; count < 4; count += 1) {
            const digit = reader.take();
            if (!/[0-9a-fA-F]/.test(digit)) failProjectCoordinationV1("proposal_content_invalid");
          }
          value += String.fromCharCode(Number.parseInt(reader.slice(start, start + 4), 16));
          break;
        }
        default: failProjectCoordinationV1("proposal_content_invalid");
      }
      continue;
    }
    // Raw control characters are invalid JSON and are a common smuggling vector.
    if (character < " ") failProjectCoordinationV1("proposal_content_invalid");
    value += character;
  }
}

function readNumber(reader: Reader): number {
  const start = reader.index;
  if (reader.peek() === "-") reader.take();
  while (reader.peek() !== undefined && /[0-9]/.test(reader.peek()!)) reader.take();
  if (reader.peek() === ".") {
    reader.take();
    while (reader.peek() !== undefined && /[0-9]/.test(reader.peek()!)) reader.take();
  }
  if (reader.peek() === "e" || reader.peek() === "E") {
    reader.take();
    if (reader.peek() === "+" || reader.peek() === "-") reader.take();
    while (reader.peek() !== undefined && /[0-9]/.test(reader.peek()!)) reader.take();
  }
  const raw = reader.slice(start, reader.index);
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(raw)) failProjectCoordinationV1("proposal_content_invalid");
  const value = Number(raw);
  if (!Number.isFinite(value)) failProjectCoordinationV1("proposal_content_invalid");
  return value;
}

function readLiteral(reader: Reader, literal: string, value: null | boolean): null | boolean {
  for (const character of literal) if (reader.take() !== character) failProjectCoordinationV1("proposal_content_invalid");
  return value;
}

function readValue(reader: Reader, depth: number): unknown {
  if (depth > MAX_DEPTH) failProjectCoordinationV1("proposal_content_invalid");
  reader.skipWhitespace();
  const character = reader.peek();
  switch (character) {
    case "{": return readObject(reader, depth);
    case "[": return readArray(reader, depth);
    case "\"": return readString(reader);
    case "t": return readLiteral(reader, "true", true);
    case "f": return readLiteral(reader, "false", false);
    case "n": return readLiteral(reader, "null", null);
    default:
      if (character !== undefined && /[-0-9]/.test(character)) return readNumber(reader);
      return failProjectCoordinationV1("proposal_content_invalid");
  }
}

function readArray(reader: Reader, depth: number): unknown[] {
  reader.expect("[");
  const items: unknown[] = [];
  reader.skipWhitespace();
  if (reader.peek() === "]") { reader.take(); return items; }
  for (;;) {
    items.push(readValue(reader, depth + 1));
    reader.skipWhitespace();
    const next = reader.take();
    if (next === "]") return items;
    if (next !== ",") failProjectCoordinationV1("proposal_content_invalid");
  }
}

function readObject(reader: Reader, depth: number): Record<string, unknown> {
  reader.expect("{");
  const record = Object.create(null) as Record<string, unknown>;
  const seen = new Set<string>();
  reader.skipWhitespace();
  if (reader.peek() === "}") { reader.take(); return { ...record }; }
  for (;;) {
    reader.skipWhitespace();
    const key = readString(reader);
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      failProjectCoordinationV1("proposal_content_invalid");
    }
    if (seen.has(key)) failProjectCoordinationV1("proposal_duplicate_key");
    seen.add(key);
    reader.skipWhitespace();
    reader.expect(":");
    record[key] = readValue(reader, depth + 1);
    reader.skipWhitespace();
    const next = reader.take();
    if (next === "}") return { ...record };
    if (next !== ",") failProjectCoordinationV1("proposal_content_invalid");
  }
}

/**
 * Parses the exact retained result text as one strict JSON object. Duplicate
 * keys, surrounding prose, code fences, trailing content and over-limit text all
 * refuse with a bounded code. The parsed value never carries a prototype from
 * the input.
 */
export function parseStrictJsonObjectV1(text: unknown): Record<string, unknown> {
  if (typeof text !== "string") return failProjectCoordinationV1("proposal_content_invalid");
  if (Buffer.byteLength(text, "utf8") > RESULT_LIMIT_BYTES) {
    return failProjectCoordinationV1("proposal_content_too_large");
  }
  const reader = new Reader(text);
  reader.skipWhitespace();
  if (reader.peek() !== "{") return failProjectCoordinationV1("proposal_content_invalid");
  const value = readObject(reader, 0);
  reader.skipWhitespace();
  if (!reader.atEnd()) return failProjectCoordinationV1("proposal_content_invalid");
  return value;
}

export const PROJECT_COORDINATION_RESULT_LIMIT_BYTES_V1 = RESULT_LIMIT_BYTES;
