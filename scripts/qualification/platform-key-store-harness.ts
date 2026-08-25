import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readdir,
  realpath,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  BoundedOpaqueBlobFile,
  FileDescriptorUnwrapSecretSource,
  NodeSafeCommandRunner,
  ProtectedFileUnwrapSecretSource,
  ProtectedJsonEnvelopeFile,
  ProtectedStoreError,
  SystemClock,
  createNodePrivateKeyStore,
  sealEncryptedPrivateKey,
  type KeyReferenceV1,
  type SafeCommandRequestV1,
  type SafeCommandResultV1,
  type SafeCommandRunnerV1,
} from "../../src/node-policy/v1/index.ts";

type HarnessPlatform = "windows" | "macos" | "linux";
type CaseStatus = "pass" | "fail" | "blocked";
type MacosQualificationStage =
  | "platform_guard"
  | "fixture_compile"
  | "fixture_add"
  | "availability_probe"
  | "key_unlock"
  | "sign_verify"
  | "primary_delete"
  | "missing_probe"
  | "cleanup_delete";

interface CaseResultV1 {
  id: string;
  status: CaseStatus;
  category: string;
}

interface QualificationResultV1 {
  schema: "control-room.platform-key-store-qualification/v1";
  platform: HarnessPlatform;
  provider: "windows_dpapi_current_user" | "macos_keychain" | "encrypted_file";
  implementation: "createNodePrivateKeyStore";
  attempt: 1;
  passed: boolean;
  cases: CaseResultV1[];
  counts: Record<string, number>;
  publicKeyFingerprint: string;
  cleanupTargets: string[];
}

const FIXED_MESSAGE = Buffer.from("control-room CR-5C.9H qualification", "utf8");
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
let macosQualificationStage: MacosQualificationStage | undefined;

const dpapiProtectScript = `$ErrorActionPreference='Stop'
$plain=$null
$entropy=$null
$blob=$null
try {
  Add-Type -AssemblyName System.Security
  $payload=[Console]::In.ReadToEnd() | ConvertFrom-Json
  $plain=[byte[]]([Convert]::FromBase64String([string]$payload.plain))
  $entropy=[byte[]]([Convert]::FromBase64String([string]$payload.entropy))
  $blob=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($blob))
  exit 0
} catch {
  [Console]::Error.Write('CONTROL_ROOM_DPAPI_PROTECT_FAILED')
  exit 41
} finally {
  if ($null -ne $plain) {[Array]::Clear($plain,0,$plain.Length)}
  if ($null -ne $entropy) {[Array]::Clear($entropy,0,$entropy.Length)}
  if ($null -ne $blob) {[Array]::Clear($blob,0,$blob.Length)}
}`;

function reference(provider: KeyReferenceV1["provider"], mode: KeyReferenceV1["mode"]): KeyReferenceV1 {
  return {
    contractVersion: "control-room-node-policy/v1",
    keyId: `node-key:qualification:${provider}`,
    referenceId: `key-reference:qualification:${provider}`,
    provider,
    mode,
    algorithm: "Ed25519",
  };
}

function safeCategory(error: unknown): string {
  return error instanceof ProtectedStoreError ? error.code : "harness_failure";
}

async function expectStoreError(action: Promise<unknown>, expected: string): Promise<CaseResultV1> {
  try {
    await action;
    return { id: expected, status: "fail", category: "unexpected_success" };
  } catch (error) {
    const category = safeCategory(error);
    return { id: expected, status: category === expected ? "pass" : "fail", category };
  }
}

function fingerprint(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): string {
  const spki = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(spki).digest("hex");
}

