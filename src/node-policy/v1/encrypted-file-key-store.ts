import { createCipheriv, createDecipheriv, randomBytes, type KeyObject } from "node:crypto";
import { read as readDescriptor } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { promisify } from "node:util";
import { sha256Digest } from "../../security";
import { z } from "zod";
import type { Clock } from "./clock";
import { MemoryBackedNodePrivateKeyStore } from "./private-key-runtime";
import { keyReferenceSchema } from "./schemas";
import { ProtectedStoreError } from "./stores";
import type { KeyAvailabilityState, KeyReferenceV1, UnwrapSecretSourceKind } from "./types";

export interface EncryptedPrivateKeyEnvelopeV1 {
  schema: "control-room.encrypted-private-key/v1";
  keyId: string;
  keyReferenceId: string;
  algorithm: "Ed25519";
  cipher: "aes-256-gcm";
  nonce: string;
  ciphertext: string;
  authenticationTag: string;
}

export interface UnwrapSecretSource {
  readonly kind: UnwrapSecretSourceKind;
  availability(): Promise<KeyAvailabilityState>;
  read(): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

export interface EncryptedEnvelopeLoader {
  availability(): Promise<KeyAvailabilityState>;
  load(): Promise<unknown>;
}

const envelopeSchema = z.object({
  schema: z.literal("control-room.encrypted-private-key/v1"),
  keyId: z.string().min(3).max(180),
  keyReferenceId: z.string().min(3).max(180),
  algorithm: z.literal("Ed25519"),
  cipher: z.literal("aes-256-gcm"),
  nonce: z.base64url(),
  ciphertext: z.base64url(),
  authenticationTag: z.base64url(),
}).strict();

function aad(reference: Pick<KeyReferenceV1,"keyId" | "referenceId" | "algorithm">): Buffer {
  return Buffer.from(sha256Digest({
    schema: "control-room.encrypted-private-key-aad/v1",
    keyId: reference.keyId,
    keyReferenceId: reference.referenceId,
    algorithm: reference.algorithm,
    cipher: "aes-256-gcm",
  }),"utf8");
}

function requireWrappingKey(value: Uint8Array): Buffer {
  if (value.byteLength !== 32) throw new ProtectedStoreError("invalid_configuration");
  return Buffer.from(value);
}

export function sealEncryptedPrivateKey(input: {
  privateKey: KeyObject;
  reference: KeyReferenceV1;
  wrappingKey: Uint8Array;
  nonce?: Uint8Array;
}): EncryptedPrivateKeyEnvelopeV1 {
  const parsedReference = keyReferenceSchema.safeParse(input.reference);
  if (!parsedReference.success || input.reference.provider !== "encrypted_file" || input.reference.mode !== "encrypted_file"
    || input.privateKey.type !== "private" || input.privateKey.asymmetricKeyType !== "ed25519") {
    throw new ProtectedStoreError("invalid_configuration");
  }
  const nonce = Buffer.from(input.nonce ?? randomBytes(12));
  if (nonce.byteLength !== 12) throw new ProtectedStoreError("invalid_configuration");
  const wrappingKey = requireWrappingKey(input.wrappingKey);
  let plaintext: Buffer | undefined;
  try {
    plaintext = input.privateKey.export({ format: "der",type: "pkcs8" }) as Buffer;
    const cipher = createCipheriv("aes-256-gcm",wrappingKey,nonce);
    cipher.setAAD(aad(input.reference));
    const ciphertext = Buffer.concat([cipher.update(plaintext),cipher.final()]);
    return {
      schema: "control-room.encrypted-private-key/v1",
      keyId: input.reference.keyId,
      keyReferenceId: input.reference.referenceId,
      algorithm: "Ed25519",
      cipher: "aes-256-gcm",
      nonce: nonce.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      authenticationTag: cipher.getAuthTag().toString("base64url"),
    };
  } finally {
    wrappingKey.fill(0);
    plaintext?.fill(0);
  }
}

export class EncryptedFileNodePrivateKeyStore extends MemoryBackedNodePrivateKeyStore {
  constructor(
    reference: KeyReferenceV1,
    clock: Clock,
    private readonly envelopeLoader: EncryptedEnvelopeLoader,
    private readonly unwrapSource: UnwrapSecretSource,
  ) {
    super(reference,clock);
    if (reference.provider !== "encrypted_file" || reference.mode !== "encrypted_file") throw new ProtectedStoreError("invalid_configuration");
  }

