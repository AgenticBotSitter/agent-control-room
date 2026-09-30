import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const TRUSTED_RUNTIME_MANIFEST_SCHEMA = "control-room.trusted-runtime/v1";
export const TRUSTED_RUNTIME_TOOLS = Object.freeze(["node", "pnpm", "esbuild"]);
export const XCRUN_TOOL_NAMES = Object.freeze(["git", "codesign", "install_name_tool", "otool"]);
export const SERVICE_PROFILE_ROLES = Object.freeze(["supervisor", "gateway", "postgres", "builder", "upgrader"]);

const SYSTEM_ROOTS = Object.freeze(["/usr/bin", "/usr/lib", "/bin", "/usr/sbin", "/System"]);
const SAFE_BASE_ENVIRONMENT = Object.freeze({ LANG: "C", LC_ALL: "C" });
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
  "PATH", "NODE_OPTIONS", "NODE_PATH", "HOME", "DEVELOPER_DIR", "SDKROOT", "TMPDIR", "BASH_ENV", "ENV",
]);
const FORBIDDEN_ENVIRONMENT_PREFIXES = Object.freeze([
  "DYLD_", "NPM_CONFIG_", "GIT_", "OPENSSL_", "SSL_CERT_", "KRB5", "PG",
]);
const approvedProfileParameters = new WeakMap();

export class TrustedRuntimeRefusal extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "TrustedRuntimeRefusal";
    this.code = code;
  }
}

const refuse = code => { throw new TrustedRuntimeRefusal(code); };
const plainRecord = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const inside = (root, path) => {
  const rest = relative(root, path);
  return rest === "" || rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
};
const absolute = (value, code = "trusted_runtime_path_invalid") => {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || resolve(value) !== value) refuse(code);
  return value;
};

