import { createHash } from "node:crypto";
import {
  ARTIFACT_STORAGE_RESULT_CONTENT_TYPE_V1,
  ARTIFACT_STORAGE_S3_COMPATIBLE_CLASS_V1,
  captureS3CompatibleBucketV1,
  captureS3CompatibleEndpointV1,
  objectArtifactStorageNamespaceDigestV1,
} from "../../config/v1/artifact-storage";
import {
  ArtifactStorageError,
  type ArtifactReadPortV1,
  type ArtifactStoragePortV1,
  type ArtifactStorageWriteV1,
  type StoredArtifactV1,
} from "../../node-executor/artifact-storage";
import { sha256Digest } from "../../security/canonical-digest";
import { checkedResultBytes, resultBytesHash } from "./native-results";

/**
 * Provider-neutral, S3-compatible private artifact storage.
 *
 * This adapter stores native-result bytes in one explicitly supplied object
 * store. It is the object-storage sibling of `PersistentLocalArtifactStorageV1`
 * and keeps the same shape: a create-once write, a digest-verified read, a
 * one-instance operation queue, and a fail-closed poison flag once an outcome
 * is unknown. It performs no network work of its own — every store call goes
 * through an injected client port, so the same adapter serves R2, MinIO, Ceph
 * or any other S3-compatible service without knowing which one it is.
 *
 * What the adapter deliberately does not have:
 *
 * - no credential field and no credential handling: the injected client owns
 *   authentication, and this contract cannot carry a key even by accident;
 * - no bucket or endpoint in any result: the caller receives an opaque locator
 *   derived from the deployment identity, never a resolvable URL, path or key,
 *   so a caller cannot redirect a later read to another store;
 * - no task, lock, lease, approval or completion authority of any kind. The
 *   objects written here are result bytes and nothing else; nothing in this
 *   module reads or writes coordination state, and no coordination decision may
 *   be derived from a stored object or from a listing.
 *
 * Identity binding. Object keys are derived, never supplied:
 * `<root>/<namespace>/<scope>/<artifactId>` where the namespace segment hashes
 * the captured deployment identity (endpoint, region, bucket, namespace), the
 * scope segment hashes the exact tenant/project/job/attempt/run identity, and
 * the last segment hashes the artifact id. `put`, `read` and `head` therefore
 * bind the exact project/task/run identity before any store call, and every
 * store reply is checked against the key, bucket, content type, digest and size
 * that were requested. A reply that describes another key (a wrong bucket, a
 * swapped object, a stale listing entry) is refused as ambiguous and poisons
 * the instance rather than being accepted as a read of the requested artifact.
 *
 * Uncertainty. A create-once write whose reply is lost cannot be retried
 * blindly: the object may or may not have landed. The write fails closed with
 * `storage_ambiguous`, the instance refuses further work, and reconciliation is
 * a *new* adapter (a restart) that reads the key back — a duplicate is then
 * either byte-identical (replay, same locator, exactly one object) or different
 * (conflict, never an overwrite).
 *
 * Scope of this module: the adapter and its client port contract only. It does
 * not open a client, discover a bucket, qualify a provider, or wire itself into
 * startup; provider qualification and wiring are separate work.
 */

/** One class covers every S3-compatible service; a provider brand is not a class. */
export const S3_COMPATIBLE_STORAGE_CLASS_V1 = ARTIFACT_STORAGE_S3_COMPATIBLE_CLASS_V1;

/** The one bounded private result media type an artifact store may hold. */
export const S3_COMPATIBLE_RESULT_CONTENT_TYPE_V1 = ARTIFACT_STORAGE_RESULT_CONTENT_TYPE_V1;

/** Key space owned by this adapter. Nothing outside it is ever listed or written. */
export const S3_COMPATIBLE_KEY_ROOT_V1 = "control-room-artifacts/v1" as const;

const artifactIdPattern = /^artifact:(native|result):[a-f0-9]{64}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/u;
const keySegmentPattern = /^[a-f0-9]{64}$/u;
const keySuffix = ".artifact";
const artifactLimitBytes = 65_536;
const maximumOperationTimeoutMs = 30_000;
const configurationKeys = "bucket,contentType,endpoint,maximumArtifacts,maximumFileBytes,maximumTotalBytes,operationTimeoutMs,region,storageNamespace";
const scopeKeys = "attemptId,jobId,projectId,runId,tenantId";

