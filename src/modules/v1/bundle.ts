import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import {
  PORTABLE_PRINTABLE_TEXT_V1, assertNoHiddenTextV1, assertNoPortablePrototypePollutionV1,
} from "../../security/inert-portable-input";
import { isModuleSemverV1, parseModuleManifestV1, type ModuleManifestV1 } from "./manifest";

/**
 * Canonical module bundle verification. This proves which exact bytes were
 * offered, whether an owner-trusted key signed them, and what authority the
 * manifest asks for. It never loads, evaluates, stages, or migrates anything:
 * the result is inert data for the owner's approval screen and ledger.
 */
export const MODULE_BUNDLE_SCHEMA_V1 = "control-room.module-bundle/v1" as const;
export const MODULE_SIGNATURE_SCHEMA_V1 = "control-room.module-signature/v1" as const;
const SIGNATURE_PURPOSE_V1 = "control-room.module-bundle-signature/v1";
const SURFACE_NAMESPACE_V1 = "control-room.module-authority-surface/v1";
const DIFF_NAMESPACE_V1 = "control-room.module-permission-diff/v1";

const MAX_FILES = 256;
const MAX_FILE_BYTES = 1_048_576;
const MAX_TOTAL_BYTES = 8_388_608;
const MAX_PATH_LENGTH = 200;
const MAX_PATH_DEPTH = 8;
const MAX_TRUSTED_KEYS = 32;
const MAX_REVIEWED_DIGESTS = 256;
/** Lowercase only, so two paths can never collide on a case-insensitive disk.
 * Every segment starts with a letter or digit, so `.` and `..` cannot occur. */
const PATH_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MODULE_ID_PATTERN = /^[a-z][A-Za-z0-9.-]{2,63}$/;
/** Extensions a DECLARATIVE bundle may carry: configuration, templates, and prompts as text. */
const DECLARATIVE_EXTENSIONS = new Set(["json", "md", "txt"]);
/** Windows device names, reserved with or without an extension. */
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/;
/**
 * Declarative `.md`/`.txt` content is markdown, and markdown never needs raw
 * HTML: any `<` immediately followed by a letter, `/`, `!` or `?` is refused
 * outright, unparsed. This alone defeats every quote- or attribute-context
 * evasion (an event handler hidden behind a stray `>` inside a quoted
 * attribute, `<portal>`, `<button formaction=https://...>`, a `style` attribute, a
 * remote-beacon `<img>`), because none of those tricks work without an
 * opening `<letter`. Ordinary prose such as "a < b" is untouched.
 */
const RAW_HTML_V1 = /<[A-Za-z/!?]/;
/**
 * A run of bare `<` characters (none followed by a letter, so none match
 * RAW_HTML_V1) still costs the markdown parser far more than linear time:
 * measured, a 1MB file of nothing else takes over a second. No legitimate
 * declarative file needs anywhere near this many, so a file this dense with
 * `<` is refused before it ever reaches the parser.
 */
const MAX_RAW_LESS_THAN_V1 = 10_000;
/**
 * mdast node types a declarative file may contain. Notably absent: `html`
 * (raw markup, already refused above as defence in depth) and anything this
 * parser configuration does not itself produce, such as frontmatter.
 */
const SAFE_MARKDOWN_NODE_TYPES_V1 = new Set([
  "root", "paragraph", "heading", "thematicBreak", "blockquote", "list", "listItem",
  "code", "inlineCode", "definition", "table", "tableRow", "tableCell",
  "footnoteDefinition", "footnoteReference", "text", "emphasis", "strong",
  "delete", "break", "link", "image", "linkReference", "imageReference",
]);
/** A URI scheme prefix, so a destination with none of these is a relative reference. */
const URI_SCHEME_V1 = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
/** react-markdown's own external-link test (see private-app/app/result-text.tsx): http(s), relative, or an anchor. */
const SAFE_LINK_SCHEME_V1 = /^https?$/i;

interface MarkdownNodeV1 { readonly type: string; readonly url?: unknown; readonly children?: readonly MarkdownNodeV1[] }

