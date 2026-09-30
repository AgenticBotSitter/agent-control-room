import { posix as pathPosix } from "node:path";

export const UPDATER_REFEREE_MAX_RAW_DIFF_BYTES_V1 = 8 * 1024 * 1024;
export const UPDATER_REFEREE_MAX_DIFF_RECORDS_V1 = 100_000;

export type UpdaterRefereeClassV1 = "code" | "database" | "dependency" | "protected" | "updater";
export type UpdaterPlanClassV1 = "code-only" | "database" | "dependency" | "updater" | "setting";

export interface RunningUpdaterPolicyFilesV1 {
  protectedJson: string;
  classesJson: string;
}

export interface CandidateDiffV1 {
  raw: Uint8Array;
  /** Blob contents keyed by the object id printed by `git diff --raw`. */
  blobs?: Readonly<Record<string, Uint8Array | string>>;
}

export interface RawDiffRecordV1 {
  oldMode: string;
  newMode: string;
  oldOid: string;
  newOid: string;
  status: "A" | "M" | "D" | "T" | "R" | "C";
  score: number | null;
  oldPath: string | null;
  newPath: string | null;
}

export interface ProtectedPathHitV1 {
  path: string;
  entryId: string;
  reason: string;
  onChange: "protected" | "updater" | "refuse_reinstall";
}

export interface UpdaterRefereeRefusalV1 {
  id: string;
  text: string;
}

export interface UpdaterRefereeResultV1 {
  classification: UpdaterPlanClassV1;
  classes: UpdaterRefereeClassV1[];
  protectedPaths: ProtectedPathHitV1[];
  approvalNeeded: {
    phonePasskey: boolean;
    macConfirm: boolean;
  };
  independentReviewRequired: boolean;
  refused: boolean;
  refusals: UpdaterRefereeRefusalV1[];
  filesChanged: number;
  filesAdded: number;
  filesDeleted: number;
  changedPaths: string[];
  changesDatabase: boolean;
  changesUpdater: boolean;
}

interface ProtectedEntry {
  id: string;
  patterns: string[];
  exclude: string[];
  onChange: "protected" | "updater" | "refuse_reinstall";
  reason: string;
}

interface DetectionRule {
  patterns: string[];
  exclude: string[];
}

interface PackageRules {
  dependency: Set<string>;
  protected: Set<string>;
  code: Set<string>;
}

