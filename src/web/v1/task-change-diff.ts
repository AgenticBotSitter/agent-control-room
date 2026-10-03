import type { TaskWorktreeChangeDetail } from "./task-result-wire";

export const TASK_CHANGE_DIFF_LINE_LIMIT_V1 = 2_000;
export const TASK_CHANGE_BIG_FILE_LINES_V1 = 160;
export const TASK_CHANGE_BIG_FILE_BYTES_V1 = 16_384;

export type TaskChangeLineKindV1 = "context" | "added" | "removed" | "hunk" | "metadata";

export type TaskChangeUnifiedLineV1 = Readonly<{
  kind: TaskChangeLineKindV1;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}>;

export type TaskChangeSplitRowV1 = Readonly<{
  oldLine: number | null;
  oldText: string | null;
  oldKind: "context" | "removed" | null;
  newLine: number | null;
  newText: string | null;
  newKind: "context" | "added" | null;
}>;

export type TaskFileChangeViewV1 = Readonly<{
  path: string;
  kind: "added" | "modified" | "deleted";
  bytes: number;
  sensitiveAreas: readonly string[];
  summary: string;
  unifiedLines: readonly TaskChangeUnifiedLineV1[];
  splitRows: readonly TaskChangeSplitRowV1[];
  addedLines: number;
  removedLines: number;
  large: boolean;
  diffRetained: boolean;
  displayTruncated: boolean;
}>;

export type TaskChangeViewV1 = Readonly<{
  files: readonly TaskFileChangeViewV1[];
  displayLineLimit: number;
  displayTruncated: boolean;
}>;

type ParsedBlock = Readonly<{ oldPath?: string; newPath?: string; lines: readonly string[] }>;

function decodeGitQuotedPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  return body.replace(/\\([\\"tnr]|[0-7]{1,3})/gu, (_match, escaped: string) => {
    if (/^[0-7]/u.test(escaped)) return String.fromCharCode(Number.parseInt(escaped, 8));
    return escaped === "t" ? "\t" : escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped;
  });
}

function headerPath(line: string): string | undefined {
  const raw = line.slice(4).split("\t", 1)[0] ?? "";
  if (raw === "/dev/null") return undefined;
  const decoded = decodeGitQuotedPath(raw);
  return decoded.startsWith("a/") || decoded.startsWith("b/") ? decoded.slice(2) : decoded;
}

function blocks(text: string): readonly ParsedBlock[] {
  if (!text) return [];
  const source = text.split("\n"), groups: string[][] = [];
  let current: string[] = [];
  for (const line of source) {
    if (line.startsWith("diff --git ") && current.length) { groups.push(current); current = []; }
    current.push(line);
  }
  if (current.length) groups.push(current);
  return groups.map(lines => ({
    oldPath: lines.find(line => line.startsWith("--- ")) ? headerPath(lines.find(line => line.startsWith("--- "))!) : undefined,
    newPath: lines.find(line => line.startsWith("+++ ")) ? headerPath(lines.find(line => line.startsWith("+++ "))!) : undefined,
    lines,
  }));
}

function sensitiveAreas(path: string): readonly string[] {
  const normalized = path.toLowerCase(), areas: string[] = [];
  if (normalized.startsWith("db/")) areas.push("Database");
  if (/(^|\/)migrations?(\/|$)/u.test(normalized)) areas.push("Migration");
  if (/(^|\/)security(\/|$)/u.test(normalized)) areas.push("Security");
  if (normalized === ".github" || normalized.startsWith(".github/")) areas.push("GitHub automation");
  return areas;
}

function parsedLines(lines: readonly string[]): readonly TaskChangeUnifiedLineV1[] {
  const result: TaskChangeUnifiedLineV1[] = [];
  let oldLine: number | null = null, newLine: number | null = null;
  for (const text of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]);
      result.push({ kind: "hunk", oldLine: null, newLine: null, text });
    } else if (oldLine !== null && newLine !== null && text.startsWith("+") && !text.startsWith("+++")) {
      result.push({ kind: "added", oldLine: null, newLine, text }); newLine++;
    } else if (oldLine !== null && newLine !== null && text.startsWith("-") && !text.startsWith("---")) {
      result.push({ kind: "removed", oldLine, newLine: null, text }); oldLine++;
    } else if (oldLine !== null && newLine !== null && text.startsWith(" ")) {
      result.push({ kind: "context", oldLine, newLine, text }); oldLine++; newLine++;
    } else {
      result.push({ kind: "metadata", oldLine: null, newLine: null, text });
    }
  }
  return result;
}