async function requireScratch(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new ProtectedStoreError("invalid_configuration");
  const resolved = await realpath(path);
  if (resolved !== resolve(path)) throw new ProtectedStoreError("permission_denied");
  const stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ProtectedStoreError("permission_denied");
  const tempRoot = await realpath(tmpdir());
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalize(dirname(resolved)) !== normalize(tempRoot)
    || !/^control-room-cr5c9h-[a-z0-9-]{6,80}$/i.test(basename(resolved))
    || typeof process.getuid === "function" && stat.uid !== process.getuid()
    || (await readdir(resolved)).length !== 0) {
    throw new ProtectedStoreError("permission_denied");
  }
  return resolved;
}

class AuditedRunner implements SafeCommandRunnerV1 {
  readonly requests: Array<{ executable: string; args: string[]; stdinBytes: number }> = [];

  constructor(private readonly inner = new NodeSafeCommandRunner()) {}

  async run(request: SafeCommandRequestV1): Promise<SafeCommandResultV1> {
    this.requests.push({
      executable: request.executable,
      args: [...request.args],
      stdinBytes: request.stdin?.byteLength ?? 0,
    });
    return this.inner.run(request);
  }
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function windowsQualification(scratch: string): Promise<QualificationResultV1> {
  if (process.platform !== "win32") throw new ProtectedStoreError("unavailable_platform");
  const validPath = join(scratch, "dpapi-valid.bin");
  const tamperedPath = join(scratch, "dpapi-tampered.bin");
  const missingPath = join(scratch, "dpapi-missing.bin");
  const keys = generateKeyPairSync("ed25519");
  const pkcs8 = Buffer.from(keys.privateKey.export({ format: "der", type: "pkcs8" }));
  const entropy = randomBytes(32);
  const wrongEntropy = Buffer.from(entropy);
  wrongEntropy[0] ^= 0xff;
  const protectInput = Buffer.from(JSON.stringify({
    plain: pkcs8.toString("base64"),
    entropy: entropy.toString("base64"),
  }), "utf8");
  const provisioningRunner = new NodeSafeCommandRunner();
  let ciphertext: Buffer | undefined;
  const cases: CaseResultV1[] = [];
  const audited = new AuditedRunner();
  try {
    const protectedResult = await provisioningRunner.run({
      executable: POWERSHELL,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(dpapiProtectScript)],
      stdin: protectInput,
      timeoutMilliseconds: 30_000,
      maxOutputBytes: 32_768,
    });
    try {
      if (protectedResult.exitCode !== 0) throw new ProtectedStoreError("unavailable_platform");
      ciphertext = Buffer.from(Buffer.from(protectedResult.stdout).toString("utf8").trim(), "base64");
    } finally {
      protectedResult.stdout.fill(0);
      protectedResult.stderr.fill(0);
    }
    if (ciphertext.byteLength < 16) throw new ProtectedStoreError("corrupt");
    const tampered = Buffer.from(ciphertext);
    tampered[tampered.byteLength - 1] ^= 0xff;
    await writeFile(validPath, ciphertext, { flag: "wx" });
    await writeFile(tamperedPath, tampered, { flag: "wx" });
    tampered.fill(0);

    const ref = reference("windows_dpapi_current_user", "native");
    const store = createNodePrivateKeyStore({
      platform: "win32", provider: "windows_dpapi_current_user", runtimeMode: "production", reference: ref,
    }, {
      clock: new SystemClock(),
      windows: {
        blobLoader: new BoundedOpaqueBlobFile(validPath),
        entropyLoader: async () => Uint8Array.from(entropy),
        runner: audited,
      },
    });
    const availability = (await store.availability()).state;
    cases.push({ id: "availability", status: availability === "available" ? "pass" : "fail", category: availability });
    await store.unlock();
    const signature = await store.sign(FIXED_MESSAGE);
    cases.push({ id: "sign_verify", status: verify(null, FIXED_MESSAGE, keys.publicKey, signature) ? "pass" : "fail", category: "ed25519" });
    await store.lock();
    cases.push({ ...(await expectStoreError(store.sign(FIXED_MESSAGE), "key_not_unlocked")), id: "lock_sign_refusal" });
    await store.dispose();

    for (const [id, path, suppliedEntropy] of [
      ["tampered_refusal", tamperedPath, entropy],
      ["wrong_entropy_refusal", validPath, wrongEntropy],
    ] as const) {
      const refusal = createNodePrivateKeyStore({
        platform: "win32", provider: "windows_dpapi_current_user", runtimeMode: "production", reference: ref,
      }, {
        clock: new SystemClock(),
        windows: {
          blobLoader: new BoundedOpaqueBlobFile(path),
          entropyLoader: async () => Uint8Array.from(suppliedEntropy),
          runner: audited,
        },
      });
      const result = await expectStoreError(refusal.unlock(), "locked");
      cases.push({ ...result, id });
      await refusal.dispose();
    }

    const missing = createNodePrivateKeyStore({
      platform: "win32", provider: "windows_dpapi_current_user", runtimeMode: "production", reference: ref,
    }, {
      clock: new SystemClock(),
      windows: { blobLoader: new BoundedOpaqueBlobFile(missingPath), runner: audited },
    });
    const missingState = (await missing.availability()).state;
    cases.push({ id: "missing_availability", status: missingState === "missing" ? "pass" : "fail", category: missingState });
    await missing.dispose();

    const privateTokens = [pkcs8.toString("base64"), ciphertext.toString("base64"), entropy.toString("base64")];
    const argv = audited.requests.flatMap((request) => request.args);
    const argvSafe = privateTokens.every((token) => argv.every((argument) => !argument.includes(token)));
    cases.push({ id: "argv_boundary", status: argvSafe ? "pass" : "fail", category: argvSafe ? "metadata_only" : "secret_in_argv" });
    cases.push({ id: "adapter_invocation_count", status: audited.requests.length === 3 ? "pass" : "fail", category: String(audited.requests.length) });

    return {
      schema: "control-room.platform-key-store-qualification/v1",
      platform: "windows",
      provider: "windows_dpapi_current_user",
      implementation: "createNodePrivateKeyStore",
      attempt: 1,
      passed: cases.every((item) => item.status === "pass"),
      cases,
      counts: { keypairs: 1, protectCalls: 1, adapterUnprotectCalls: audited.requests.length, scratchFiles: 2 },
      publicKeyFingerprint: fingerprint(keys.publicKey),
      cleanupTargets: ["dpapi-valid.bin", "dpapi-tampered.bin"],
    };
  } finally {
    pkcs8.fill(0);
    entropy.fill(0);
    wrongEntropy.fill(0);
    protectInput.fill(0);
    ciphertext?.fill(0);
  }
}

