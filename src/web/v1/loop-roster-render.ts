import { createHash } from "node:crypto";

import { loopRosterColumnsV1, type LoopRosterRowV1 } from "./loop-roster-columns";

export { loopRosterColumnsV1, type LoopRosterColumnV1, type LoopRosterRowV1 } from "./loop-roster-columns";

export class LoopRosterFormatError extends Error {
  constructor(readonly reason: string) { super("loop_roster_format"); }
}

// Python's str.splitlines boundaries: cr reads the file with them, so the product splits the same way.
const pythonLineBreak = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u;
// The same characters inside a field would split a rendered line; the database refuses tab/CR/LF too.
const fieldBreak = /[\t\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/u;
// Python's str.strip() whitespace for "blank line" detection; cr skips such lines and "#" comments.
const blank = (line: string) => line.replace(/[\s\x1c-\x1f\x85]/gu, "") === "";

export const loopRosterSha256V1 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Header, then rows in the given order; tab separated, LF, trailing newline, no comments.
 * For today's tools `models.tsv` this reproduces the bytes exactly. */
export function renderLoopRosterV1(rows: readonly LoopRosterRowV1[]): string {
  const lines = [loopRosterColumnsV1.join("\t")];
  for (const row of rows) {
    const values = loopRosterColumnsV1.map(column => row[column]);
    if (values.some(value => typeof value !== "string" || fieldBreak.test(value))) throw new LoopRosterFormatError("field_break");
    lines.push(values.join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

/** Reads a roster file the way cr does (header line, then non-blank, non-comment rows).
 * Only the current 13-column header is accepted: the product stores max_build_grade for every row.
 * Structure only; the caller runs `cr models check` for the rules. */
export function parseLoopRosterV1(text: string): LoopRosterRowV1[] {
  const lines = text.split(pythonLineBreak);
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] !== loopRosterColumnsV1.join("\t")) throw new LoopRosterFormatError("header");
  const rows: LoopRosterRowV1[] = [];
  for (const line of lines.slice(1)) {
    if (blank(line) || line.startsWith("#")) continue;
    const values = line.split("\t");
    if (values.length !== loopRosterColumnsV1.length) throw new LoopRosterFormatError("columns");
    rows.push(Object.freeze(Object.fromEntries(loopRosterColumnsV1.map((column, index) => [column, values[index]!]))) as LoopRosterRowV1);
  }
  return rows;
}