export function isAlwaysStrippedEnvironmentName(name) {
  if (typeof name !== "string") return false;
  const normalized = name.toUpperCase();
  return FORBIDDEN_ENVIRONMENT_NAMES.has(normalized)
    || FORBIDDEN_ENVIRONMENT_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/**
 * Builds an environment from nothing. Values on the design's stripped list
 * may be put back only when the caller names each one explicitly. No value is
 * ever copied from process.env by this boundary.
 */
export function buildTrustedEnvironment(overrides = {}, { explicitlySet = [] } = {}) {
  if (!plainRecord(overrides) || !Array.isArray(explicitlySet)
    || explicitlySet.some(name => typeof name !== "string" || !SAFE_ENVIRONMENT_NAME.test(name))) {
    refuse("trusted_spawn_environment_invalid");
  }
  const allowed = new Set(explicitlySet.map(name => name.toUpperCase()));
  const environment = { ...SAFE_BASE_ENVIRONMENT };
  for (const [name, value] of Object.entries(overrides)) {
    if (!SAFE_ENVIRONMENT_NAME.test(name) || typeof value !== "string" || value.includes("\0")) {
      refuse("trusted_spawn_environment_invalid");
    }
    if (isAlwaysStrippedEnvironmentName(name) && !allowed.has(name.toUpperCase())) {
      refuse("trusted_spawn_environment_refused");
    }
    environment[name] = value;
  }
  return Object.freeze(environment);
}

export function trustedToolEnvironment(tool) {
  if (tool === "git") return buildTrustedEnvironment({
    HOME: "/var/empty",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  }, { explicitlySet: ["HOME", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"] });
  if (tool === "pnpm") return buildTrustedEnvironment({
    HOME: "/var/empty",
    NPM_CONFIG_USERCONFIG: "/dev/null",
    NPM_CONFIG_GLOBALCONFIG: "/dev/null",
  }, { explicitlySet: ["HOME", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG"] });
  if (tool === "node" || tool === "esbuild" || tool === "xcrun") return buildTrustedEnvironment();
  refuse("trusted_tool_unknown");
}

export async function sha256File(path) {
  absolute(path);
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const input = createReadStream(path);
    input.on("data", chunk => hash.update(chunk));
    input.once("error", reject);
    input.once("end", resolvePromise);
  });
  return hash.digest("hex");
}

export async function verifyPinnedFile(path, expectedSha256) {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256 ?? "")) refuse("trusted_runtime_digest_invalid");
  const actual = await sha256File(path);
  if (actual !== expectedSha256) refuse("trusted_runtime_digest_mismatch");
  return actual;
}

function assertManifestArtifact(artifact) {
  if (!plainRecord(artifact) || !TRUSTED_RUNTIME_TOOLS.includes(artifact.tool)
    || typeof artifact.version !== "string" || !/^[0-9]+(?:\.[0-9]+){1,2}$/u.test(artifact.version)
    || typeof artifact.archiveName !== "string" || !/^[A-Za-z0-9@._+-]+\.(?:tar\.gz|tgz)$/u.test(artifact.archiveName)
    || typeof artifact.url !== "string" || !artifact.url.startsWith("https://")
    || !/^[a-f0-9]{64}$/u.test(artifact.archiveSha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(artifact.executableSha256 ?? "")
    || typeof artifact.executableRelativePath !== "string"
    || artifact.executableRelativePath.startsWith("/") || artifact.executableRelativePath.split("/").includes("..")) {
    refuse("trusted_runtime_manifest_invalid");
  }
}

export function validateTrustedRuntimeManifest(value) {
  if (!plainRecord(value) || value.schema !== TRUSTED_RUNTIME_MANIFEST_SCHEMA
    || value.platform !== "darwin" || value.architecture !== "arm64"
    || !Array.isArray(value.artifacts) || value.artifacts.length !== TRUSTED_RUNTIME_TOOLS.length) {
    refuse("trusted_runtime_manifest_invalid");
  }
  for (const artifact of value.artifacts) assertManifestArtifact(artifact);
  if (new Set(value.artifacts.map(artifact => artifact.tool)).size !== TRUSTED_RUNTIME_TOOLS.length
    || TRUSTED_RUNTIME_TOOLS.some(tool => !value.artifacts.some(artifact => artifact.tool === tool))) {
    refuse("trusted_runtime_manifest_invalid");
  }
  return Object.freeze({ ...value, artifacts: Object.freeze(value.artifacts.map(artifact => Object.freeze({ ...artifact }))) });
}

async function assertOwnedPath(path, { executable = false, runtime }) {
  if (path === "/dev/null") return path;
  const entry = await runtime.lstat(path).catch(() => refuse("t1_path_missing"));
  if (entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) !== 0) refuse("t1_path_writable");
  if (executable && (!entry.isFile() || (entry.mode & 0o111) === 0)) refuse("t1_executable_invalid");
  if (!executable && !entry.isFile() && !entry.isDirectory()) refuse("t1_path_type_invalid");
  const acl = await runtime.inspectAcl(path);
  if (!Array.isArray(acl) || acl.some(line => typeof line !== "string")) refuse("t1_acl_invalid");
  if (acl.some(line => /\ballow\b.*\b(?:write|add_file|add_subdirectory|delete|writeattr|writeextattr|writeowner|chown)\b/iu.test(line)
    && !/\buser:root\b/iu.test(line))) refuse("t1_path_writable");
  return path;
}

async function assertAncestry(path, runtime) {
  const parts = path.split("/").filter(Boolean);
  let current = "/";
  await assertOwnedPath(current, { runtime });
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current === "/" ? `/${parts[index]}` : `${current}/${parts[index]}`;
    await assertOwnedPath(current, { runtime });
  }
}

/** Checks the static file/ancestor half of T1 after resolving symlinks. */
export async function assertT1Path(path, { allowedRoots = [], executable = false, runtime = {} } = {}) {
  absolute(path);
  if (!Array.isArray(allowedRoots)) refuse("t1_roots_invalid");
  const customFilesystem = runtime.lstat !== undefined || runtime.realpath !== undefined;
  const io = { lstat: runtime.lstat ?? lstat, realpath: runtime.realpath ?? realpath,
    inspectAcl: runtime.inspectAcl ?? (customFilesystem ? async () => [] : inspectPathAcl) };
  if (path === "/dev/null") return path;
  const canonical = await io.realpath(path).catch(() => refuse("t1_path_missing"));
  absolute(canonical);
  const roots = [...SYSTEM_ROOTS, ...allowedRoots].map(root => absolute(root, "t1_roots_invalid"));
  if (!roots.some(root => inside(root, canonical))) refuse("t1_path_outside_roots");
  await assertAncestry(canonical, io);
  await assertOwnedPath(canonical, { executable, runtime: io });
  return canonical;
}

export function parseOtoolLibraries(output) {
  if (typeof output !== "string" || output.includes("\0")) refuse("t1_otool_output_invalid");
  const lines = output.split(/\r?\n/u).slice(1).filter(line => line.trim().length > 0);
  return Object.freeze(lines.map(line => {
    const match = /^\s+(.+?) \(compatibility version [^)]+\)$/u.exec(line);
    if (!match) refuse("t1_otool_output_invalid");
    return match[1];
  }));
}

export function parseOtoolRpaths(output) {
  if (typeof output !== "string" || output.includes("\0")) refuse("t1_otool_output_invalid");
  const lines = output.split(/\r?\n/u), paths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "cmd LC_RPATH") continue;
    const match = /^\s*path (.+) \(offset \d+\)$/u.exec(lines[index + 2] ?? "");
    if (!match) refuse("t1_otool_output_invalid");
    paths.push(match[1]);
  }
  return Object.freeze(paths);
}