function splitRows(lines: readonly TaskChangeUnifiedLineV1[]): readonly TaskChangeSplitRowV1[] {
  const rows: TaskChangeSplitRowV1[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.kind === "context") {
      rows.push({ oldLine: line.oldLine, oldText: line.text.slice(1), oldKind: "context",
        newLine: line.newLine, newText: line.text.slice(1), newKind: "context" });
      index++; continue;
    }
    if (line.kind !== "removed" && line.kind !== "added") { index++; continue; }
    const removed: TaskChangeUnifiedLineV1[] = [], added: TaskChangeUnifiedLineV1[] = [];
    while (index < lines.length && ["removed", "added"].includes(lines[index]!.kind)) {
      const changed = lines[index++]!;
      if (changed.kind === "removed") removed.push(changed); else added.push(changed);
    }
    for (let offset = 0; offset < Math.max(removed.length, added.length); offset++) {
      const left = removed[offset], right = added[offset];
      rows.push({ oldLine: left?.oldLine ?? null, oldText: left?.text.slice(1) ?? null,
        oldKind: left ? "removed" : null, newLine: right?.newLine ?? null,
        newText: right?.text.slice(1) ?? null, newKind: right ? "added" : null });
    }
  }
  return rows;
}

function summary(kind: TaskFileChangeViewV1["kind"], added: number, removed: number, retained: boolean): string {
  if (!retained) return `${kind === "added" ? "Added" : kind === "deleted" ? "Deleted" : "Modified"}; detailed lines are not present in the retained diff evidence.`;
  if (kind === "added") return `Added with ${added.toLocaleString()} line${added === 1 ? "" : "s"} recorded in the retained diff evidence.`;
  if (kind === "deleted") return `Deleted with ${removed.toLocaleString()} line${removed === 1 ? "" : "s"} recorded in the retained diff evidence.`;
  return `Modified with ${added.toLocaleString()} line${added === 1 ? "" : "s"} added and ${removed.toLocaleString()} removed in the retained diff evidence.`;
}

/**
 * Builds a bounded, display-only projection from the already-verified audit.
 * Only paths in the audit inventory are returned; patch headers cannot add a
 * file to the owner view. The global line budget prevents a hostile pattern of
 * tiny lines from expanding the 64-KiB retained patch into an enormous DOM.
 */
export function projectTaskChangeViewV1(evidence: TaskWorktreeChangeDetail): TaskChangeViewV1 {
  const byPath = new Map<string, ParsedBlock>();
  for (const block of blocks(evidence.unifiedDiff.text)) {
    if (block.newPath) byPath.set(block.newPath, block);
    if (block.oldPath) byPath.set(block.oldPath, block);
  }
  let remaining = TASK_CHANGE_DIFF_LINE_LIMIT_V1, displayTruncated = false;
  const files = evidence.changes.map(change => {
    const block = byPath.get(change.path), completeLines = block ? parsedLines(block.lines) : [];
    const retained = completeLines.some(line => line.kind === "hunk");
    const addedLines = completeLines.filter(line => line.kind === "added").length;
    const removedLines = completeLines.filter(line => line.kind === "removed").length;
    const visibleLines = completeLines.slice(0, remaining);
    remaining -= visibleLines.length;
    const fileTruncated = visibleLines.length < completeLines.length;
    displayTruncated ||= fileTruncated;
    return Object.freeze({ path: change.path, kind: change.kind, bytes: change.bytes,
      sensitiveAreas: Object.freeze([...sensitiveAreas(change.path)]),
      summary: summary(change.kind, addedLines, removedLines, retained),
      unifiedLines: Object.freeze(visibleLines), splitRows: Object.freeze([...splitRows(visibleLines)]),
      addedLines, removedLines, large: change.bytes > TASK_CHANGE_BIG_FILE_BYTES_V1
        || completeLines.length > TASK_CHANGE_BIG_FILE_LINES_V1,
      diffRetained: retained, displayTruncated: fileTruncated });
  });
  return Object.freeze({ files: Object.freeze(files), displayLineLimit: TASK_CHANGE_DIFF_LINE_LIMIT_V1,
    displayTruncated });
}