function assertSafeLinkDestinationV1(url: string, code: string): void {
  if (url === "" || url.startsWith("#")) return;
  const scheme = URI_SCHEME_V1.exec(url);
  if (scheme && !SAFE_LINK_SCHEME_V1.test(scheme[1]!)) fail(code);
}

function assertSafeMarkdownTreeV1(node: MarkdownNodeV1, code: string): void {
  if (!SAFE_MARKDOWN_NODE_TYPES_V1.has(node.type)) fail(code);
  if ((node.type === "link" || node.type === "image" || node.type === "definition") && typeof node.url === "string") {
    assertSafeLinkDestinationV1(node.url, code);
  }
  for (const child of node.children ?? []) assertSafeMarkdownTreeV1(child, code);
}

/**
 * Declarative markdown/text: every character must be one a reviewer can see
 * (the shared hidden-text allowlist), no raw HTML may appear anywhere, and
 * what remains is parsed with the same CommonMark+GFM parser react-markdown
 * uses (see private-app/app/result-text.tsx) so link, image and reference
 * destinations are decoded exactly as that renderer would decode them before
 * their scheme is checked. This replaces guessing at obfuscation patterns
 * with reading the bytes the way the one real renderer reads them.
 */
function assertMarkdownTextSafeV1(text: string): void {
  // C0 and C1 controls (tab, LF and CR aside) are Cc, not Cf, so this is a separate check.
  if (!PORTABLE_PRINTABLE_TEXT_V1.test(text)) fail("module_bundle_declarative_file_not_text");
  assertNoHiddenTextV1(text, "module_bundle_declarative_file_not_text");
  if (RAW_HTML_V1.test(text)) fail("module_bundle_declarative_file_executable_content");
  if (text.split("<").length - 1 > MAX_RAW_LESS_THAN_V1) fail("module_bundle_declarative_file_executable_content");
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  assertSafeMarkdownTreeV1(tree, "module_bundle_declarative_file_executable_content");
}

export interface ModuleBundleFileInputV1 { readonly path: string; readonly contentBase64: string }
export interface ModuleBundleInputV1 {
  readonly schema: typeof MODULE_BUNDLE_SCHEMA_V1;
  readonly manifest: unknown;
  readonly files: readonly ModuleBundleFileInputV1[];
}
export interface ModuleBundleSignatureV1 {
  readonly schema: typeof MODULE_SIGNATURE_SCHEMA_V1;
  readonly keyId: string;
  readonly bundleDigest: string;
  readonly signature: string;
}
export interface ModuleTrustedKeyV1 {
  /** `sha256:` fingerprint of the DER SPKI bytes; recomputed, never believed. */
  readonly keyId: string;
  readonly publicKeySpki: string;
  readonly label: string;
  /** Module ids this key may vouch for; `*` means any module. */
  readonly moduleIds: readonly string[];
}
/** Owner-held trust. Catalog entries, publisher text, and pack inclusion are never inputs here. */
export interface ModuleTrustPolicyV1 {
  readonly trustedKeys: readonly ModuleTrustedKeyV1[];
  /** Exact bundle digests a reviewer read and pinned: the "reviewed source" path for CODE modules. */
  readonly reviewedBundleDigests: readonly string[];
}
export interface ModuleBundleFileEntryV1 { readonly path: string; readonly length: number; readonly digest: string }
export type ModuleBundleSourceV1 =
  | { readonly kind: "declarative-unsigned" }
  | { readonly kind: "reviewed" }
  | { readonly kind: "signed"; readonly keyId: string; readonly keyLabel: string };
export interface VerifiedModuleBundleV1 {
  readonly bundleDigest: string;
  readonly manifest: Readonly<ModuleManifestV1>;
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly moduleClass: ModuleManifestV1["class"];
  readonly files: readonly ModuleBundleFileEntryV1[];
  readonly source: ModuleBundleSourceV1;
  /** True for CODE modules: the owner must be told plainly that this module can run code. */
  readonly codeWarning: boolean;
  readonly authoritySurface: readonly string[];
  readonly permissionsDigest: string;
  /** Verification is inert: nothing was loaded, executed, staged, or migrated. */
  readonly executesCode: false;
  readonly runsMigrations: false;
}
export interface ModuleVerificationOptionsV1 {
  readonly trust: ModuleTrustPolicyV1;
  /** The running Control Room version; the manifest's compatibility range must admit it. */
  readonly hostVersion: string;
}
export interface ModulePermissionDiffV1 {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

function fail(code: string): never { throw new Error(code); }

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function plainObject(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) fail(code);
}