function expandTokenPath(name, image, executable) {
  if (name === "@loader_path") return dirname(image);
  if (name.startsWith("@loader_path/")) return resolve(dirname(image), name.slice("@loader_path/".length));
  if (name === "@executable_path") return dirname(executable);
  if (name.startsWith("@executable_path/")) return resolve(dirname(executable), name.slice("@executable_path/".length));
  return absolute(name, "t1_library_unresolved");
}

function resolvedLibraryCandidates(name, image, executable, rpaths) {
  if (!name.startsWith("@rpath/")) return [expandTokenPath(name, image, executable)];
  if (!Array.isArray(rpaths) || rpaths.length === 0) refuse("t1_library_unresolved");
  const suffix = name.slice("@rpath/".length);
  return rpaths.map(rpath => join(expandTokenPath(rpath, image, executable), suffix));
}

async function assertT1Library(candidates, options) {
  let lastError;
  for (const dependency of candidates) {
    try { return await assertT1Path(dependency, options); }
    catch (error) {
      if (error instanceof TrustedRuntimeRefusal && error.code === "t1_path_missing"
        && ["/usr/lib", "/System/Library"].some(root => inside(root, dependency))) return dependency;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  refuse("t1_library_unresolved");
}

/**
 * Checks an executable, its declared init-time files and the complete dynamic
 * library closure returned by the caller's already-resolved otool.
 */
export async function assertT1Executable(executable, {
  allowedRoots = [], initConfigFiles = [], inspectLibraries, runtime = {}, maximumImages = 512,
} = {}) {
  if (!Array.isArray(initConfigFiles) || typeof inspectLibraries !== "function"
    || !Number.isSafeInteger(maximumImages) || maximumImages < 1) refuse("t1_check_input_invalid");
  const canonicalExecutable = await assertT1Path(executable, { allowedRoots, executable: true, runtime });
  for (const config of initConfigFiles) await assertT1Path(config, { allowedRoots, runtime });
  const pending = [canonicalExecutable], checked = new Set();
  let executableRpaths = [];
  while (pending.length > 0) {
    const image = pending.pop();
    if (checked.has(image)) continue;
    checked.add(image);
    if (checked.size > maximumImages) refuse("t1_library_limit_exceeded");
    const inspected = await inspectLibraries(image);
    const names = Array.isArray(inspected) ? inspected : inspected?.libraries;
    const rpaths = Array.isArray(inspected) ? [] : inspected?.rpaths;
    if (!Array.isArray(names) || !Array.isArray(rpaths)) refuse("t1_library_inspection_invalid");
    if (image === canonicalExecutable) executableRpaths = rpaths;
    const effectiveRpaths = [...new Set([...rpaths, ...executableRpaths])];
    for (const name of names) {
      if (typeof name !== "string") refuse("t1_library_inspection_invalid");
      const canonical = await assertT1Library(resolvedLibraryCandidates(name, image, canonicalExecutable, effectiveRpaths),
        { allowedRoots, runtime });
      if (canonical === image) continue;
      if (!SYSTEM_ROOTS.some(root => inside(root, canonical))) pending.push(canonical);
    }
  }
  return Object.freeze({ executable: canonicalExecutable, images: Object.freeze([...checked].sort()) });
}

const execFileResult = (file, args, options) => new Promise((resolvePromise, reject) => {
  const child = spawn(file, args, { ...options, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", bytes = 0, settled = false;
  const finish = (action, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    action(value);
  };
  const add = (target, chunk) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) {
      child.kill("SIGKILL");
      finish(reject, new Error("trusted command output exceeded limit"));
      return target;
    }
    return target + chunk.toString("utf8");
  };
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    finish(reject, new Error("trusted command timed out"));
  }, 10_000);
  child.stdout.on("data", chunk => { stdout = add(stdout, chunk); });
  child.stderr.on("data", chunk => { stderr = add(stderr, chunk); });
  child.once("error", error => finish(reject, error));
  child.once("close", code => code === 0 ? finish(resolvePromise, { stdout, stderr })
    : finish(reject, new Error(`trusted command failed: ${code}`)));
});