  protected async probeAvailability(): Promise<KeyAvailabilityState> {
    const envelope = await this.envelopeLoader.availability();
    if (envelope !== "available") return envelope;
    return this.unwrapSource.availability();
  }

  protected async loadPkcs8(): Promise<Uint8Array> {
    const parsed = envelopeSchema.safeParse(await this.envelopeLoader.load());
    if (!parsed.success) throw new ProtectedStoreError("corrupt");
    const envelope = parsed.data;
    if (envelope.keyId !== this.keyReference.keyId || envelope.keyReferenceId !== this.keyReference.referenceId) {
      throw new ProtectedStoreError("corrupt");
    }
    let sourceBytes: Uint8Array | undefined;
    let wrappingKey: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      sourceBytes = await this.unwrapSource.read();
      wrappingKey = requireWrappingKey(sourceBytes);
      const nonce = Buffer.from(envelope.nonce,"base64url");
      const authenticationTag = Buffer.from(envelope.authenticationTag,"base64url");
      if (nonce.byteLength !== 12 || authenticationTag.byteLength !== 16) throw new ProtectedStoreError("corrupt");
      const decipher = createDecipheriv("aes-256-gcm",wrappingKey,nonce);
      decipher.setAAD(aad(this.keyReference));
      decipher.setAuthTag(authenticationTag);
      plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,"base64url")),decipher.final()]);
      return Uint8Array.from(plaintext);
    } catch (error) {
      if (error instanceof ProtectedStoreError) throw error;
      throw new ProtectedStoreError("corrupt");
    } finally {
      sourceBytes?.fill(0);
      wrappingKey?.fill(0);
      plaintext?.fill(0);
    }
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    await this.unwrapSource.dispose();
  }
}

async function safeOpen(path: string, platform: NodeJS.Platform): Promise<{ handle: FileHandle; size: number }> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ProtectedStoreError("missing");
    if ((error as NodeJS.ErrnoException).code === "EACCES") throw new ProtectedStoreError("permission_denied");
    throw new ProtectedStoreError("unavailable_platform");
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new ProtectedStoreError("permission_denied");
  if (platform !== "win32") {
    if ((before.mode & 0o077) !== 0 || typeof process.getuid !== "function" || before.uid !== process.getuid()) {
      throw new ProtectedStoreError("permission_denied");
    }
  } else {
    throw new ProtectedStoreError("unavailable_platform");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await open(path,"r");
    const after = await handle.stat();
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || (after.mode & 0o077) !== 0 || typeof process.getuid !== "function" || after.uid !== process.getuid()) {
      throw new ProtectedStoreError("permission_denied");
    }
    return { handle,size: after.size };
  } catch (error) {
    await handle?.close();
    if (error instanceof ProtectedStoreError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EACCES") throw new ProtectedStoreError("permission_denied");
    throw new ProtectedStoreError("unavailable_platform");
  }
}

export class ProtectedJsonEnvelopeFile implements EncryptedEnvelopeLoader {
  constructor(private readonly path: string, private readonly platform: NodeJS.Platform = process.platform) {}

  async availability(): Promise<KeyAvailabilityState> {
    let opened: { handle: FileHandle; size: number } | undefined;
    try {
      opened = await safeOpen(this.path,this.platform);
      if (opened.size < 64 || opened.size > 32_768) return "corrupt";
      return "available";
    } catch (error) {
      if (error instanceof ProtectedStoreError && ["missing","permission_denied","unavailable_platform"].includes(error.code)) return error.code as KeyAvailabilityState;
      return "unavailable_platform";
    } finally {
      await opened?.handle.close();
    }
  }