class DeadlineError extends Error {}

function abortError(): Error {
  const error = new Error("artifact_storage_aborted");
  error.name = "AbortError";
  return error;
}

function safeStorageError(error: unknown): ArtifactStorageError {
  return error instanceof ArtifactStorageError ? error : new ArtifactStorageError("storage_ambiguous");
}

/** The exact project/task/run identity a store instance is bound to. */
export interface S3CompatibleArtifactScopeV1 {
  readonly tenantId: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly runId: string;
}

/** One captured private deployment identity. Carries no credential of any kind. */
export interface S3CompatibleArtifactStorageConfigurationV1 {
  /** Private account API origin, already canonical; a public or non-TLS origin is refused. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly storageNamespace: string;
  readonly contentType: string;
  readonly maximumArtifacts: number;
  readonly maximumFileBytes: number;
  readonly maximumTotalBytes: number;
  readonly operationTimeoutMs: number;
}

/** What a store reports about one stored object. */
export interface S3CompatibleObjectMetadataV1 {
  readonly bucket: string;
  readonly key: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface S3CompatibleObjectReadV1 extends S3CompatibleObjectMetadataV1 {
  readonly body: Uint8Array;
}

export interface S3CompatibleObjectListingV1 {
  readonly key: string;
  readonly sizeBytes: number;
}

/**
 * The bounded failures a client must distinguish.
 *
 * - `object_exists`: the create-once precondition rejected the write because
 *   the key is already present. On S3 this is a conditional PUT answered with
 *   `412 PreconditionFailed`.
 * - `unavailable`: the outcome is unknown — a timeout, a reset connection, a
 *   lost reply, an unreadable response. A client that cannot prove the outcome
 *   must report this rather than guessing.
 *
 * Any other thrown value is treated as `unavailable`, because an unrecognised
 * failure cannot prove the state of the store.
 */
export type S3CompatibleClientFailureV1 = "object_exists" | "unavailable";

export class S3CompatibleClientErrorV1 extends Error {
  readonly failure: S3CompatibleClientFailureV1;

