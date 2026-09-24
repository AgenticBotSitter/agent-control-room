import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { promisify, types } from "node:util";
import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { HERMES_021_SOURCE_REVISION_V1, HERMES_021_VERSION_V1 } from "./connector-profile";
import { verifyHermes021MacosLocalRunnerVersionV1 } from "./runner-compatibility";

export const HERMES_021_MACOS_REVIEWED_EXECUTABLE_IDENTITY_V1 =
  "control-room.hermes-021-macos-reviewed-executable-identity/v1" as const;
export const HERMES_021_MACOS_EXECUTABLE_REVIEW_CAPABILITY_V1 =
  "control-room.hermes-021-macos-executable-review-capability/v1" as const;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const recordSchema = z.object({ schema: z.literal(HERMES_021_MACOS_REVIEWED_EXECUTABLE_IDENTITY_V1),
  executableSha256: digest, observedVersion: z.literal(HERMES_021_VERSION_V1),
  observedSourceRevision: z.literal(HERMES_021_SOURCE_REVISION_V1), reviewDigest: digest,
  pinnedExecutableLaunchSupported: z.literal(false) }).strict();
export type Hermes021MacosReviewedExecutableIdentityV1 = Readonly<z.infer<typeof recordSchema>>;
type Stat = Awaited<ReturnType<typeof lstat>>;
type Review = Readonly<{ executablePath: string; record: Hermes021MacosReviewedExecutableIdentityV1; stat: Stat }>;
const records = new WeakMap<object, Review>(), capabilities = new WeakMap<object, Review>();
const executeFile = promisify(execFile);
const unavailable = (): never => { const error = new Error("hermes_021_macos_reviewed_executable_identity_unavailable");
  error.stack = undefined; throw error; };

function exact(value: unknown, names: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return unavailable();
  const actual = Object.getOwnPropertyNames(value), captured: Record<string, unknown> = {};
  if (actual.length !== names.length || actual.some(name => !names.includes(name))) return unavailable();
  for (const name of names) { const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return unavailable(); captured[name] = descriptor.value; }
  return Object.freeze(captured);
}
function same(left: Stat, right: Stat) { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  && left.size === right.size && left.nlink === right.nlink && left.uid === right.uid && left.gid === right.gid
  && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }

export async function attestHermes021MacosReviewedExecutableFileV1(path: string, expectedSha256: string,
  expectedStat?: Stat): Promise<Stat> {
  let handle: Awaited<ReturnType<typeof open>> | undefined, bytes: Buffer | undefined;
  try {
    const named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || (named.mode & 0o111) === 0
      || await realpath(path) !== path) return unavailable();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!same(named, before) || expectedStat && !same(expectedStat, before)
      || before.size < 1 || before.size > 64 * 1024 * 1024) return unavailable();
    bytes = await handle.readFile();
    const after = await handle.stat(), current = await lstat(path);
    if (!same(before, after) || !same(before, current) || bytes.length !== before.size
      || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expectedSha256
      || await realpath(path) !== path) return unavailable();
    return before;
  } catch { return unavailable(); }
  finally { bytes?.fill(0); await handle?.close().catch(() => undefined); }
}

/** Mints opaque review only after fixed native hash and public version observation. */
export async function reviewHermes021MacosExecutableV1(value: unknown) {
  const input = exact(value, ["executablePath", "executableSha256"]);
  if (typeof input.executablePath !== "string" || !isAbsolute(input.executablePath)
    || normalize(input.executablePath) !== input.executablePath) return unavailable();
  const executableSha256 = digest.parse(input.executableSha256);
  const stat = await attestHermes021MacosReviewedExecutableFileV1(input.executablePath, executableSha256);
  let stdout: string;
  try { const result = await executeFile(input.executablePath, ["--version"], { windowsHide: true, timeout: 5_000,
    maxBuffer: 4_096, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "", NODE_ENV: "production" } }); stdout = result.stdout; }
  catch { return unavailable(); }
  const observed = verifyHermes021MacosLocalRunnerVersionV1(stdout);
  await attestHermes021MacosReviewedExecutableFileV1(input.executablePath, executableSha256, stat);
  const material = { schema: HERMES_021_MACOS_REVIEWED_EXECUTABLE_IDENTITY_V1, executableSha256,
    observedVersion: observed.version, observedSourceRevision: observed.sourceRevision,
    pinnedExecutableLaunchSupported: false as const };
  const record = Object.freeze(recordSchema.parse({ ...material,
    reviewDigest: sha256Digest({ purpose: "hermes-021-reviewed-executable-identity/v1", review: material }) }));
  const review = Object.freeze({ executablePath: input.executablePath, record, stat });
  const capability = Object.freeze({ schema: HERMES_021_MACOS_EXECUTABLE_REVIEW_CAPABILITY_V1 });
  records.set(record, review); capabilities.set(capability, review);
  return Object.freeze({ record, capability });
}

export function captureHermes021MacosReviewedExecutableIdentityV1(value: unknown): Hermes021MacosReviewedExecutableIdentityV1 {
  if (!value || typeof value !== "object" || types.isProxy(value)) return unavailable();
  const review = records.get(value); if (!review) return unavailable();
  const parsed = recordSchema.parse(value);
  if (canonicalJson(parsed) !== canonicalJson(review.record)) return unavailable(); return review.record;
}
export function consumeHermes021MacosExecutableReviewCapabilityV1(value: unknown): Review {
  if (!value || typeof value !== "object" || types.isProxy(value)) return unavailable();
  const review = capabilities.get(value); if (!review || !capabilities.delete(value)) return unavailable(); return review;
}
export function hermes021MacosReviewedExecutableIdentityDigestV1(value: unknown) {
  return captureHermes021MacosReviewedExecutableIdentityV1(value).reviewDigest;
}