const bytesDigest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function decodeStrictBase64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || !BASE64_PATTERN.test(value)
    || value.length % 4 !== 0) fail("module_bundle_file_encoding_invalid");
  const bytes = Buffer.from(value as string, "base64");
  // One canonical encoding per byte string: padding bits and alternative forms are refused.
  if (bytes.toString("base64") !== value) fail("module_bundle_file_encoding_invalid");
  return bytes;
}

function assertBundlePath(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH) fail("module_bundle_path_invalid");
  const segments = (path as string).split("/");
  // A trailing dot is dropped by Windows (so `a.` would collide with `a`), and device names open devices.
  if (segments.length > MAX_PATH_DEPTH || !segments.every(segment => PATH_SEGMENT.test(segment)
    && !segment.endsWith(".") && !RESERVED_SEGMENT.test(segment))) {
    fail("module_bundle_path_invalid");
  }
  return path as string;
}

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1);
}

/** A JSON key or string value: the same character allowlist as markdown text, and no raw HTML. */
function assertJsonStringSafeV1(text: string): void {
  // C0 and C1 controls (tab, LF and CR aside), then every character the hidden-text allowlist refuses.
  if (!PORTABLE_PRINTABLE_TEXT_V1.test(text)) fail("module_bundle_declarative_file_not_text");
  assertNoHiddenTextV1(text, "module_bundle_declarative_file_not_text");
  if (RAW_HTML_V1.test(text)) fail("module_bundle_declarative_file_executable_content");
}

/**
 * Refuses a repeated key in any object. JSON.parse keeps the last one, so a
 * reviewer and a later reader could otherwise see different values in the same
 * bytes. `text` has already parsed, so a light scan of its tokens suffices;
 * keys are compared after their escapes are decoded.
 */
function assertNoDuplicateJsonKeys(text: string): void {
  const objects: (Set<string> | null)[] = [];
  let expectKey = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\"") {
      let end = index + 1;
      while (text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
      if (expectKey) {
        const key = JSON.parse(text.slice(index, end + 1)) as string, seen = objects.at(-1)!;
        if (seen.has(key)) fail("module_bundle_declarative_json_duplicate_key");
        seen.add(key);
        expectKey = false;
      }
      index = end;
    } else if (character === "{") { objects.push(new Set()); expectKey = true; }
    else if (character === "[") { objects.push(null); expectKey = false; }
    else if (character === "}" || character === "]") { objects.pop(); expectKey = false; }
    else if (character === ",") expectKey = objects.at(-1) instanceof Set;
  }
}

function assertInertJsonValue(value: unknown): void {
  if (typeof value === "string") { assertJsonStringSafeV1(value); return; }
  if (Array.isArray(value)) { for (const item of value) assertInertJsonValue(item); return; }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) { assertJsonStringSafeV1(key); assertInertJsonValue(item); }
  }
}

/**
 * DECLARATIVE means inert and shareable by anyone, so every file is checked as
 * a reviewer, and anything reading the raw bytes, would read it: an allowed
 * extension and strict UTF-8, then an allowlist rather than a blocklist --
 * only safe characters, only safe markdown, only safe link/image schemes, and
 * no raw HTML anywhere. `.json` files must also be strict JSON with no
 * duplicate keys or prototype keys, and their decoded keys and string values
 * get the same character and no-raw-HTML rules, so a
 * `\u003c` escape cannot hide a tag. Credential- and authority-shaped wording
 * is not refused here: prompt prose legitimately says "role: reviewer".
 */