  async load(): Promise<unknown> {
    const opened = await safeOpen(this.path,this.platform);
    try {
      if (opened.size < 64 || opened.size > 32_768) throw new ProtectedStoreError("corrupt");
      return JSON.parse(await opened.handle.readFile({ encoding: "utf8" })) as unknown;
    } catch (error) {
      if (error instanceof ProtectedStoreError) throw error;
      throw new ProtectedStoreError("corrupt");
    } finally {
      await opened.handle.close();
    }
  }
}

export class ProtectedFileUnwrapSecretSource implements UnwrapSecretSource {
  readonly kind = "protected_file" as const;
  private disposed = false;

  constructor(private readonly path: string, private readonly platform: NodeJS.Platform = process.platform) {}

  async availability(): Promise<KeyAvailabilityState> {
    if (this.disposed) throw new ProtectedStoreError("disposed");
    let opened: { handle: FileHandle; size: number } | undefined;
    try {
      opened = await safeOpen(this.path,this.platform);
      return opened.size === 32 ? "available" : "corrupt";
    } catch (error) {
      if (error instanceof ProtectedStoreError && ["missing","permission_denied","unavailable_platform"].includes(error.code)) return error.code as KeyAvailabilityState;
      return "unavailable_platform";
    } finally {
      await opened?.handle.close();
    }
  }

  async read(): Promise<Uint8Array> {
    if (this.disposed) throw new ProtectedStoreError("disposed");
    const opened = await safeOpen(this.path,this.platform);
    try {
      if (opened.size !== 32) throw new ProtectedStoreError("corrupt");
      return new Uint8Array(await opened.handle.readFile());
    } finally {
      await opened.handle.close();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

export class InjectedUnwrapSecretSource implements UnwrapSecretSource {
  private disposed = false;

  constructor(
    readonly kind: "file_descriptor" | "platform_secret",
    private readonly reader: () => Promise<Uint8Array>,
    private readonly availabilityReader: () => Promise<KeyAvailabilityState> = async () => "available",
  ) {}

  async availability(): Promise<KeyAvailabilityState> {
    if (this.disposed) throw new ProtectedStoreError("disposed");
    return this.availabilityReader();
  }

  async read(): Promise<Uint8Array> {
    if (this.disposed) throw new ProtectedStoreError("disposed");
    const value = await this.reader();
    if (value.byteLength !== 32) {
      value.fill(0);
      throw new ProtectedStoreError("invalid_configuration");
    }
    return value;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

const readDescriptorAsync = promisify(readDescriptor);

export class FileDescriptorUnwrapSecretSource implements UnwrapSecretSource {
  readonly kind = "file_descriptor" as const;
  private consumed = false;
  private disposed = false;

  constructor(private readonly descriptor: number) {
    if (!Number.isSafeInteger(descriptor) || descriptor < 3) throw new ProtectedStoreError("invalid_configuration");
  }

  async availability(): Promise<KeyAvailabilityState> {
    if (this.disposed) throw new ProtectedStoreError("disposed");
    return this.consumed ? "locked" : "available";
  }

  async read(): Promise<Uint8Array> {
    if (this.disposed) throw new ProtectedStoreError("disposed");
    if (this.consumed) throw new ProtectedStoreError("locked");
    this.consumed = true;
    const buffer = Buffer.alloc(33);
    try {
      const { bytesRead } = await readDescriptorAsync(this.descriptor,buffer,0,buffer.byteLength,null);
      if (bytesRead !== 32) throw new ProtectedStoreError("invalid_configuration");
      return Uint8Array.from(buffer.subarray(0,32));
    } catch (error) {
      if (error instanceof ProtectedStoreError) throw error;
      throw new ProtectedStoreError("unavailable_platform");
    } finally {
      buffer.fill(0);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}
