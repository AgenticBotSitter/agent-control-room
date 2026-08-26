import { createHash } from "node:crypto";

export interface ArtifactStorageWriteV1 {
  artifactId: string;
  bytes: Uint8Array;
}

export interface StoredArtifactV1 {
  artifactId: string;
  opaqueLocator: string;
  contentHash: string;
  sizeBytes: number;
}

export interface ArtifactStoragePortV1 {
  put(input: ArtifactStorageWriteV1): Promise<StoredArtifactV1>;
}

export class ArtifactStorageError extends Error {
  readonly safeFailureCode: "storage_conflict" | "storage_capacity" | "storage_invalid";

  constructor(safeFailureCode: ArtifactStorageError["safeFailureCode"]) {
    super(safeFailureCode);
    this.name = "ArtifactStorageError";
    this.safeFailureCode = safeFailureCode;
  }
}

function contentHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function validateArtifactId(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    /\s/u.test(value) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ArtifactStorageError("storage_invalid");
  }
}

export class InMemoryArtifactStorage implements ArtifactStoragePortV1 {
  private readonly artifacts = new Map<string, Uint8Array>();
  private totalBytes = 0;

  constructor(
    private readonly maximumArtifacts = 100,
    private readonly maximumTotalBytes = 6_553_600,
  ) {
    if (!Number.isSafeInteger(maximumArtifacts) || maximumArtifacts < 1) {
      throw new ArtifactStorageError("storage_invalid");
    }
    if (!Number.isSafeInteger(maximumTotalBytes) || maximumTotalBytes < 1) {
      throw new ArtifactStorageError("storage_invalid");
    }
  }

  async put(input: ArtifactStorageWriteV1): Promise<StoredArtifactV1> {
    validateArtifactId(input.artifactId);
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > 65_536) {
      throw new ArtifactStorageError("storage_invalid");
    }

    const bytes = Uint8Array.from(input.bytes);
    const prior = this.artifacts.get(input.artifactId);
    if (prior) {
      if (contentHash(prior) !== contentHash(bytes) || prior.byteLength !== bytes.byteLength) {
        throw new ArtifactStorageError("storage_conflict");
      }
      return this.describe(input.artifactId, prior);
    }

    if (this.artifacts.size >= this.maximumArtifacts || this.totalBytes + bytes.byteLength > this.maximumTotalBytes) {
      throw new ArtifactStorageError("storage_capacity");
    }
    this.artifacts.set(input.artifactId, bytes);
    this.totalBytes += bytes.byteLength;
    return this.describe(input.artifactId, bytes);
  }

  get(artifactId: string): Uint8Array | undefined {
    const bytes = this.artifacts.get(artifactId);
    return bytes ? Uint8Array.from(bytes) : undefined;
  }

  count(): number {
    return this.artifacts.size;
  }

  sizeBytes(): number {
    return this.totalBytes;
  }

  private describe(artifactId: string, bytes: Uint8Array): StoredArtifactV1 {
    return {
      artifactId,
      opaqueLocator: `memory://artifact/${encodeURIComponent(artifactId)}`,
      contentHash: contentHash(bytes),
      sizeBytes: bytes.byteLength,
    };
  }
}