async function linuxChild(envelopePath: string): Promise<void> {
  if (process.platform !== "linux") throw new ProtectedStoreError("unavailable_platform");
  const ref = reference("encrypted_file", "encrypted_file");
  const store = createNodePrivateKeyStore({
    platform: "linux", provider: "encrypted_file", runtimeMode: "production", unwrapSecretSource: "file_descriptor", reference: ref,
  }, {
    clock: new SystemClock(),
    encryptedFile: {
      envelopeLoader: new ProtectedJsonEnvelopeFile(envelopePath),
      unwrapSource: new FileDescriptorUnwrapSecretSource(3),
    },
  });
  try {
    await store.unlock();
    const signature = await store.sign(FIXED_MESSAGE);
    process.stdout.write(JSON.stringify({ schema: "control-room.qualification-child/v1", signature: Buffer.from(signature).toString("base64url") }));
  } finally {
    await store.dispose();
  }
}

async function spawnLinuxChild(envelopePath: string, handle: FileHandle): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath, "--linux-child", "--envelope", envelopePath], {
      cwd: resolve(scriptDirectory, "../.."),
      env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "test" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe", handle.fd],
    }) as unknown as ChildProcess;
    const stdout: Buffer[] = [];
    let total = 0;
    const fail = () => {
      try { child.kill(); } catch { /* safe fixed failure below */ }
      reject(new ProtectedStoreError("unavailable_platform"));
    };
    child.on("error", fail);
    if (!child.stdout || !child.stderr) return reject(new ProtectedStoreError("unavailable_platform"));
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > 8_192) return fail();
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", () => undefined);
    child.on("close", (code: number | null) => resolvePromise({ exitCode: code ?? -1, stdout: Buffer.concat(stdout).toString("utf8") }));
  });
}

