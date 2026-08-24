import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EncryptedFileNodePrivateKeyStore,
  FileDescriptorUnwrapSecretSource,
  InjectedUnwrapSecretSource,
  MacOsKeychainNodePrivateKeyStore,
  NodeSafeCommandRunner,
  ProtectedJsonEnvelopeFile,
  ProtectedStoreError,
  WindowsDpapiNodePrivateKeyStore,
  createNodePrivateKeyStore,
  sealEncryptedPrivateKey,
  type EncryptedEnvelopeLoader,
  type EncryptedPrivateKeyEnvelopeV1,
  type KeyReferenceV1,
  type OpaqueBlobLoaderV1,
  type SafeCommandRequestV1,
  type SafeCommandResultV1,
  type SafeCommandRunnerV1,
} from "../src/node-policy/v1/index.ts";
import { MutableTestClock } from "../src/node-policy/v1/testing.ts";

const now = "2026-08-23T12:00:00.000Z";
const clock = () => new MutableTestClock(now);

function reference(provider: KeyReferenceV1["provider"], mode: KeyReferenceV1["mode"]): KeyReferenceV1 {
  return {
    contractVersion: "control-room-node-policy/v1",
    keyId: "node-key:platform:1",
    referenceId: "key-reference:platform:1",
    provider,
    mode,
    algorithm: "Ed25519",
  };
}

class FixedRunner implements SafeCommandRunnerV1 {
  readonly requests: SafeCommandRequestV1[] = [];

  constructor(private readonly result: SafeCommandResultV1 | ((request: SafeCommandRequestV1) => SafeCommandResultV1)) {}

  async run(request: SafeCommandRequestV1): Promise<SafeCommandResultV1> {
    this.requests.push({ ...request,args: [...request.args],...(request.stdin ? { stdin: Uint8Array.from(request.stdin) } : {}) });
    return typeof this.result === "function" ? this.result(request) : this.result;
  }
}

function result(exitCode: number, stdout = "", stderr = ""): SafeCommandResultV1 {
  return { exitCode,stdout: Buffer.from(stdout),stderr: Buffer.from(stderr) };
}

function memoryEnvelopeLoader(envelope: EncryptedPrivateKeyEnvelopeV1): EncryptedEnvelopeLoader {
  return { availability: async () => "available",load: async () => structuredClone(envelope) };
}

async function storeError(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action,(error) => error instanceof ProtectedStoreError && error.code === code);
}

test("encrypted-file provider decrypts only an exactly bound Ed25519 envelope", async () => {
  const keys = generateKeyPairSync("ed25519");
  const ref = reference("encrypted_file","encrypted_file");
  const wrappingKey = Buffer.alloc(32,0x5a);
  const envelope = sealEncryptedPrivateKey({ privateKey: keys.privateKey,reference: ref,wrappingKey,nonce: Buffer.alloc(12,0x33) });
  const source = new InjectedUnwrapSecretSource("file_descriptor",async () => Uint8Array.from(wrappingKey));
  const store = new EncryptedFileNodePrivateKeyStore(ref,clock(),memoryEnvelopeLoader(envelope),source);
  assert.deepEqual(await store.availability(),{ state: "available",keyReferenceId: ref.referenceId,observedAt: now });
  await storeError(store.sign(Buffer.from("locked")),"key_not_unlocked");
  await store.unlock();
  const message = Buffer.from("portable encrypted-file signer");
  assert.equal(verify(null,message,keys.publicKey,await store.sign(message)),true);
  await store.lock();
  await storeError(store.sign(message),"key_not_unlocked");
  await store.unlock();
  await store.dispose();
  await storeError(store.availability(),"disposed");
  await storeError(source.read(),"disposed");
});