function assertDeclarativeFile(path: string, bytes: Buffer): void {
  const extension = extensionOf(path);
  if (!DECLARATIVE_EXTENSIONS.has(extension)) fail("module_bundle_declarative_file_not_allowed");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return fail("module_bundle_declarative_file_not_text"); }
  if (extension !== "json") { assertMarkdownTextSafeV1(text); return; }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail("module_bundle_declarative_json_invalid"); }
  assertNoDuplicateJsonKeys(text);
  assertNoPortablePrototypePollutionV1("module_bundle_declarative_file", value, 64);
  assertInertJsonValue(value);
}

/** Decodes a bounded SPKI and refuses every key type but Ed25519. */
function ed25519Key(spki: unknown): { key: KeyObject; keyId: string } {
  if (typeof spki !== "string" || spki.length > 256 || !BASE64URL_PATTERN.test(spki)) fail("module_trust_key_invalid");
  const der = Buffer.from(spki as string, "base64url");
  let key: KeyObject;
  try { key = createPublicKey({ key: der, format: "der", type: "spki" }); } catch { return fail("module_trust_key_invalid"); }
  if (key.asymmetricKeyType !== "ed25519") fail("module_trust_key_invalid");
  return { key, keyId: bytesDigest(der) };
}

/** Fingerprint of an Ed25519 public key, as a trust policy names it. */
export function moduleKeyIdV1(publicKeySpki: string): string {
  return ed25519Key(publicKeySpki).keyId;
}

type ParsedTrust = { keys: Map<string, { key: KeyObject; label: string; moduleIds: readonly string[] }>; reviewed: Set<string> };

function parseTrustPolicy(value: unknown): ParsedTrust {
  const policy = plainObject(value, "module_trust_policy_invalid");
  exactKeys(policy, ["trustedKeys", "reviewedBundleDigests"], "module_trust_policy_invalid");
  const { trustedKeys, reviewedBundleDigests } = policy;
  if (!Array.isArray(trustedKeys) || trustedKeys.length > MAX_TRUSTED_KEYS
    || !Array.isArray(reviewedBundleDigests) || reviewedBundleDigests.length > MAX_REVIEWED_DIGESTS) {
    fail("module_trust_policy_invalid");
  }
  const keys: ParsedTrust["keys"] = new Map();
  for (const entry of trustedKeys as unknown[]) {
    const trusted = plainObject(entry, "module_trust_policy_invalid");
    exactKeys(trusted, ["keyId", "publicKeySpki", "label", "moduleIds"], "module_trust_policy_invalid");
    const { key, keyId } = ed25519Key(trusted.publicKeySpki);
    // A policy that names one key id but carries another key's bytes is refused, not trusted.
    if (trusted.keyId !== keyId) fail("module_trust_key_id_mismatch");
    if (keys.has(keyId)) fail("module_trust_policy_invalid");
    const moduleIds = trusted.moduleIds;
    if (typeof trusted.label !== "string" || trusted.label.length < 1 || trusted.label.length > 120
      || !Array.isArray(moduleIds) || moduleIds.length < 1 || moduleIds.length > 100
      || !moduleIds.every(id => id === "*" || (typeof id === "string" && MODULE_ID_PATTERN.test(id)))) {
      fail("module_trust_policy_invalid");
    }
    keys.set(keyId, { key, label: trusted.label as string, moduleIds: [...moduleIds as string[]] });
  }
  if (!reviewedBundleDigests.every(digest => typeof digest === "string" && DIGEST_PATTERN.test(digest))) {
    fail("module_trust_policy_invalid");
  }
  return { keys, reviewed: new Set(reviewedBundleDigests as string[]) };
}

/** The exact bytes a publisher key signs: purpose, key, bundle digest, and module identity. */
export function moduleBundleSignatureMaterialV1(keyId: string, bundleDigest: string, moduleId: string, moduleVersion: string): Buffer {
  return Buffer.from(canonicalJson({ purpose: SIGNATURE_PURPOSE_V1, keyId, bundleDigest, moduleId, moduleVersion }), "utf8");
}

