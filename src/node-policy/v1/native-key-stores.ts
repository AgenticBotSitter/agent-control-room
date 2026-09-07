import { spawn } from "node:child_process";
import { lstat, open, type FileHandle } from "node:fs/promises";
import type { Clock } from "./clock";
import { MemoryBackedNodePrivateKeyStore } from "./private-key-runtime";
import { ProtectedStoreError } from "./stores";
import type { KeyAvailabilityState, KeyReferenceV1 } from "./types";

export interface SafeCommandRequestV1 {
  executable: string;
  args: string[];
  stdin?: Uint8Array;
  timeoutMilliseconds: number;
  maxOutputBytes: number;
}

export interface SafeCommandResultV1 {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface SafeCommandRunnerV1 {
  run(request: SafeCommandRequestV1): Promise<SafeCommandResultV1>;
}

export class NodeSafeCommandRunner implements SafeCommandRunnerV1 {
  async run(request: SafeCommandRequestV1): Promise<SafeCommandResultV1> {
    if (!Number.isSafeInteger(request.timeoutMilliseconds) || request.timeoutMilliseconds < 100 || request.timeoutMilliseconds > 60_000
      || !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 256 || request.maxOutputBytes > 1_048_576) {
      throw new ProtectedStoreError("invalid_configuration");
    }
    return new Promise((resolve,reject) => {
      let settled = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawn(request.executable,request.args,{
        shell: false,
        windowsHide: true,
        stdio: ["pipe","pipe","pipe"],
      });
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch { /* fixed safe failure below */ }
        stdout.forEach((chunk) => chunk.fill(0));
        stderr.forEach((chunk) => chunk.fill(0));
        reject(new ProtectedStoreError("unavailable_platform"));
      };
      const timer = setTimeout(fail,request.timeoutMilliseconds);
      child.on("error",fail);
      child.stdout.on("data",(chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes + stderrBytes > request.maxOutputBytes) return fail();
        stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data",(chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stdoutBytes + stderrBytes > request.maxOutputBytes) return fail();
        stderr.push(Buffer.from(chunk));
      });
      child.on("close",(code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const output = Uint8Array.from(Buffer.concat(stdout));
        const diagnostic = Uint8Array.from(Buffer.concat(stderr));
        stdout.forEach((chunk) => chunk.fill(0));
        stderr.forEach((chunk) => chunk.fill(0));
        resolve({ exitCode: code ?? -1,stdout: output,stderr: diagnostic });
      });
      child.stdin.on("error",fail);
      if (request.stdin) child.stdin.end(Buffer.from(request.stdin)); else child.stdin.end();
    });
  }
}

function safeComponent(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(value)) throw new ProtectedStoreError("invalid_configuration");
  return value;
}

function boundedBase64Output(value: Uint8Array): Uint8Array {
  const text = Buffer.from(value).toString("utf8").trim();
  if (text.length < 32 || text.length > 16_384 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) throw new ProtectedStoreError("corrupt");
  const decoded = Buffer.from(text,"base64");
  if (decoded.byteLength < 32 || decoded.byteLength > 8_192) throw new ProtectedStoreError("corrupt");
  return new Uint8Array(decoded);
}

function macFailure(result: SafeCommandResultV1): ProtectedStoreError {
  const diagnostic = Buffer.from(result.stderr);
  try {
    if (result.exitCode === 44 || diagnostic.includes(Buffer.from("-25300"))) return new ProtectedStoreError("missing");
    if (result.exitCode === 36 || diagnostic.includes(Buffer.from("-25308"))) return new ProtectedStoreError("interaction_required");
    if (diagnostic.includes(Buffer.from("-25293"))) return new ProtectedStoreError("locked");
    if (diagnostic.includes(Buffer.from("-25294")) || diagnostic.includes(Buffer.from("-25243"))) return new ProtectedStoreError("permission_denied");
    return new ProtectedStoreError("unavailable_platform");
  } finally {
    diagnostic.fill(0);
  }
}

export class MacOsKeychainNodePrivateKeyStore extends MemoryBackedNodePrivateKeyStore {
  private readonly service: string;
  private readonly account: string;

  constructor(reference: KeyReferenceV1, clock: Clock, input: {
    service: string;
    account: string;
    runner?: SafeCommandRunnerV1;
  }) {
    super(reference,clock);
    if (reference.provider !== "macos_keychain" || reference.mode !== "native") throw new ProtectedStoreError("invalid_configuration");
    this.service = safeComponent(input.service);
    this.account = safeComponent(input.account);
    this.runner = input.runner ?? new NodeSafeCommandRunner();
    this.securityExecutable = "/usr/bin/security";
  }

  private readonly runner: SafeCommandRunnerV1;
  private readonly securityExecutable: string;

  protected async probeAvailability(): Promise<KeyAvailabilityState> {
    const result = await this.run(false);
    try {
      if (result.exitCode === 0) return "available";
      throw macFailure(result);
    } finally {
      result.stdout.fill(0);
      result.stderr.fill(0);
    }
  }

  protected async loadPkcs8(): Promise<Uint8Array> {
    const result = await this.run(true);
    try {
      if (result.exitCode !== 0) throw macFailure(result);
      return boundedBase64Output(result.stdout);
    } finally {
      result.stdout.fill(0);
      result.stderr.fill(0);
    }
  }