interface ParsedPolicies {
  entries: ProtectedEntry[];
  database: DetectionRule;
  dependency: DetectionRule;
  packageRules: PackageRules;
  refusalText: Map<string, string>;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const modePattern = /^(?:000000|100644|100755|120000|160000)$/u;
// `git diff --raw` abbreviates object ids unless --full-index is supplied. The
// updater accepts Git's unambiguous abbreviation and the full SHA-1/SHA-256 id.
const oidPattern = /^[0-9a-f]{7,64}$/u;
const statusPattern = /^([AMDT])$|^([RC])(\d{1,3})$/u;

class JsonReader {
  #index = 0;
  constructor(private readonly text: string) {}
  peek(): string | undefined { return this.text[this.#index]; }
  take(): string {
    const value = this.text[this.#index];
    if (value === undefined) throw new Error("json_invalid");
    this.#index += 1;
    return value;
  }
  expect(value: string): void { if (this.take() !== value) throw new Error("json_invalid"); }
  whitespace(): void { while (this.peek() !== undefined && " \t\r\n".includes(this.peek()!)) this.#index += 1; }
  get index(): number { return this.#index; }
  slice(from: number): string { return this.text.slice(from, this.#index); }
  end(): boolean { return this.#index === this.text.length; }
}

function jsonString(reader: JsonReader): string {
  reader.expect('"');
  let raw = '"';
  for (;;) {
    const character = reader.take();
    raw += character;
    if (character === '"') return JSON.parse(raw) as string;
    if (character < " ") throw new Error("json_invalid");
    if (character === "\\") {
      const escaped = reader.take();
      raw += escaped;
      if (escaped === "u") {
        for (let index = 0; index < 4; index += 1) {
          const digit = reader.take();
          if (!/[0-9a-f]/iu.test(digit)) throw new Error("json_invalid");
          raw += digit;
        }
      } else if (!'"\\/bfnrt'.includes(escaped)) throw new Error("json_invalid");
    }
  }
}

function jsonValue(reader: JsonReader, depth: number): unknown {
  if (depth > 32) throw new Error("json_invalid");
  reader.whitespace();
  if (reader.peek() === "{") return jsonObject(reader, depth + 1);
  if (reader.peek() === "[") {
    reader.take();
    const values: unknown[] = [];
    reader.whitespace();
    if (reader.peek() === "]") { reader.take(); return values; }
    for (;;) {
      values.push(jsonValue(reader, depth + 1));
      reader.whitespace();
      const delimiter = reader.take();
      if (delimiter === "]") return values;
      if (delimiter !== ",") throw new Error("json_invalid");
    }
  }
  if (reader.peek() === '"') return jsonString(reader);
  const start = reader.index;
  while (reader.peek() !== undefined && !" \t\r\n,]}".includes(reader.peek()!)) reader.take();
  const token = reader.slice(start);
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "null") return null;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(token)) throw new Error("json_invalid");
  const value = Number(token);
  if (!Number.isFinite(value)) throw new Error("json_invalid");
  return value;
}

function jsonObject(reader: JsonReader, depth: number): Record<string, unknown> {
  reader.expect("{");
  const result = Object.create(null) as Record<string, unknown>;
  const keys = new Set<string>();
  reader.whitespace();
  if (reader.peek() === "}") { reader.take(); return result; }
  for (;;) {
    reader.whitespace();
    const key = jsonString(reader);
    if (keys.has(key)) throw new Error("json_duplicate_key");
    if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error("json_invalid");
    keys.add(key);
    reader.whitespace();
    reader.expect(":");
    result[key] = jsonValue(reader, depth + 1);
    reader.whitespace();
    const delimiter = reader.take();
    if (delimiter === "}") return result;
    if (delimiter !== ",") throw new Error("json_invalid");
  }
}

function parseStrictJsonObject(text: string): Record<string, unknown> {
  const reader = new JsonReader(text);
  reader.whitespace();
  const value = jsonObject(reader, 0);
  reader.whitespace();
  if (!reader.end()) throw new Error("json_invalid");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("policy_invalid");
  return value as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) throw new Error("policy_invalid");
  return value as string[];
}

function validateGlobPattern(pattern: string): void {
  const segments = pattern.split("/");
  if (segments.some(segment => segment.length === 0)) throw new Error("policy_invalid");
  for (const segment of segments) {
    if (segment.includes("**") && segment !== "**") throw new Error("policy_invalid");
    for (let index = 0; index < segment.length; index += 1) {
      if (segment[index] === "}") throw new Error("policy_invalid");
      if (segment[index] !== "{") continue;
      const close = segment.indexOf("}", index + 1);
      if (close < 0 || segment.slice(index + 1, close).includes("{")) throw new Error("policy_invalid");
      const alternatives = segment.slice(index + 1, close).split(",");
      if (alternatives.length < 2 || alternatives.some(alternative => alternative.length === 0))
        throw new Error("policy_invalid");
      index = close;
    }
  }
}

function parsePolicies(policyFiles: RunningUpdaterPolicyFilesV1): ParsedPolicies {
  const protectedPolicy = parseStrictJsonObject(policyFiles.protectedJson);
  const classesPolicy = parseStrictJsonObject(policyFiles.classesJson);
  if (protectedPolicy.schema !== "control-room.policy.protected/v1" ||
      classesPolicy.schema !== "control-room.policy.classes/v1" ||
      protectedPolicy.policyVersion !== 1 || classesPolicy.policyVersion !== 1) throw new Error("policy_invalid");
  if (!Array.isArray(protectedPolicy.entries)) throw new Error("policy_invalid");
  const ids = new Set<string>();
  const entries = protectedPolicy.entries.map(raw => {
    const value = record(raw);
    if (typeof value.id !== "string" || ids.has(value.id) || typeof value.reason !== "string" ||
        !["protected", "updater", "refuse_reinstall"].includes(String(value.onChange))) throw new Error("policy_invalid");
    ids.add(value.id);
    const patterns = strings(value.patterns);
    const exclude = value.exclude === undefined ? [] : strings(value.exclude);
    if (patterns.length === 0 || [...patterns, ...exclude].some(pattern => pattern.length === 0)) throw new Error("policy_invalid");
    for (const pattern of [...patterns, ...exclude]) validateGlobPattern(pattern);
    return { id: value.id, patterns, exclude,
      onChange: value.onChange as ProtectedEntry["onChange"], reason: value.reason };
  });
  if (!Array.isArray(classesPolicy.classes) || !Array.isArray(classesPolicy.refusals)) throw new Error("policy_invalid");
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of classesPolicy.classes) {
    const value = record(raw);
    if (typeof value.id !== "string" || byId.has(value.id)) throw new Error("policy_invalid");
    byId.set(value.id, value);
  }
  const detection = (id: string): DetectionRule => {
    const value = record(byId.get(id)?.detection);
    const patterns = strings(value.patterns), exclude = value.exclude === undefined ? [] : strings(value.exclude);
    for (const pattern of [...patterns, ...exclude]) validateGlobPattern(pattern);
    return { patterns, exclude };
  };
  const dependencyValue = record(byId.get("dependency")?.detection);
  const packageValue = record(dependencyValue.packageJsonKeys);
  const packageRules = {
    dependency: new Set(strings(packageValue.dependency)),
    protected: new Set(strings(packageValue.protected)),
    code: new Set(strings(packageValue.code)),
  };
  const refusalText = new Map<string, string>();
  for (const raw of classesPolicy.refusals) {
    const value = record(raw);
    if (typeof value.id !== "string" || typeof value.text !== "string" || refusalText.has(value.id)) throw new Error("policy_invalid");
    refusalText.set(value.id, value.text);
  }
  return { entries, database: detection("database"), dependency: detection("dependency"), packageRules, refusalText };
}

function segmentMatches(pattern: string, value: string): boolean {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else if (character === "{") {
      const close = pattern.indexOf("}", index + 1);
      if (close < 0 || pattern.slice(index + 1, close).includes("{")) throw new Error("policy_invalid");
      const alternatives = pattern.slice(index + 1, close).split(",");
      if (alternatives.length < 2 || alternatives.some(alternative => alternative.length === 0 || alternative.includes("/")))
        throw new Error("policy_invalid");
      source += `(?:${alternatives.map(alternative => segmentSource(alternative)).join("|")})`;
      index = close;
    } else source += character.replace(/[\\^$.[\]|()+]/u, "\\$&");
  }
  return new RegExp(`^${source}$`, "u").test(value);
}

function segmentSource(pattern: string): string {
  let source = "";
  for (const character of pattern) {
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += character.replace(/[\\^$.[\]|()+{}]/u, "\\$&");
  }
  return source;
}

export function updaterPolicyGlobMatchesV1(pattern: string, path: string): boolean {
  const patterns = pattern.toLowerCase().split("/");
  const paths = path.toLowerCase().split("/");
  const memo = new Map<string, boolean>();
  const visit = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let matched: boolean;
    if (patternIndex === patterns.length) matched = pathIndex === paths.length;
    else if (patterns[patternIndex] === "**") matched = visit(patternIndex + 1, pathIndex) ||
      (pathIndex < paths.length && visit(patternIndex, pathIndex + 1));
    else matched = pathIndex < paths.length && segmentMatches(patterns[patternIndex]!, paths[pathIndex]!) &&
      visit(patternIndex + 1, pathIndex + 1);
    memo.set(key, matched);
    return matched;
  };
  return visit(0, 0);
}

function matches(rule: DetectionRule, path: string): boolean {
  return rule.patterns.some(pattern => updaterPolicyGlobMatchesV1(pattern, path)) &&
    !rule.exclude.some(pattern => updaterPolicyGlobMatchesV1(pattern, path));
}

function safePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\")) return false;
  if ([...encoder.encode(path)].some(byte => byte < 0x21 || byte > 0x7e)) return false;
  const segments = path.split("/");
  return segments.every(segment => segment.length > 0 && segment !== ".." && segment.toLowerCase() !== ".git");
}

function ascii(buffer: Uint8Array): string {
  if ([...buffer].some(byte => byte < 0x20 || byte > 0x7e)) throw new Error("diff_unreadable");
  return String.fromCharCode(...buffer);
}

function diffPath(buffer: Uint8Array | undefined): string {
  if (buffer === undefined || buffer.byteLength === 0) throw new Error("diff_unreadable");
  return utf8.decode(buffer);
}

export function parseUpdaterRawDiffV1(raw: Uint8Array): RawDiffRecordV1[] {
  if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > UPDATER_REFEREE_MAX_RAW_DIFF_BYTES_V1)
    throw new Error("diff_unreadable");
  const fields: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < raw.byteLength; index += 1) {
    if (raw[index] !== 0) continue;
    fields.push(raw.subarray(start, index));
    start = index + 1;
  }
  if (start !== raw.byteLength || fields.some(field => field.byteLength === 0)) throw new Error("diff_unreadable");
  const output: RawDiffRecordV1[] = [];
  for (let index = 0; index < fields.length;) {
    if (output.length >= UPDATER_REFEREE_MAX_DIFF_RECORDS_V1) throw new Error("diff_unreadable");
    const header = ascii(fields[index++]!);
    const parts = header.split(" ");
    if (parts.length !== 5 || !parts[0]!.startsWith(":")) throw new Error("diff_unreadable");
    const oldMode = parts[0]!.slice(1), newMode = parts[1]!, oldOid = parts[2]!, newOid = parts[3]!;
    const statusMatch = statusPattern.exec(parts[4]!);
    if (!modePattern.test(oldMode) || !modePattern.test(newMode) || !oidPattern.test(oldOid) ||
        !oidPattern.test(newOid) || statusMatch === null) throw new Error("diff_unreadable");
    const status = (statusMatch[1] ?? statusMatch[2]) as RawDiffRecordV1["status"];
    const score = statusMatch[3] === undefined ? null : Number(statusMatch[3]);
    if ((status === "R" || status === "C") && (score === null || score > 100)) throw new Error("diff_unreadable");
    if ((status === "A" && oldMode !== "000000") || (status === "D" && newMode !== "000000") ||
        (status !== "A" && oldMode === "000000") || (status !== "D" && newMode === "000000"))
      throw new Error("diff_unreadable");
    const oldPath = diffPath(fields[index++]);
    const newPath = status === "R" || status === "C" ? diffPath(fields[index++]) :
      status === "D" ? null : oldPath;
    output.push({ oldMode, newMode, oldOid, newOid, status, score,
      oldPath: status === "A" ? null : oldPath, newPath });
  }
  return output;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
}