  constructor(failure: S3CompatibleClientFailureV1) {
    super(`s3_compatible_client_${failure}`);
    this.name = "S3CompatibleClientErrorV1";
    this.failure = failure;
  }
}

/**
 * The injected transport. It owns credentials, dials the endpoint and reports
 * what the store said; it makes no artifact decision. Every method must return
 * the metadata the store recorded for the exact key it was given, and must
 * report `object_exists` rather than overwrite.
 */
export interface S3CompatibleClientPortV1 {
  putObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
    readonly signal?: AbortSignal;
  }): Promise<S3CompatibleObjectMetadataV1>;
  headObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly signal?: AbortSignal;
  }): Promise<S3CompatibleObjectMetadataV1 | undefined>;
  getObject(input: {
    readonly bucket: string;
    readonly key: string;
    readonly signal?: AbortSignal;
  }): Promise<S3CompatibleObjectReadV1 | undefined>;
  listObjects(input: {
    readonly bucket: string;
    readonly prefix: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly S3CompatibleObjectListingV1[]>;
}

/**
 * A write plus the exact claim it is published under. The claim is optional
 * because the base storage port does not carry one, and every part of it is
 * *verified* against the bytes rather than trusted: a claim the bytes do not
 * support fails with `storage_conflict`, never with a quiet correction.
 */
export interface S3CompatibleArtifactWriteV1 extends ArtifactStorageWriteV1 {
  readonly contentHash?: string;
  readonly sizeBytes?: number;
  readonly contentType?: string;
  readonly scope?: S3CompatibleArtifactScopeV1;
}

/** Head metadata for one artifact. Contains no key, bucket, endpoint or URL. */
export interface S3CompatibleArtifactHeadV1 {
  readonly artifactId: string;
  readonly scopeDigest: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly opaqueLocator: string;
}

export interface S3CompatibleArtifactInventoryV1 {
  readonly count: number;
  readonly totalBytes: number;
}

interface OperationContext {
  readonly signal?: AbortSignal;
  readonly deadline: number;
  mutationStarted: boolean;
  uncertain: boolean;
}

interface SubmittedWrite {
  readonly artifactId: string;
  readonly bytes: Uint8Array;
  readonly contentHash: string;
  readonly signal?: AbortSignal;
}

function validateArtifactId(artifactId: unknown): string {
  if (typeof artifactId !== "string" || !artifactIdPattern.test(artifactId)) {
    throw new ArtifactStorageError("storage_invalid");
  }
  return artifactId;
}

function validateScope(scope: unknown): S3CompatibleArtifactScopeV1 {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new ArtifactStorageError("storage_invalid");
  if (Object.keys(scope).sort().join(",") !== scopeKeys) throw new ArtifactStorageError("storage_invalid");
  const candidate = scope as Partial<S3CompatibleArtifactScopeV1>;
  for (const field of ["tenantId", "projectId", "jobId", "attemptId", "runId"] as const) {
    const value = candidate[field];
    if (typeof value !== "string" || !identifierPattern.test(value)) throw new ArtifactStorageError("storage_invalid");
  }
  return Object.freeze({
    tenantId: candidate.tenantId as string,
    projectId: candidate.projectId as string,
    jobId: candidate.jobId as string,
    attemptId: candidate.attemptId as string,
    runId: candidate.runId as string,
  });
}

function scopeDigestOf(scope: S3CompatibleArtifactScopeV1): string {
  return sha256Digest({
    purpose: "s3-compatible-artifact-scope/v1",
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    jobId: scope.jobId,
    attemptId: scope.attemptId,
    runId: scope.runId,
  });
}

function validateConfiguration(input: unknown): Readonly<S3CompatibleArtifactStorageConfigurationV1> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ArtifactStorageError("storage_invalid");
  // Strict keys first: a configuration cannot smuggle a credential field such as
  // `secretAccessKey` under a contract that has no credential field at all.
  if (Object.keys(input).sort().join(",") !== configurationKeys) throw new ArtifactStorageError("storage_invalid");
  const candidate = input as Partial<S3CompatibleArtifactStorageConfigurationV1>;
  // The deployment policy itself is owned by the settings module, so a public
  // anonymous host, a non-TLS origin and an origin carrying credentials are
  // refused here by the same names an operator file is refused by.
  const endpoint = captureS3CompatibleEndpointV1(candidate.endpoint);
  const bucket = captureS3CompatibleBucketV1(candidate.bucket);
  if (typeof candidate.region !== "string" || !identifierPattern.test(candidate.region)
    || typeof candidate.storageNamespace !== "string" || !identifierPattern.test(candidate.storageNamespace)
    || candidate.contentType !== S3_COMPATIBLE_RESULT_CONTENT_TYPE_V1
    || !Number.isSafeInteger(candidate.maximumArtifacts) || (candidate.maximumArtifacts as number) < 1
    || !Number.isSafeInteger(candidate.maximumFileBytes) || (candidate.maximumFileBytes as number) < 1
    || (candidate.maximumFileBytes as number) > artifactLimitBytes
    || !Number.isSafeInteger(candidate.maximumTotalBytes) || (candidate.maximumTotalBytes as number) < 1
    || (candidate.maximumTotalBytes as number) < (candidate.maximumFileBytes as number)
    || !Number.isSafeInteger(candidate.operationTimeoutMs) || (candidate.operationTimeoutMs as number) < 0
    || (candidate.operationTimeoutMs as number) > maximumOperationTimeoutMs) {
    throw new ArtifactStorageError("storage_invalid");
  }
  return Object.freeze({
    endpoint,
    region: candidate.region,
    bucket,
    storageNamespace: candidate.storageNamespace,
    contentType: candidate.contentType,
    maximumArtifacts: candidate.maximumArtifacts as number,
    maximumFileBytes: candidate.maximumFileBytes as number,
    maximumTotalBytes: candidate.maximumTotalBytes as number,
    operationTimeoutMs: candidate.operationTimeoutMs as number,
  });
}

/**
 * Persistent, create-once native-result bytes in one injected S3-compatible
 * store. It does not open clients, create buckets, repair keys, or delete
 * unknown objects, and it never publishes a key, bucket or endpoint.
 */