  private run(withSecret: boolean): Promise<SafeCommandResultV1> {
    return this.runner.run({
      executable: this.securityExecutable,
      args: ["find-generic-password","-s",this.service,"-a",this.account,...(withSecret ? ["-w"] : [])],
      timeoutMilliseconds: 15_000,
      maxOutputBytes: 32_768,
    });
  }
}

export interface OpaqueBlobLoaderV1 {
  availability(): Promise<KeyAvailabilityState>;
  load(): Promise<Uint8Array>;
}

export class BoundedOpaqueBlobFile implements OpaqueBlobLoaderV1 {
  constructor(private readonly path: string, private readonly maxBytes = 65_536) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 1_048_576) throw new ProtectedStoreError("invalid_configuration");
  }

  async availability(): Promise<KeyAvailabilityState> {
    let handle: FileHandle | undefined;
    try {
      const opened = await this.openBounded();
      handle = opened.handle;
      return "available";
    } catch (error) {
      if (error instanceof ProtectedStoreError && ["missing","corrupt","permission_denied"].includes(error.code)) return error.code as KeyAvailabilityState;
      return "unavailable_platform";
    } finally {
      await handle?.close();
    }
  }

  async load(): Promise<Uint8Array> {
    const opened = await this.openBounded();
    try {
      return new Uint8Array(await opened.handle.readFile());
    } catch {
      throw new ProtectedStoreError("unavailable_platform");
    } finally {
      await opened.handle.close();
    }
  }

  private async openBounded(): Promise<{ handle: FileHandle }> {
    let before;
    try {
      before = await lstat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ProtectedStoreError("missing");
      if ((error as NodeJS.ErrnoException).code === "EACCES") throw new ProtectedStoreError("permission_denied");
      throw new ProtectedStoreError("unavailable_platform");
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size < 16 || before.size > this.maxBytes) throw new ProtectedStoreError("corrupt");
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.path,"r");
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw new ProtectedStoreError("permission_denied");
      return { handle };
    } catch (error) {
      await handle?.close();
      if (error instanceof ProtectedStoreError) throw error;
      throw new ProtectedStoreError("unavailable_platform");
    }
  }
}

const dpapiUnprotectScript = `$ErrorActionPreference='Stop'
try {
  Add-Type -AssemblyName System.Security
  $payload=[Console]::In.ReadToEnd() | ConvertFrom-Json
  $blob=[byte[]]([Convert]::FromBase64String([string]$payload.blob))
  $entropy=if ($null -eq $payload.entropy) {$null} else {[byte[]]([Convert]::FromBase64String([string]$payload.entropy))}
  $plain=[Security.Cryptography.ProtectedData]::Unprotect($blob,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($plain))
  [Array]::Clear($plain,0,$plain.Length)
  exit 0
} catch {
  [Console]::Error.Write('CONTROL_ROOM_DPAPI_UNPROTECT_FAILED')
  exit 41
}`;

function encodedPowerShell(script: string): string {
  return Buffer.from(script,"utf16le").toString("base64");
}

export class WindowsDpapiNodePrivateKeyStore extends MemoryBackedNodePrivateKeyStore {
  private readonly runner: SafeCommandRunnerV1;
  private readonly powershellExecutable: string;

  constructor(reference: KeyReferenceV1, clock: Clock, private readonly blobLoader: OpaqueBlobLoaderV1, input: {
    entropyLoader?: () => Promise<Uint8Array>;
    runner?: SafeCommandRunnerV1;
  } = {}) {
    super(reference,clock);
    if (reference.provider !== "windows_dpapi_current_user" || reference.mode !== "native") throw new ProtectedStoreError("invalid_configuration");
    this.entropyLoader = input.entropyLoader;
    this.runner = input.runner ?? new NodeSafeCommandRunner();
    this.powershellExecutable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  }

  private readonly entropyLoader?: () => Promise<Uint8Array>;

  protected probeAvailability(): Promise<KeyAvailabilityState> {
    return this.blobLoader.availability();
  }

  protected async loadPkcs8(): Promise<Uint8Array> {
    let blob: Uint8Array | undefined;
    let entropy: Uint8Array | undefined;
    let stdin: Buffer | undefined;
    try {
      blob = await this.blobLoader.load();
      entropy = this.entropyLoader ? await this.entropyLoader() : undefined;
      if (blob.byteLength < 16 || blob.byteLength > 1_048_576
        || entropy && (entropy.byteLength < 1 || entropy.byteLength > 4_096)) {
        throw new ProtectedStoreError("invalid_configuration");
      }
      stdin = Buffer.from(JSON.stringify({
        blob: Buffer.from(blob).toString("base64"),
        entropy: entropy ? Buffer.from(entropy).toString("base64") : null,
      }),"utf8");
      const result = await this.runner.run({
        executable: this.powershellExecutable,
        args: ["-NoLogo","-NoProfile","-NonInteractive","-EncodedCommand",encodedPowerShell(dpapiUnprotectScript)],
        stdin,
        timeoutMilliseconds: 30_000,
        maxOutputBytes: 32_768,
      });
      try {
        if (result.exitCode !== 0) throw new ProtectedStoreError("locked");
        return boundedBase64Output(result.stdout);
      } finally {
        result.stdout.fill(0);
        result.stderr.fill(0);
      }
    } finally {
      blob?.fill(0);
      entropy?.fill(0);
      stdin?.fill(0);
    }
  }
}