async function linuxQualification(scratch: string): Promise<QualificationResultV1> {
  if (process.platform !== "linux") throw new ProtectedStoreError("unavailable_platform");
  const envelopePath = join(scratch, "encrypted-key.json");
  const tamperedPath = join(scratch, "encrypted-key-tampered.json");
  const wrapPath = join(scratch, "wrap.key");
  const wrongWrapPath = join(scratch, "wrap-wrong.key");
  const linkPath = join(scratch, "wrap-link.key");
  const missingPath = join(scratch, "wrap-missing.key");
  const shortPath = join(scratch, "wrap-31.key");
  const longPath = join(scratch, "wrap-33.key");
  const keys = generateKeyPairSync("ed25519");
  const wrappingKey = randomBytes(32);
  const wrongWrappingKey = Buffer.from(wrappingKey);
  wrongWrappingKey[0] ^= 0xff;
  const ref = reference("encrypted_file", "encrypted_file");
  const envelope = sealEncryptedPrivateKey({ privateKey: keys.privateKey, reference: ref, wrappingKey: Uint8Array.from(wrappingKey) });
  const tag = Buffer.from(envelope.authenticationTag, "base64url");
  tag[0] ^= 0xff;
  const tamperedEnvelope = { ...envelope, authenticationTag: tag.toString("base64url") };
  const cases: CaseResultV1[] = [];
  let handle: FileHandle | undefined;
  try {
    await writeFile(envelopePath, JSON.stringify(envelope), { mode: 0o600, flag: "wx" });
    await writeFile(tamperedPath, JSON.stringify(tamperedEnvelope), { mode: 0o600, flag: "wx" });
    await writeFile(wrapPath, wrappingKey, { mode: 0o600, flag: "wx" });
    await writeFile(wrongWrapPath, wrongWrappingKey, { mode: 0o600, flag: "wx" });
    await writeFile(shortPath, Buffer.alloc(31, 0x31), { mode: 0o600, flag: "wx" });
    await writeFile(longPath, Buffer.alloc(33, 0x33), { mode: 0o600, flag: "wx" });
    await symlink(wrapPath, linkPath, "file");

    const store = createNodePrivateKeyStore({
      platform: "linux", provider: "encrypted_file", runtimeMode: "production", unwrapSecretSource: "protected_file", reference: ref,
    }, {
      clock: new SystemClock(),
      encryptedFile: {
        envelopeLoader: new ProtectedJsonEnvelopeFile(envelopePath),
        unwrapSource: new ProtectedFileUnwrapSecretSource(wrapPath),
      },
    });
    const state = (await store.availability()).state;
    cases.push({ id: "protected_file_availability", status: state === "available" ? "pass" : "fail", category: state });
    await store.unlock();
    cases.push({ id: "protected_file_sign_verify", status: verify(null, FIXED_MESSAGE, keys.publicKey, await store.sign(FIXED_MESSAGE)) ? "pass" : "fail", category: "ed25519" });
    await store.lock();
    cases.push({ ...(await expectStoreError(store.sign(FIXED_MESSAGE), "key_not_unlocked")), id: "lock_sign_refusal" });
    await store.dispose();

    handle = await open(wrapPath, "r");
    const child = await spawnLinuxChild(envelopePath, handle);
    const childPayload = child.exitCode === 0 ? JSON.parse(child.stdout) as { signature?: string } : {};
    const childSignature = childPayload.signature ? Buffer.from(childPayload.signature, "base64url") : Buffer.alloc(0);
    cases.push({ id: "fresh_child_fd_sign_verify", status: child.exitCode === 0 && verify(null, FIXED_MESSAGE, keys.publicKey, childSignature) ? "pass" : "fail", category: child.exitCode === 0 ? "ed25519" : "child_failure" });
    await handle.close();
    handle = undefined;

    const refuse = async (id: string, envelopeFile: string, secretFile: string, expected: string) => {
      const candidate = createNodePrivateKeyStore({
        platform: "linux", provider: "encrypted_file", runtimeMode: "production", unwrapSecretSource: "protected_file", reference: ref,
      }, {
        clock: new SystemClock(),
        encryptedFile: {
          envelopeLoader: new ProtectedJsonEnvelopeFile(envelopeFile),
          unwrapSource: new ProtectedFileUnwrapSecretSource(secretFile),
        },
      });
      let result: CaseResultV1;
      if (expected === "availability_permission_denied") {
        const availability = (await candidate.availability()).state;
        result = { id, status: availability === "permission_denied" ? "pass" : "fail", category: availability };
      } else {
        result = { ...(await expectStoreError(candidate.unlock(), expected)), id };
      }
      cases.push(result);
      await candidate.dispose();
    };
    await refuse("tampered_tag_refusal", tamperedPath, wrapPath, "corrupt");
    await refuse("wrong_key_refusal", envelopePath, wrongWrapPath, "corrupt");
    await chmod(wrapPath, 0o644);
    try {
      await refuse("mode_drift_refusal", envelopePath, wrapPath, "availability_permission_denied");
    } finally {
      await chmod(wrapPath, 0o600);
    }
    await refuse("symlink_refusal", envelopePath, linkPath, "availability_permission_denied");
    const missing = new ProtectedFileUnwrapSecretSource(missingPath);
    const missingState = await missing.availability();
    cases.push({ id: "missing_secret_refusal", status: missingState === "missing" ? "pass" : "fail", category: missingState });
    await missing.dispose();

    for (const [id, path] of [["descriptor_31_refusal", shortPath], ["descriptor_33_refusal", longPath]] as const) {
      const descriptor = await open(path, "r");
      try {
        const source = new FileDescriptorUnwrapSecretSource(descriptor.fd);
        cases.push({ ...(await expectStoreError(source.read(), "invalid_configuration")), id });
        await source.dispose();
      } finally {
        await descriptor.close();
      }
    }

    return {
      schema: "control-room.platform-key-store-qualification/v1",
      platform: "linux",
      provider: "encrypted_file",
      implementation: "createNodePrivateKeyStore",
      attempt: 1,
      passed: cases.every((item) => item.status === "pass"),
      cases,
      counts: { keypairs: 1, wrapKeys: 1, childProcesses: 1, harnessRuns: 1, scratchFiles: 6, scratchSymlinks: 1 },
      publicKeyFingerprint: fingerprint(keys.publicKey),
      cleanupTargets: ["encrypted-key.json", "encrypted-key-tampered.json", "wrap.key", "wrap-wrong.key", "wrap-31.key", "wrap-33.key", "wrap-link.key"],
    };
  } finally {
    await handle?.close();
    wrappingKey.fill(0);
    wrongWrappingKey.fill(0);
    tag.fill(0);
  }
}