function blobText(diff: CandidateDiffV1, oid: string, maximumBytes: number): string {
  const value = diff.blobs?.[oid];
  if (value === undefined) throw new Error("diff_unreadable");
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  if (bytes.byteLength > maximumBytes) throw new Error("diff_unreadable");
  return utf8.decode(bytes);
}

function lexicalSymlinkTarget(path: string, target: string): { escaped: boolean; path: string | null } {
  if (target.length === 0 || target.startsWith("/") || target.includes("\0") || target.includes("\\") ||
      [...encoder.encode(target)].some(byte => byte < 0x21 || byte > 0x7e)) return { escaped: true, path: null };
  const segments = pathPosix.dirname(path).split("/").filter(segment => segment !== ".");
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return { escaped: true, path: null };
      segments.pop();
    } else segments.push(segment);
  }
  return { escaped: false, path: segments.join("/") };
}

function archiveAttributesUnsafe(text: string): boolean {
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line === "* text=auto eol=lf") continue;
    const tokens = line.split(/[ \t]+/u).slice(1);
    for (const token of tokens) {
      const lower = token.toLowerCase();
      if (lower === "export-ignore" || lower === "export-subst" || lower === "ident" ||
          lower === "-text" || lower === "text" || lower.startsWith("text=") ||
          lower.startsWith("filter") || lower.startsWith("working-tree-encoding") || lower === "eol=crlf") return true;
    }
  }
  return false;
}