/** Publisher-side helper for tooling and tests. It signs a digest the caller has already computed. */
export function signModuleBundleV1(bundle: ModuleBundleInputV1, privateKey: KeyObject, publicKeySpki: string): ModuleBundleSignatureV1 {
  const { bundleDigest, manifest } = canonicalModuleBundleV1(bundle);
  const keyId = moduleKeyIdV1(publicKeySpki);
  return {
    schema: MODULE_SIGNATURE_SCHEMA_V1, keyId, bundleDigest,
    signature: sign(null, moduleBundleSignatureMaterialV1(keyId, bundleDigest, manifest.id, manifest.version), privateKey).toString("base64url"),
  };
}

/**
 * Parses the bundle and computes its canonical digest over the parsed manifest
 * and every file's path, length, and content digest. File order does not
 * matter; duplicate or unsafe paths, oversize content, and non-canonical
 * encodings are refused. No trust decision is made here.
 */
export function canonicalModuleBundleV1(value: unknown): {
  bundleDigest: string; manifest: Readonly<ModuleManifestV1>; files: readonly ModuleBundleFileEntryV1[]; contents: ReadonlyMap<string, Buffer>;
} {
  const bundle = plainObject(value, "module_bundle_malformed");
  exactKeys(bundle, ["schema", "manifest", "files"], "module_bundle_malformed");
  if (bundle.schema !== MODULE_BUNDLE_SCHEMA_V1) fail("module_bundle_unknown_version");
  const manifest = parseModuleManifestV1(bundle.manifest);
  if (!Array.isArray(bundle.files) || bundle.files.length > MAX_FILES) fail("module_bundle_files_invalid");
  assertNoPortablePrototypePollutionV1("module_bundle", bundle.files, 4);
  const contents = new Map<string, Buffer>();
  let total = 0;
  for (const entry of bundle.files as unknown[]) {
    const file = plainObject(entry, "module_bundle_files_invalid");
    exactKeys(file, ["path", "contentBase64"], "module_bundle_files_invalid");
    const path = assertBundlePath(file.path);
    if (contents.has(path)) fail("module_bundle_duplicate_path");
    const bytes = decodeStrictBase64(file.contentBase64);
    if (bytes.length > MAX_FILE_BYTES) fail("module_bundle_file_oversized");
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) fail("module_bundle_oversized");
    contents.set(path, bytes);
  }
  // Once staged, a file cannot also be a directory holding another file.
  for (const path of contents.keys()) {
    for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) {
      if (contents.has(path.slice(0, slash))) fail("module_bundle_path_collision");
    }
  }
  const files = [...contents.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, bytes]) => ({ path, length: bytes.length, digest: bytesDigest(bytes) }));
  const bundleDigest = sha256Digest({ namespace: MODULE_BUNDLE_SCHEMA_V1, manifest, files });
  return { bundleDigest, manifest, files, contents };
}

/**
 * The flat, comparable list of everything a manifest asks the host for. Two
 * versions with the same surface ask for the same authority; any difference
 * is shown to the owner as an added/removed line before approval.
 */
export function moduleAuthoritySurfaceV1(manifest: Readonly<ModuleManifestV1>): readonly string[] {
  const { permissions, ui, events, data } = manifest;
  const lines = [
    `class:${manifest.class}`,
    ...permissions.projectData.flatMap(({ resource, access }) => access.map(mode => `projectData:${resource}:${mode}`)),
    ...permissions.taskTemplates.map(id => `taskTemplate:${id}`),
    ...permissions.pipelineTemplates.map(id => `pipelineTemplate:${id}`),
    ...permissions.workerCapabilities.map(id => `workerCapability:${id}`),
    ...permissions.notifications.slots.map(id => `notificationSlot:${id}`),
    `notifications.maxPerHour:${permissions.notifications.maxPerHour}`,
    ...permissions.attention.slots.map(id => `attentionSlot:${id}`),
    `attention.maxOpenPerProject:${permissions.attention.maxOpenPerProject}`,
    ...permissions.scheduledJobs.jobs.map(id => `scheduledJob:${id}`),
    `scheduledJobs.maxConcurrent:${permissions.scheduledJobs.maxConcurrent}`,
    `scheduledJobs.maxRunsPerDay:${permissions.scheduledJobs.maxRunsPerDay}`,
    `scheduledJobs.maxRuntimeSeconds:${permissions.scheduledJobs.maxRuntimeSeconds}`,
    ...ui.projectTabs.map(({ id }) => `ui.projectTab:${id}`),
    ...(ui.navEntry ? [`ui.navEntry:${ui.navEntry.id}`] : []),
    `ui.needsYou:${ui.needsYou}`,
    ...events.subscribe.map(kind => `event:${kind}`),
    `events.emitNotifications:${events.emitNotifications}`,
    ...(data ? [`data.schema:${data.schemaNamespace}`, ...data.migrations.map(({ version }) => `data.migration:${version}`)] : []),
  ];
  return Object.freeze([...new Set(lines)].sort());
}