const inspectPathAcl = async path => {
  const output = (await execFileResult("/bin/ls", ["-lde", path], { env: buildTrustedEnvironment() })).stdout;
  return output.split(/\r?\n/u).slice(1).filter(line => /^\s*\d+:/u.test(line));
};

export function createOtoolInspector(otool, runtime = {}) {
  absolute(otool);
  const run = runtime.execFile ?? execFileResult;
  return async image => {
    const path = absolute(image), environment = buildTrustedEnvironment();
    const [libraries, commands] = await Promise.all([
      run(otool, ["-L", path], { env: environment }), run(otool, ["-l", path], { env: environment }),
    ]);
    return Object.freeze({ libraries: parseOtoolLibraries(libraries.stdout), rpaths: parseOtoolRpaths(commands.stdout) });
  };
}

export async function resolveXcrunTools({ allowedRoots = [], runtime = {} } = {}) {
  const run = runtime.execFile ?? execFileResult;
  const xcrun = await assertT1Path("/usr/bin/xcrun", { allowedRoots, executable: true, runtime });
  const results = {};
  for (const tool of XCRUN_TOOL_NAMES) {
    const result = await run(xcrun, ["--find", tool], { env: trustedToolEnvironment("xcrun") });
    const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
    if (lines.length !== 1) refuse("xcrun_resolution_invalid");
    results[tool] = lines[0];
  }
  const inspectLibraries = runtime.inspectLibraries ?? createOtoolInspector(results.otool, runtime);
  for (const tool of XCRUN_TOOL_NAMES) results[tool] = (await assertT1Executable(results[tool], {
    allowedRoots, initConfigFiles: tool === "git" ? ["/dev/null"] : [], inspectLibraries, runtime,
  })).executable;
  return Object.freeze(results);
}

export async function resolveDeveloperTools({ runtime = {} } = {}) {
  const run = runtime.execFile ?? execFileResult;
  const selector = await assertT1Path("/usr/bin/xcode-select", { executable: true, runtime });
  const result = await run(selector, ["-p"], { env: buildTrustedEnvironment() });
  const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) refuse("xcode_select_resolution_invalid");
  const developerDirectory = await assertT1Path(lines[0], { allowedRoots: [lines[0]], runtime });
  const tools = await resolveXcrunTools({ allowedRoots: [developerDirectory], runtime });
  return Object.freeze({ developerDirectory, tools });
}

export async function verifyTrustedRuntimeInstallation({ runtimeDirectory, manifestPolicy, initPolicy }, runtime = {}) {
  const root = absolute(runtimeDirectory, "trusted_runtime_installation_invalid");
  const policy = validateTrustedRuntimeManifest(manifestPolicy);
  if (!plainRecord(initPolicy) || initPolicy.schema !== "control-room.trusted-runtime-init-config/v1"
    || !plainRecord(initPolicy.tools)) refuse("trusted_runtime_init_policy_invalid");
  const installed = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (!plainRecord(installed) || installed.schema !== "control-room.installed-trusted-runtime/v1"
    || installed.platform !== policy.platform || installed.architecture !== policy.architecture
    || !plainRecord(installed.installed)) refuse("trusted_runtime_installation_invalid");
  const developer = await resolveDeveloperTools({ runtime });
  const inspectLibraries = createOtoolInspector(developer.tools.otool, runtime);
  const checked = {};
  for (const artifact of policy.artifacts) {
    const record = installed.installed[artifact.tool], init = initPolicy.tools[artifact.tool];
    if (!plainRecord(record) || record.version !== artifact.version
      || record.directory !== `${artifact.tool}-${artifact.version}`
      || record.executable !== `${record.directory}/${artifact.executableRelativePath}`
      || !plainRecord(init) || !Array.isArray(init.files)) refuse("trusted_runtime_installation_invalid");
    const executable = join(root, record.executable);
    await verifyPinnedFile(executable, artifact.executableSha256);
    checked[artifact.tool] = await assertT1Executable(executable, {
      allowedRoots: [root], initConfigFiles: init.files, inspectLibraries, runtime,
    });
  }
  return Object.freeze({ runtimeDirectory: root, developerTools: developer, tools: Object.freeze(checked) });
}