function failure(id: string, text: string): UpdaterRefereeResultV1 {
  return { classification: "updater", classes: ["updater", "protected"], protectedPaths: [],
    approvalNeeded: { phonePasskey: true, macConfirm: true }, independentReviewRequired: true,
    refused: true, refusals: [{ id, text }], filesChanged: 0, filesAdded: 0, filesDeleted: 0,
    changedPaths: [], changesDatabase: false, changesUpdater: true };
}

export function classifyUpdaterCandidateV1(
  policyFiles: RunningUpdaterPolicyFilesV1,
  diff: CandidateDiffV1,
): UpdaterRefereeResultV1 {
  let policy: ParsedPolicies;
  let records: RawDiffRecordV1[];
  try {
    policy = parsePolicies(policyFiles);
    records = parseUpdaterRawDiffV1(diff.raw);
  } catch {
    return failure("diff_unreadable", "Control Room couldn't read what this update changes.");
  }
  const classes = new Set<UpdaterRefereeClassV1>();
  const hits = new Map<string, ProtectedPathHitV1>();
  const refusals = new Map<string, UpdaterRefereeRefusalV1>();
  const changedPaths = new Set<string>();
  const refusal = (id: string, fallback: string) => refusals.set(id,
    { id, text: policy.refusalText.get(id) ?? fallback });
  const hit = (path: string, entryId: string, reason: string, onChange: ProtectedPathHitV1["onChange"]) => {
    hits.set(`${path}\0${entryId}`, { path, entryId, reason, onChange });
    classes.add("protected");
    if (onChange === "updater" || onChange === "refuse_reinstall") classes.add("updater");
    if (onChange === "refuse_reinstall") refusal("needs_reinstall", "This change needs a reinstall on the Mac.");
  };
  const classifyPath = (path: string) => {
    changedPaths.add(path);
    if (!safePath(path)) { refusal("path_not_allowed", "This update has a file name Control Room can't check safely."); return; }
    for (const entry of policy.entries) {
      if (entry.patterns.some(pattern => updaterPolicyGlobMatchesV1(pattern, path)) &&
          !entry.exclude.some(pattern => updaterPolicyGlobMatchesV1(pattern, path)))
        hit(path, entry.id, entry.reason, entry.onChange);
    }
    if (matches(policy.database, path)) classes.add("database");
    if (!path.toLowerCase().endsWith("/package.json") && path.toLowerCase() !== "package.json" &&
        matches(policy.dependency, path)) classes.add("dependency");
  };
  let filesAdded = 0, filesDeleted = 0;
  try {
    for (const entry of records) {
      const paths = [...new Set([entry.oldPath, entry.newPath].filter((path): path is string => path !== null))];
      for (const path of paths) classifyPath(path);
      if (entry.status === "A") filesAdded += 1;
      if (entry.status === "D") filesDeleted += 1;
      if (entry.status === "C") filesAdded += 1;
      if (entry.oldMode === "160000" || entry.newMode === "160000" || paths.some(path => {
        const lower = path.toLowerCase(); return lower === ".gitmodules" || lower.endsWith("/.gitmodules");
      }))
        refusal("submodule", "Submodules aren't supported.");
      if (entry.oldMode === "120000" || entry.newMode === "120000") {
        for (const path of paths) hit(path, "symlink", "A changed symlink can redirect reviewed paths.", "protected");
        const links: Array<[string | null, string, string]> = [];
        if (entry.oldMode === "120000" && entry.oldPath !== null) links.push([entry.oldPath, entry.oldOid, "old"]);
        if (entry.newMode === "120000" && entry.newPath !== null) links.push([entry.newPath, entry.newOid, "new"]);
        for (const [path, oid] of links) {
          const target = blobText(diff, oid, 4096);
          const resolved = lexicalSymlinkTarget(path!, target);
          if (resolved.escaped) refusal("symlink_escape", "This update has a link pointing outside Control Room.");
          if (resolved.path !== null) {
            for (const protectedEntry of policy.entries) {
              if (!protectedEntry.patterns.some(pattern => updaterPolicyGlobMatchesV1(pattern, resolved.path!)) ||
                  protectedEntry.exclude.some(pattern => updaterPolicyGlobMatchesV1(pattern, resolved.path!))) continue;
              hit(path!, `symlink-target:${protectedEntry.id}`, `The link targets ${resolved.path}: ${protectedEntry.reason}`,
                protectedEntry.onChange);
            }
          }
        }
      }
      const packagePaths = paths.filter(path => {
        const lower = path.toLowerCase(); return lower === "package.json" || lower.endsWith("/package.json");
      });
      if (packagePaths.length > 0) {
        const packagePath = packagePaths[0]!;
        if (entry.status === "A" || entry.status === "D" || entry.status === "R" || entry.status === "C")
          classes.add("dependency");
        else {
          let oldPackage: Record<string, unknown>, newPackage: Record<string, unknown>;
          try {
            oldPackage = parseStrictJsonObject(blobText(diff, entry.oldOid, 1024 * 1024));
            newPackage = parseStrictJsonObject(blobText(diff, entry.newOid, 1024 * 1024));
          } catch {
            classes.add("dependency");
            hit(packagePath, "package-json-unparseable", "A package manifest could not be read unambiguously.", "protected");
            oldPackage = Object.create(null); newPackage = Object.create(null);
          }
          for (const key of new Set([...Object.keys(oldPackage), ...Object.keys(newPackage)])) {
            if (stable(oldPackage[key]) === stable(newPackage[key])) continue;
            if (policy.packageRules.protected.has(key))
              hit(packagePath, `package-json:${key}`, `The package.json ${key} key controls required commands.`, "protected");
            else if (policy.packageRules.code.has(key)) { /* explicitly ordinary metadata */ }
            else classes.add("dependency");
          }
        }
      }
      const newLower = entry.newPath?.toLowerCase();
      if ((newLower === ".gitattributes" || newLower?.endsWith("/.gitattributes")) && entry.newMode !== "000000") {
        if (archiveAttributesUnsafe(blobText(diff, entry.newOid, 1024 * 1024)))
          refusal("archive_attributes", "This update changes how its files are unpacked.");
      }
    }
  } catch {
    refusal("diff_unreadable", "Control Room couldn't read what this update changes.");
  }
  if (classes.has("updater") && classes.has("database"))
    refusal("updater_with_database", "An update to the updater can't also change the database. Split it into two updates.");
  if (classes.size === 0) classes.add("code");
  const classification: UpdaterPlanClassV1 = classes.has("updater") ? "updater" : classes.has("database") ? "database" :
    classes.has("dependency") ? "dependency" : "code-only";
  const orderedClasses = (["code", "database", "dependency", "protected", "updater"] as const)
    .filter(value => classes.has(value));
  const protectedPaths = [...hits.values()].sort((left, right) => left.path.localeCompare(right.path) ||
    left.entryId.localeCompare(right.entryId));
  const refusalList = [...refusals.values()].sort((left, right) => left.id.localeCompare(right.id));
  return { classification, classes: orderedClasses, protectedPaths,
    approvalNeeded: { phonePasskey: true, macConfirm: classes.has("updater") },
    independentReviewRequired: classes.has("database") || classes.has("dependency") || classes.has("protected") || classes.has("updater"),
    refused: refusalList.length > 0, refusals: refusalList, filesChanged: records.length, filesAdded, filesDeleted,
    changedPaths: [...changedPaths].sort(), changesDatabase: classes.has("database"), changesUpdater: classes.has("updater") };
}

export function classifyUpdaterSettingV1(): UpdaterRefereeResultV1 {
  return { classification: "setting", classes: [], protectedPaths: [],
    approvalNeeded: { phonePasskey: true, macConfirm: true }, independentReviewRequired: false,
    refused: false, refusals: [], filesChanged: 0, filesAdded: 0, filesDeleted: 0,
    changedPaths: [], changesDatabase: false, changesUpdater: false };
}