export function modulePermissionsDigestV1(manifest: Readonly<ModuleManifestV1>): string {
  return sha256Digest({ namespace: SURFACE_NAMESPACE_V1, surface: moduleAuthoritySurfaceV1(manifest) });
}

export function modulePermissionDiffV1(from: readonly string[] | null, to: readonly string[]): ModulePermissionDiffV1 {
  const before = new Set(from ?? []), after = new Set(to);
  return Object.freeze({
    added: Object.freeze([...after].filter(line => !before.has(line)).sort()),
    removed: Object.freeze([...before].filter(line => !after.has(line)).sort()),
  });
}

/** Binds the diff the owner saw to the exact approval it replaces and the exact bundle it admits. */
export function modulePermissionDiffDigestV1(input: { moduleId: string; fromApprovalId: string | null;
  fromBundleDigest: string | null; toBundleDigest: string; diff: ModulePermissionDiffV1 }): string {
  return sha256Digest({ namespace: DIFF_NAMESPACE_V1, moduleId: input.moduleId, fromApprovalId: input.fromApprovalId,
    fromBundleDigest: input.fromBundleDigest, toBundleDigest: input.toBundleDigest,
    added: [...input.diff.added], removed: [...input.diff.removed] });
}

type Version = { core: [number, number, number]; pre: string[] };
function parseVersion(value: string): Version {
  if (!isModuleSemverV1(value)) fail("module_bundle_host_version_invalid");
  const withoutBuild = value.split("+", 1)[0]!;
  const dash = withoutBuild.indexOf("-");
  const core = (dash < 0 ? withoutBuild : withoutBuild.slice(0, dash)).split(".").map(Number) as [number, number, number];
  if (!core.every(Number.isSafeInteger)) fail("module_bundle_host_version_invalid");
  return { core, pre: dash < 0 ? [] : withoutBuild.slice(dash + 1).split(".") };
}
function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index]! < right.core[index]! ? -1 : 1;
  }
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const a = left.pre[index], b = right.pre[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const numericA = /^[0-9]+$/.test(a), numericB = /^[0-9]+$/.test(b);
    if (numericA && numericB) return Number(a) < Number(b) ? -1 : 1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** SemVer range test for the manifest grammar: `^`, `~`, comparison operators, exact, and space-joined AND. */
export function moduleCompatibilitySatisfiedV1(range: string, hostVersion: string): boolean {
  const host = parseVersion(hostVersion);
  return range.split(" ").every(comparator => {
    const match = /^(\^|~|>=|<=|>|<)?(.+)$/.exec(comparator);
    if (!match) return false;
    const operator = match[1] ?? "=", bound = parseVersion(match[2]!), order = compareVersions(host, bound);
    if (operator === "=") return order === 0;
    if (operator === ">=") return order >= 0;
    if (operator === "<=") return order <= 0;
    if (operator === ">") return order > 0;
    if (operator === "<") return order < 0;
    const [major, minor, patch] = bound.core;
    const upper: [number, number, number] = operator === "~" ? [major, minor + 1, 0]
      : major > 0 ? [major + 1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1];
    // `pre: ["0"]` is the lowest prerelease of the upper bound, so `<upper-0` excludes the next line's prereleases too.
    return order >= 0 && compareVersions(host, { core: upper, pre: ["0"] }) < 0;
  });
}

/**
 * Verifies a module bundle for owner review. Order: canonical parse and digest;
 * the signature, if present, must be over that exact digest by a key in the
 * owner's trust policy that may vouch for this module id; class rules; host
 * compatibility. CODE modules additionally need a trusted signature or a
 * reviewed digest pin. Every failure throws; nothing falls back to "unsigned".
 */
export function verifyModuleBundleV1(bundleValue: unknown, signatureValue: unknown,
  options: ModuleVerificationOptionsV1): Readonly<VerifiedModuleBundleV1> {
  const opts = plainObject(options, "module_bundle_options_invalid");
  exactKeys(opts, ["trust", "hostVersion"], "module_bundle_options_invalid");
  if (typeof opts.hostVersion !== "string") fail("module_bundle_host_version_invalid");
  const trust = parseTrustPolicy(opts.trust);
  const { bundleDigest, manifest, files, contents } = canonicalModuleBundleV1(bundleValue);

  let source: ModuleBundleSourceV1 | undefined;
  if (signatureValue !== undefined && signatureValue !== null) {
    const envelope = plainObject(signatureValue, "module_signature_malformed");
    exactKeys(envelope, ["schema", "keyId", "bundleDigest", "signature"], "module_signature_malformed");
    if (envelope.schema !== MODULE_SIGNATURE_SCHEMA_V1) fail("module_signature_unknown_version");
    if (typeof envelope.keyId !== "string" || typeof envelope.bundleDigest !== "string"
      || typeof envelope.signature !== "string" || envelope.signature.length > 128 || !BASE64URL_PATTERN.test(envelope.signature)) {
      fail("module_signature_malformed");
    }
    // A signature names the bytes it covers; it cannot be moved to other bytes.
    if (envelope.bundleDigest !== bundleDigest) fail("module_signature_digest_mismatch");
    const trusted = trust.keys.get(envelope.keyId as string);
    if (!trusted) fail("module_signature_signer_untrusted");
    if (!trusted!.moduleIds.includes("*") && !trusted!.moduleIds.includes(manifest.id)) fail("module_signature_signer_not_allowed_for_module");
    const material = moduleBundleSignatureMaterialV1(envelope.keyId as string, bundleDigest, manifest.id, manifest.version);
    let valid = false;
    try { valid = verify(null, material, trusted!.key, Buffer.from(envelope.signature as string, "base64url")); } catch { valid = false; }
    if (!valid) fail("module_signature_invalid");
    source = { kind: "signed", keyId: envelope.keyId as string, keyLabel: trusted!.label };
  } else if (trust.reviewed.has(bundleDigest)) {
    source = { kind: "reviewed" };
  }

  if (manifest.class === "declarative") {
    // Migrations run as the schema owner, so they are executable material: never DECLARATIVE.
    if (manifest.data !== undefined) fail("module_bundle_declarative_declares_migrations");
    for (const [path, bytes] of contents) assertDeclarativeFile(path, bytes);
    source ??= { kind: "declarative-unsigned" };
  } else if (source === undefined) {
    fail("module_bundle_code_source_untrusted");
  }
  for (const migration of manifest.data?.migrations ?? []) {
    if (!contents.has(migration.upFile) || !contents.has(migration.downFile)) fail("module_bundle_migration_file_missing");
  }
  if (!moduleCompatibilitySatisfiedV1(manifest.controlRoomCompatibility, opts.hostVersion as string)) {
    fail("module_bundle_incompatible");
  }
  return deepFreeze({
    bundleDigest, manifest, moduleId: manifest.id, moduleVersion: manifest.version, moduleClass: manifest.class,
    files: files.map(file => ({ ...file })), source: source!, codeWarning: manifest.class === "code",
    authoritySurface: moduleAuthoritySurfaceV1(manifest), permissionsDigest: modulePermissionsDigestV1(manifest),
    executesCode: false as const, runsMigrations: false as const,
  });
}