function servicePath(root, suffix) {
  const path = join(root, suffix);
  if (!inside(root, path) || path === root) refuse("trusted_spawn_profile_parameter_invalid");
  return path;
}

export function buildServiceProfileParameters(role, input) {
  if (!SERVICE_PROFILE_ROLES.includes(role) || !plainRecord(input)) refuse("trusted_spawn_profile_parameter_invalid");
  const root = absolute(input.installRoot, "trusted_spawn_profile_parameter_invalid");
  if (root === "/" || ["/Users", "/opt/homebrew", "/usr/local"].some(path => inside(path, root))) {
    refuse("trusted_spawn_profile_parameter_invalid");
  }
  const log = name => servicePath(root, `logs/${role}/${name}.log`);
  let values;
  if (role === "supervisor" || role === "gateway") values = [
    ["RUNTIME_STATE", servicePath(root, "Protected/runtime-state")], ["OUT_LOG", log("out")], ["ERR_LOG", log("err")],
  ];
  else if (role === "postgres") {
    if (!/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(input.dataId ?? "")) refuse("trusted_spawn_profile_parameter_invalid");
    values = [["DATA_ROOT", servicePath(root, `pg/data-${input.dataId}`)], ["SOCKET_ROOT", servicePath(root, "pg/socket")],
      ["OUT_LOG", log("out")], ["ERR_LOG", log("err")]];
  } else if (role === "builder") {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.jobId ?? "")) refuse("trusted_spawn_profile_parameter_invalid");
    const job = servicePath(root, `build/job-${input.jobId}`);
    values = [["JOB_ROOT", job], ["TMPDIR", join(job, "tmp")], ["OUT_LOG", log("out")], ["ERR_LOG", log("err")]];
  } else {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(input.scratchId ?? "")) refuse("trusted_spawn_profile_parameter_invalid");
    values = [["SCRATCH_ROOT", servicePath(root, `pg/scratch-${input.scratchId}`)],
      ["SOCKET_ROOT", servicePath(root, "pg/socket")], ["OUT_LOG", log("out")], ["ERR_LOG", log("err")]];
  }
  const result = Object.freeze(values.map(([name, value]) => Object.freeze([name, value])));
  approvedProfileParameters.set(result, role);
  return result;
}

/**
 * The only supported child-process entry point for the updater TCB. uid/gid
 * are applied by posix_spawn before sandbox-exec starts, so the profile is
 * entered after the privilege drop.
 */
export async function spawnTrusted(options, runtime = {}) {
  if (!plainRecord(options) || !SERVICE_PROFILE_ROLES.includes(options.role)
    || !Array.isArray(options.args) || options.args.some(value => typeof value !== "string" || value.includes("\0"))
    || !Number.isSafeInteger(options.uid) || options.uid < 1
    || !Number.isSafeInteger(options.gid) || options.gid < 1
    || approvedProfileParameters.get(options.profileParameters) !== options.role
    || typeof options.inspectLibraries !== "function"
    || options.cwd !== undefined && (typeof options.cwd !== "string" || !isAbsolute(options.cwd)
      || resolve(options.cwd) !== options.cwd || options.cwd.includes("\0"))) refuse("trusted_spawn_input_invalid");
  const executable = (await assertT1Executable(options.executable, {
    allowedRoots: options.allowedRoots ?? [], initConfigFiles: options.initConfigFiles ?? [],
    inspectLibraries: options.inspectLibraries, runtime,
  })).executable;
  const profile = await assertT1Path(options.profile, { allowedRoots: options.allowedRoots ?? [], runtime });
  const sandbox = await assertT1Path("/usr/bin/sandbox-exec", { executable: true, runtime });
  const environment = buildTrustedEnvironment(options.environment ?? {}, { explicitlySet: options.explicitlySet ?? [] });
  const childSpawn = runtime.spawn ?? spawn;
  return childSpawn(sandbox, ["-f", profile, ...(options.profileParameters ?? []).flatMap(([name, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name) || typeof value !== "string" || value.includes("\0")) {
      refuse("trusted_spawn_profile_parameter_invalid");
    }
    return ["-D", `${name}=${value}`];
  }), "--", executable, ...options.args], {
    cwd: options.cwd,
    env: environment,
    uid: options.uid,
    gid: options.gid,
    shell: false,
    stdio: options.stdio ?? "ignore",
    detached: options.detached === true,
  });
}