async function macosQualification(scratch: string, service: string, account: string): Promise<QualificationResultV1> {
  macosQualificationStage = "platform_guard";
  if (process.platform !== "darwin") throw new ProtectedStoreError("unavailable_platform");
  const helperSource = join(scriptDirectory, "macos-keychain-fixture.swift");
  const helperBinary = join(scratch, "macos-keychain-fixture");
  const keys = generateKeyPairSync("ed25519");
  const pkcs8 = Buffer.from(keys.privateKey.export({ format: "der", type: "pkcs8" })).toString("base64");
  const secret = Buffer.from(pkcs8, "utf8");
  const runner = new AuditedRunner();
  const cases: CaseResultV1[] = [];
  let itemCreated = false;
  let result: QualificationResultV1 | undefined;
  let failure: unknown;
  let failureStage: MacosQualificationStage | undefined;
  try {
    macosQualificationStage = "fixture_compile";
    const compile = await new NodeSafeCommandRunner().run({
      executable: "/usr/bin/swiftc",
      args: [helperSource, "-framework", "Security", "-o", helperBinary],
      timeoutMilliseconds: 60_000,
      maxOutputBytes: 32_768,
    });
    try {
      if (compile.exitCode !== 0) throw new ProtectedStoreError("unavailable_platform");
    } finally {
      compile.stdout.fill(0);
      compile.stderr.fill(0);
    }
    macosQualificationStage = "fixture_add";
    const add = await new NodeSafeCommandRunner().run({
      executable: helperBinary,
      args: ["add", service, account],
      stdin: secret,
      timeoutMilliseconds: 30_000,
      maxOutputBytes: 4_096,
    });
    try {
      if (add.exitCode !== 0 || Buffer.from(add.stdout).toString("utf8") !== "CONTROL_ROOM_MAC_FIXTURE_ADDED") throw new ProtectedStoreError("unavailable_platform");
      itemCreated = true;
    } finally {
      add.stdout.fill(0);
      add.stderr.fill(0);
    }

    const ref = reference("macos_keychain", "native");
    const store = createNodePrivateKeyStore({
      platform: "darwin", provider: "macos_keychain", runtimeMode: "production", reference: ref,
    }, { clock: new SystemClock(), macos: { service, account, runner } });
    macosQualificationStage = "availability_probe";
    const state = (await store.availability()).state;
    cases.push({ id: "availability", status: state === "available" ? "pass" : "fail", category: state });
    process.stderr.write("CONTROL_ROOM_MACOS_ALLOW_ONCE_WINDOW\n");
    macosQualificationStage = "key_unlock";
    await store.unlock();
    macosQualificationStage = "sign_verify";
    cases.push({ id: "sign_verify", status: verify(null, FIXED_MESSAGE, keys.publicKey, await store.sign(FIXED_MESSAGE)) ? "pass" : "fail", category: "ed25519" });
    await store.lock();
    cases.push({ ...(await expectStoreError(store.sign(FIXED_MESSAGE), "key_not_unlocked")), id: "lock_sign_refusal" });
    await store.dispose();

    macosQualificationStage = "primary_delete";
    const deletion = await new NodeSafeCommandRunner().run({
      executable: "/usr/bin/security",
      args: ["delete-generic-password", "-s", service, "-a", account],
      timeoutMilliseconds: 15_000,
      maxOutputBytes: 8_192,
    });
    try {
      if (deletion.exitCode !== 0) throw new ProtectedStoreError("permission_denied");
      itemCreated = false;
    } finally {
      deletion.stdout.fill(0);
      deletion.stderr.fill(0);
    }
    const missing = createNodePrivateKeyStore({
      platform: "darwin", provider: "macos_keychain", runtimeMode: "production", reference: ref,
    }, { clock: new SystemClock(), macos: { service, account, runner } });
    macosQualificationStage = "missing_probe";
    const missingState = (await missing.availability()).state;
    cases.push({ id: "missing_mapping", status: missingState === "missing" ? "pass" : "fail", category: missingState });
    await missing.dispose();

    const argv = runner.requests.flatMap((request) => request.args);
    const argvSafe = argv.every((argument) => !argument.includes(pkcs8));
    cases.push({ id: "argv_boundary", status: argvSafe ? "pass" : "fail", category: argvSafe ? "metadata_only" : "secret_in_argv" });
    cases.push({ id: "adapter_invocation_count", status: runner.requests.length === 3 ? "pass" : "fail", category: String(runner.requests.length) });

    result = {
      schema: "control-room.platform-key-store-qualification/v1",
      platform: "macos",
      provider: "macos_keychain",
      implementation: "createNodePrivateKeyStore",
      attempt: 1,
      passed: cases.every((item) => item.status === "pass"),
      cases,
      counts: { keypairs: 1, helperCompiles: 1, helperRuns: 1, adapterCalls: runner.requests.length, keychainItems: 1, keychainDeletes: 1 },
      publicKeyFingerprint: fingerprint(keys.publicKey),
      cleanupTargets: ["macos-keychain-fixture", `keychain:${service}:${account}`],
    };
  } catch (error) {
    failure = error;
    failureStage = macosQualificationStage;
  }
  try {
    secret.fill(0);
    if (itemCreated) {
      macosQualificationStage = "cleanup_delete";
      const cleanup = await new NodeSafeCommandRunner().run({
        executable: "/usr/bin/security",
        args: ["delete-generic-password", "-s", service, "-a", account],
        timeoutMilliseconds: 15_000,
        maxOutputBytes: 8_192,
      });
      cleanup.stdout.fill(0);
      cleanup.stderr.fill(0);
      if (cleanup.exitCode !== 0) {
        failure = new ProtectedStoreError("permission_denied");
        failureStage = "cleanup_delete";
      }
    }
  } catch {
    failure = new ProtectedStoreError("permission_denied");
    failureStage = "cleanup_delete";
  }
  if (failure) {
    macosQualificationStage = failureStage;
    throw failure;
  }
  if (!result) throw new ProtectedStoreError("unavailable_platform");
  macosQualificationStage = undefined;
  return result;
}