test("encrypted-file provider rejects tag, identity, schema, and unwrap-key drift without fallback", async () => {
  const keys = generateKeyPairSync("ed25519");
  const ref = reference("encrypted_file","encrypted_file");
  const wrappingKey = Buffer.alloc(32,0x11);
  const envelope = sealEncryptedPrivateKey({ privateKey: keys.privateKey,reference: ref,wrappingKey,nonce: Buffer.alloc(12,0x22) });
  const attempt = async (value: unknown,secret = wrappingKey) => {
    const store = new EncryptedFileNodePrivateKeyStore(ref,clock(),{ availability: async () => "available",load: async () => value },
      new InjectedUnwrapSecretSource("platform_secret",async () => Uint8Array.from(secret)));
    await storeError(store.unlock(),"corrupt");
  };
  const tag = Buffer.from(envelope.authenticationTag,"base64url");
  tag[0] ^= 0xff;
  await attempt({ ...envelope,authenticationTag: tag.toString("base64url") });
  await attempt({ ...envelope,keyId: "node-key:different" });
  await attempt({ ...envelope,unexpected: true });
  await attempt(envelope,Buffer.alloc(32,0x99));

  const invalidSource = new InjectedUnwrapSecretSource("file_descriptor",async () => Buffer.alloc(31));
  const store = new EncryptedFileNodePrivateKeyStore(ref,clock(),memoryEnvelopeLoader(envelope),invalidSource);
  await storeError(store.unlock(),"invalid_configuration");
});

test("protected file loader refuses Windows when ACL ownership cannot be proven", async () => {
  const directory = await mkdtemp(join(tmpdir(),"control-room-envelope-"));
  const path = join(directory,"node-key.json");
  try {
    await writeFile(path,"x".repeat(128));
    const loader = new ProtectedJsonEnvelopeFile(path,"win32");
    assert.equal(await loader.availability(),"unavailable_platform");
    await storeError(loader.load(),"unavailable_platform");
  } finally {
    await rm(directory,{ recursive: true,force: true });
  }
});

test("file-descriptor unwrap source is inherited, exact-length, and one-shot", async () => {
  const directory = await mkdtemp(join(tmpdir(),"control-room-unwrap-fd-"));
  const path = join(directory,"unwrap.bin");
  let handle;
  try {
    const expected = Buffer.alloc(32,0x6b);
    await writeFile(path,expected);
    handle = await open(path,"r");
    const source = new FileDescriptorUnwrapSecretSource(handle.fd);
    assert.equal(await source.availability(),"available");
    assert.deepEqual(await source.read(),new Uint8Array(expected));
    assert.equal(await source.availability(),"locked");
    await storeError(source.read(),"locked");
    await source.dispose();
    await storeError(source.availability(),"disposed");
  } finally {
    await handle?.close();
    await rm(directory,{ recursive: true,force: true });
  }
});

test("macOS Keychain adapter performs metadata probe then boot unlock without command-line key material", async () => {
  const keys = generateKeyPairSync("ed25519");
  const pkcs8 = (keys.privateKey.export({ format: "der",type: "pkcs8" }) as Buffer).toString("base64");
  const runner = new FixedRunner((request) => result(0,request.args.includes("-w") ? pkcs8 : "metadata only"));
  const ref = reference("macos_keychain","native");
  const store = new MacOsKeychainNodePrivateKeyStore(ref,clock(),{ service: "control-room.node",account: "node-marvin",runner });
  assert.equal((await store.availability()).state,"available");
  await store.unlock();
  const message = Buffer.from("mac keychain signer");
  assert.equal(verify(null,message,keys.publicKey,await store.sign(message)),true);
  assert.equal(runner.requests.length,2);
  assert.equal(runner.requests[0].args.includes("-w"),false);
  assert.equal(runner.requests[1].args.includes("-w"),true);
  assert.equal(JSON.stringify(runner.requests).includes(pkcs8),false);

  const missing = new MacOsKeychainNodePrivateKeyStore(ref,clock(),{ service: "control-room.node",account: "node-marvin",runner: new FixedRunner(result(44,"","-25300")) });
  assert.equal((await missing.availability()).state,"missing");
  await storeError(missing.unlock(),"missing");
  const interactive = new MacOsKeychainNodePrivateKeyStore(ref,clock(),{ service: "control-room.node",account: "node-marvin",runner: new FixedRunner(result(36,"","-25308")) });
  assert.equal((await interactive.availability()).state,"interaction_required");
});