export class S3CompatibleArtifactStorageV1 implements ArtifactStoragePortV1, ArtifactReadPortV1 {
  private queue: Promise<void> = Promise.resolve();
  private poisoned = false;

  private constructor(
    private readonly client: S3CompatibleClientPortV1,
    private readonly configuration: Readonly<S3CompatibleArtifactStorageConfigurationV1>,
    private readonly scope: S3CompatibleArtifactScopeV1,
    private readonly scopeDigest: string,
    private readonly keyPrefix: string,
    /** Public namespace identity of the store, derived from the deployment identity. */
    readonly namespaceDigest: string,
    /** Public identity of the bound project/task/run scope. */
    readonly boundScopeDigest: string,
  ) {}

  static open(input: {
    readonly client: S3CompatibleClientPortV1;
    readonly configuration: S3CompatibleArtifactStorageConfigurationV1;
    readonly scope: S3CompatibleArtifactScopeV1;
  }): S3CompatibleArtifactStorageV1 {
    if (!input || typeof input !== "object") throw new ArtifactStorageError("storage_invalid");
    const configuration = validateConfiguration(input.configuration);
    const scope = validateScope(input.scope);
    const client = input.client;
    if (!client || typeof client !== "object"
      || typeof client.putObject !== "function" || typeof client.headObject !== "function"
      || typeof client.getObject !== "function" || typeof client.listObjects !== "function") {
      throw new ArtifactStorageError("storage_invalid");
    }
    const scopeDigest = scopeDigestOf(scope);
    const namespaceDigest = objectArtifactStorageNamespaceDigestV1(
      configuration.storageNamespace, configuration.endpoint, configuration.region, configuration.bucket,
    );
    const keyPrefix = `${S3_COMPATIBLE_KEY_ROOT_V1}/${namespaceDigest.slice("sha256:".length)}/${scopeDigest.slice("sha256:".length)}`;
    return new S3CompatibleArtifactStorageV1(
      client, configuration, scope, scopeDigest, keyPrefix, namespaceDigest, scopeDigest,
    );
  }