function parseNamedArguments(values: string[], allowed: Set<string>): Map<string, string> {
  if (values.length % 2 !== 0) throw new ProtectedStoreError("invalid_configuration");
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name || !value || !allowed.has(name) || parsed.has(name) || value.startsWith("--")) {
      throw new ProtectedStoreError("invalid_configuration");
    }
    parsed.set(name, value);
  }
  return parsed;
}

async function main(): Promise<void> {
  const values = process.argv.slice(2);
  if (values[0] === "--linux-child") {
    if (values.length !== 3 || values[1] !== "--envelope" || !values[2] || !isAbsolute(values[2])) {
      throw new ProtectedStoreError("invalid_configuration");
    }
    const envelope = values[2];
    await linuxChild(envelope);
    return;
  }
  const args = parseNamedArguments(values, new Set(["--platform", "--scratch", "--service", "--account"]));
  const platform = args.get("--platform") as HarnessPlatform | undefined;
  const scratchInput = args.get("--scratch");
  if (!platform || !scratchInput || !["windows", "macos", "linux"].includes(platform)) throw new ProtectedStoreError("invalid_configuration");
  if (platform !== "macos" && (args.has("--service") || args.has("--account")) || platform === "macos" && args.size !== 4 || platform !== "macos" && args.size !== 2) {
    throw new ProtectedStoreError("invalid_configuration");
  }
  const scratch = await requireScratch(scratchInput);
  let result: QualificationResultV1;
  if (platform === "windows") result = await windowsQualification(scratch);
  else if (platform === "linux") result = await linuxQualification(scratch);
  else {
    const service = args.get("--service");
    const account = args.get("--account");
    if (!service || !account) throw new ProtectedStoreError("invalid_configuration");
    result = await macosQualification(scratch, service, account);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({
    schema: "control-room.platform-key-store-qualification-error/v1",
    category: safeCategory(error),
    ...(macosQualificationStage === undefined ? {} : { qualificationStage: macosQualificationStage }),
  })}\n`);
  process.exitCode = 1;
});

export { linuxQualification, macosQualification, windowsQualification };