test("Windows DPAPI adapter sends only ciphertext over stdin and signs after one boot unlock", async () => {
  const keys = generateKeyPairSync("ed25519");
  const pkcs8 = (keys.privateKey.export({ format: "der",type: "pkcs8" }) as Buffer).toString("base64");
  const blob = Buffer.from("constant-dpapi-ciphertext-vector");
  const entropy = Buffer.from("constant-nonsecret-entropy");
  const loader: OpaqueBlobLoaderV1 = { availability: async () => "available",load: async () => Uint8Array.from(blob) };
  const runner = new FixedRunner(result(0,pkcs8));
  const ref = reference("windows_dpapi_current_user","native");
  const store = new WindowsDpapiNodePrivateKeyStore(ref,clock(),loader,{ entropyLoader: async () => Uint8Array.from(entropy),runner });
  assert.equal((await store.availability()).state,"available");
  await store.unlock();
  const message = Buffer.from("windows dpapi signer");
  assert.equal(verify(null,message,keys.publicKey,await store.sign(message)),true);
  assert.equal(runner.requests.length,1);
  assert.equal(runner.requests[0].args.join(" ").includes(blob.toString("base64")),false);
  assert.equal(runner.requests[0].args.join(" ").includes(pkcs8),false);
  const sent = JSON.parse(Buffer.from(runner.requests[0].stdin ?? []).toString("utf8")) as { blob: string; entropy: string };
  assert.equal(sent.blob,blob.toString("base64"));
  assert.equal(sent.entropy,entropy.toString("base64"));

  const locked = new WindowsDpapiNodePrivateKeyStore(ref,clock(),loader,{ runner: new FixedRunner(result(41,"","CONTROL_ROOM_DPAPI_UNPROTECT_FAILED")) });
  await storeError(locked.unlock(),"locked");
});

test("real command runner is no-shell, output-bounded, and maps process failures safely", async () => {
  const runner = new NodeSafeCommandRunner();
  const completed = await runner.run({
    executable: process.execPath,
    args: ["-e","process.stdin.pipe(process.stdout)"],
    stdin: Buffer.from("constant-runner-vector"),
    timeoutMilliseconds: 5_000,
    maxOutputBytes: 256,
  });
  assert.equal(completed.exitCode,0);
  assert.equal(Buffer.from(completed.stdout).toString("utf8"),"constant-runner-vector");
  await storeError(runner.run({
    executable: process.execPath,
    args: ["-e","process.stdout.write('x'.repeat(300))"],
    timeoutMilliseconds: 5_000,
    maxOutputBytes: 256,
  }),"unavailable_platform");
  await storeError(runner.run({
    executable: join(tmpdir(),"control-room-missing-executable"),
    args: [],
    timeoutMilliseconds: 5_000,
    maxOutputBytes: 256,
  }),"unavailable_platform");
});

test("runtime factory enforces the actual platform, exact provider dependencies, and no automatic downgrade", async () => {
  assert.ok(["darwin","win32","linux"].includes(process.platform));
  const keys = generateKeyPairSync("ed25519");
  const ref = reference("encrypted_file","encrypted_file");
  const wrappingKey = Buffer.alloc(32,0x44);
  const envelope = sealEncryptedPrivateKey({ privateKey: keys.privateKey,reference: ref,wrappingKey,nonce: Buffer.alloc(12,0x77) });
  const dependency = {
    envelopeLoader: memoryEnvelopeLoader(envelope),
    unwrapSource: new InjectedUnwrapSecretSource("file_descriptor",async () => Uint8Array.from(wrappingKey)),
  };
  const store = createNodePrivateKeyStore({
    platform: process.platform as "darwin" | "win32" | "linux",
    provider: "encrypted_file",
    runtimeMode: "production",
    unwrapSecretSource: "file_descriptor",
    reference: ref,
  },{ clock: clock(),encryptedFile: dependency });
  await store.unlock();
  assert.equal(verify(null,Buffer.from("factory"),keys.publicKey,await store.sign(Buffer.from("factory"))),true);
  await store.dispose();

  const wrongPlatform = process.platform === "linux" ? "darwin" : "linux";
  assert.throws(() => createNodePrivateKeyStore({
    platform: wrongPlatform,provider: "encrypted_file",runtimeMode: "production",unwrapSecretSource: "file_descriptor",reference: ref,
  },{ clock: clock(),encryptedFile: dependency }),/unavailable/);
  assert.throws(() => createNodePrivateKeyStore({
    platform: process.platform as "darwin" | "win32" | "linux",provider: "encrypted_file",runtimeMode: "production",unwrapSecretSource: "platform_secret",reference: ref,
  },{ clock: clock(),encryptedFile: dependency }),/configuration/);
});