  async put(input: S3CompatibleArtifactWriteV1): Promise<StoredArtifactV1> {
    this.assertUsable();
    const submitted = this.prepareWrite(input);
    const queuedAt = Date.now();
    const result = this.queue.then(
      () => this.putExclusive(submitted, queuedAt),
      () => this.putExclusive(submitted, queuedAt),
    );
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async read(artifactId: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    this.assertUsable();
    signal?.throwIfAborted();
    const id = validateArtifactId(artifactId);
    const context = this.context(signal);
    try {
      const key = this.objectKey(id);
      const object = await this.getExclusive(key, context);
      if (!object) {
        this.checkpoint(context);
        return undefined;
      }
      if (object.body.byteLength !== object.metadata.sizeBytes
        || resultBytesHash(object.body) !== object.metadata.contentHash) {
        this.poisoned = true;
        throw new ArtifactStorageError("storage_ambiguous");
      }
      try {
        checkedResultBytes(object.body, {
          contentHash: object.metadata.contentHash,
          sizeBytes: object.metadata.sizeBytes,
        });
      } catch {
        this.poisoned = true;
        throw new ArtifactStorageError("storage_ambiguous");
      }
      this.checkpoint(context);
      return Uint8Array.from(object.body);
    } catch (error) {
      if (error instanceof DeadlineError) this.poisoned = true;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw safeStorageError(error);
    }
  }

  async head(artifactId: string, signal?: AbortSignal): Promise<S3CompatibleArtifactHeadV1 | undefined> {
    this.assertUsable();
    signal?.throwIfAborted();
    const id = validateArtifactId(artifactId);
    const context = this.context(signal);
    try {
      const metadata = await this.headExclusive(this.objectKey(id), context);
      if (!metadata) {
        this.checkpoint(context);
        return undefined;
      }
      this.checkpoint(context);
      return Object.freeze({
        artifactId: id,
        scopeDigest: this.scopeDigest,
        contentHash: metadata.contentHash,
        sizeBytes: metadata.sizeBytes,
        contentType: metadata.contentType,
        opaqueLocator: this.opaqueLocator(id),
      });
    } catch (error) {
      if (error instanceof DeadlineError) this.poisoned = true;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw safeStorageError(error);
    }
  }

  /** Bounded listing of this adapter's own key space only; never a store-wide scan. */
  async inventory(signal?: AbortSignal): Promise<S3CompatibleArtifactInventoryV1> {
    this.assertUsable();
    signal?.throwIfAborted();
    const context = this.context(signal);
    try {
      const inventory = await this.inventoryExclusive(context);
      this.checkpoint(context);
      return Object.freeze({ count: inventory.count, totalBytes: inventory.totalBytes });
    } catch (error) {
      if (error instanceof DeadlineError) this.poisoned = true;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw safeStorageError(error);
    }
  }

  private prepareWrite(input: S3CompatibleArtifactWriteV1): SubmittedWrite {
    const source = (input ?? {}) as Partial<S3CompatibleArtifactWriteV1>;
    const { bytes, signal } = source;
    signal?.throwIfAborted();
    const artifactId = validateArtifactId(source.artifactId);
    if (source.scope !== undefined && scopeDigestOf(validateScope(source.scope)) !== this.scopeDigest) {
      throw new ArtifactStorageError("storage_invalid");
    }
    if (source.contentType !== undefined && source.contentType !== this.configuration.contentType) {
      throw new ArtifactStorageError("storage_invalid");
    }
    if (source.contentHash !== undefined && (typeof source.contentHash !== "string" || !digestPattern.test(source.contentHash))) {
      throw new ArtifactStorageError("storage_invalid");
    }
    if (source.sizeBytes !== undefined && (!Number.isSafeInteger(source.sizeBytes) || (source.sizeBytes as number) < 0)) {
      throw new ArtifactStorageError("storage_invalid");
    }
    if (!(bytes instanceof Uint8Array)) throw new ArtifactStorageError("storage_invalid");
    const submitted = Uint8Array.from(bytes);
    if (submitted.byteLength > this.configuration.maximumFileBytes) throw new ArtifactStorageError("storage_capacity");
    const contentHash = resultBytesHash(submitted);
    // The bytes must be valid private result bytes on their own terms first; a
    // claim the bytes contradict is reported separately, as a conflict.
    try {
      checkedResultBytes(submitted, { contentHash, sizeBytes: submitted.byteLength });
    } catch {
      throw new ArtifactStorageError("storage_invalid");
    }
    if (source.contentHash !== undefined && source.contentHash !== contentHash) {
      throw new ArtifactStorageError("storage_conflict");
    }
    if (source.sizeBytes !== undefined && source.sizeBytes !== submitted.byteLength) {
      throw new ArtifactStorageError("storage_conflict");
    }
    return { artifactId, bytes: submitted, contentHash, signal };
  }

  private async putExclusive(input: SubmittedWrite, queuedAt: number): Promise<StoredArtifactV1> {
    this.assertUsable();
    const context = this.context(input.signal, queuedAt);
    this.checkpoint(context);
    const key = this.objectKey(input.artifactId);
    const locator = this.opaqueLocator(input.artifactId);
    let result: StoredArtifactV1 | undefined;
    let operationError: unknown;
    try {
      const settled = await this.headExclusive(key, context);
      if (settled) {
        result = this.replay(settled, input, locator);
      } else {
        const inventory = await this.inventoryExclusive(context);
        if (inventory.count >= this.configuration.maximumArtifacts
          || inventory.totalBytes + input.bytes.byteLength > this.configuration.maximumTotalBytes) {
          throw new ArtifactStorageError("storage_capacity");
        }
        // Past this point a write may have reached the store: an unknown
        // outcome poisons the instance instead of being retried.
        context.mutationStarted = true;
        result = await this.writeOnce(key, input, locator, context);
        if (!result) {
          // A concurrent writer created the key between head and put. The store
          // state is definite again: replay the winner or refuse the conflict.
          const reread = await this.headExclusive(key, context);
          if (!reread) {
            this.poisoned = true;
            throw new ArtifactStorageError("storage_ambiguous");
          }
          result = this.replay(reread, input, locator);
        }
      }
    } catch (error) {
      operationError = error;
      const definiteLogicalRefusal = error instanceof ArtifactStorageError
        && (error.safeFailureCode === "storage_conflict" || error.safeFailureCode === "storage_capacity");
      if (context.mutationStarted && !definiteLogicalRefusal) {
        context.uncertain = true;
        this.poisoned = true;
      }
    }
    if (context.uncertain) {
      this.poisoned = true;
      if (result) return result;
      throw new ArtifactStorageError("storage_ambiguous");
    }
    if (operationError) {
      if (operationError instanceof Error && operationError.name === "AbortError") throw operationError;
      throw safeStorageError(operationError);
    }
    if (!result) throw new ArtifactStorageError("storage_ambiguous");
    return result;
  }

  /**
   * One create-once write. `undefined` means the key already existed, which is
   * a definite outcome the caller settles by reading the winner back.
   */
  private async writeOnce(
    key: string,
    input: SubmittedWrite,
    locator: string,
    context: OperationContext,
  ): Promise<StoredArtifactV1 | undefined> {
    let metadata: S3CompatibleObjectMetadataV1;
    try {
      metadata = await this.io(
        (signal) => this.client.putObject({
          bucket: this.configuration.bucket,
          key,
          body: input.bytes,
          contentType: this.configuration.contentType,
          signal,
        }),
        context,
      );
    } catch (error) {
      if (error instanceof S3CompatibleClientErrorV1 && error.failure === "object_exists") return undefined;
      throw error;
    }
    this.verifyMetadata(metadata, key);
    if (metadata.contentHash !== input.contentHash || metadata.sizeBytes !== input.bytes.byteLength) {
      // The store acknowledged a write whose recorded bytes are not the bytes
      // that were sent. No further assumption about it is safe.
      this.poisoned = true;
      throw new ArtifactStorageError("storage_ambiguous");
    }
    return {
      artifactId: input.artifactId,
      opaqueLocator: locator,
      contentHash: metadata.contentHash,
      sizeBytes: metadata.sizeBytes,
    };
  }

  /**
   * Accepts an existing object only when it is byte-identical to the submitted
   * bytes: a replay returns the same locator with exactly one object stored, and
   * differing content is a conflict that is never resolved by an overwrite.
   */
  private replay(
    metadata: S3CompatibleObjectMetadataV1,
    input: SubmittedWrite,
    locator: string,
  ): StoredArtifactV1 {
    if (metadata.contentHash !== input.contentHash || metadata.sizeBytes !== input.bytes.byteLength) {
      throw new ArtifactStorageError("storage_conflict");
    }
    return {
      artifactId: input.artifactId,
      opaqueLocator: locator,
      contentHash: metadata.contentHash,
      sizeBytes: metadata.sizeBytes,
    };
  }

  private async headExclusive(key: string, context: OperationContext): Promise<S3CompatibleObjectMetadataV1 | undefined> {
    const metadata = await this.io(
      (signal) => this.client.headObject({ bucket: this.configuration.bucket, key, signal }),
      context,
    );
    if (metadata === undefined) return undefined;
    this.verifyMetadata(metadata, key);
    return metadata;
  }

  private async getExclusive(
    key: string,
    context: OperationContext,
  ): Promise<{ metadata: S3CompatibleObjectMetadataV1; body: Uint8Array } | undefined> {
    const object = await this.io(
      (signal) => this.client.getObject({ bucket: this.configuration.bucket, key, signal }),
      context,
    );
    if (object === undefined) return undefined;
    this.verifyMetadata(object, key);
    if (!(object.body instanceof Uint8Array)) {
      this.poisoned = true;
      throw new ArtifactStorageError("storage_ambiguous");
    }
    return { metadata: object, body: object.body };
  }

  private async inventoryExclusive(context: OperationContext): Promise<{ count: number; totalBytes: number }> {
    const listed = await this.io(
      (signal) => this.client.listObjects({ bucket: this.configuration.bucket, prefix: this.keyPrefix, signal }),
      context,
    );
    if (!Array.isArray(listed)) {
      this.poisoned = true;
      throw new ArtifactStorageError("storage_ambiguous");
    }
    const seen = new Set<string>();
    let count = 0;
    let totalBytes = 0;
    for (const entry of listed) {
      if (!entry || typeof entry !== "object"
        || typeof entry.key !== "string" || !this.ownsKey(entry.key) || seen.has(entry.key)
        || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0
        || entry.sizeBytes > this.configuration.maximumFileBytes) {
        // A listing that names a key outside this adapter's own key space, or
        // repeats one, is not evidence about this store's contents.
        this.poisoned = true;
        throw new ArtifactStorageError("storage_ambiguous");
      }
      seen.add(entry.key);
      count += 1;
      totalBytes += entry.sizeBytes;
    }
    return { count, totalBytes };
  }

  /** Every reply must describe the exact key, bucket, type, digest and size requested. */
  private verifyMetadata(metadata: S3CompatibleObjectMetadataV1, key: string): void {
    if (!metadata || typeof metadata !== "object"
      || metadata.bucket !== this.configuration.bucket
      || metadata.key !== key
      || typeof metadata.contentHash !== "string" || !digestPattern.test(metadata.contentHash)
      || !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 0
      || metadata.sizeBytes > this.configuration.maximumFileBytes
      || metadata.contentType !== this.configuration.contentType) {
      this.poisoned = true;
      throw new ArtifactStorageError("storage_ambiguous");
    }
  }

  private objectKey(artifactId: string): string {
    return `${this.keyPrefix}/${createHash("sha256").update(artifactId).digest("hex")}${keySuffix}`;
  }

  private ownsKey(key: string): boolean {
    const prefix = `${this.keyPrefix}/`;
    if (!key.startsWith(prefix) || !key.endsWith(keySuffix)) return false;
    const name = key.slice(prefix.length, key.length - keySuffix.length);
    return keySegmentPattern.test(name);
  }

  private opaqueLocator(artifactId: string): string {
    return `control-room-artifact:s3:v1:${sha256Digest({
      purpose: "s3-compatible-artifact-locator/v1",
      namespaceDigest: this.namespaceDigest,
      scopeDigest: this.scopeDigest,
      artifactId,
    }).slice("sha256:".length)}`;
  }

  private context(signal?: AbortSignal, began = Date.now()): OperationContext {
    return { signal, deadline: began + this.configuration.operationTimeoutMs, mutationStarted: false, uncertain: false };
  }

  private checkpoint(context: OperationContext): void {
    if (context.signal?.aborted) {
      if (context.mutationStarted) {
        context.uncertain = true;
        this.poisoned = true;
      }
      throw abortError();
    }
    if (Date.now() >= context.deadline) {
      context.uncertain = true;
      this.poisoned = true;
      throw new DeadlineError();
    }
    if (this.poisoned) throw new ArtifactStorageError("storage_ambiguous");
  }

  /**
   * One bounded store call. The caller's deadline aborts the attempt, and a
   * call whose outcome cannot be observed before the deadline fails closed.
   */
  private async io<T>(begin: (signal: AbortSignal) => Promise<T>, context: OperationContext): Promise<T> {
    this.checkpoint(context);
    const controller = new AbortController();
    const external = context.signal;
    const forward = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", forward, { once: true });
    }
    const operation = begin(controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        context.uncertain = true;
        this.poisoned = true;
        controller.abort();
        reject(new DeadlineError());
      }, Math.max(0, context.deadline - Date.now()));
      if (external) {
        onAbort = () => {
          if (context.mutationStarted) {
            context.uncertain = true;
            this.poisoned = true;
          }
          reject(abortError());
        };
        external.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([operation, stopped]);
    } catch (error) {
      if (context.mutationStarted
        && (error instanceof DeadlineError || error instanceof Error && error.name === "AbortError")) {
        context.uncertain = true;
        this.poisoned = true;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (external && onAbort) external.removeEventListener("abort", onAbort);
      void operation.catch(() => {});
    }
  }

  private assertUsable(): void {
    if (this.poisoned) throw new ArtifactStorageError("storage_ambiguous");
  }
}

/** Binds one adapter to one injected client, one captured deployment and one exact scope. */
export function openS3CompatibleArtifactStorageV1(input: {
  readonly client: S3CompatibleClientPortV1;
  readonly configuration: S3CompatibleArtifactStorageConfigurationV1;
  readonly scope: S3CompatibleArtifactScopeV1;
}): S3CompatibleArtifactStorageV1 {
  return S3CompatibleArtifactStorageV1.open(input);
}