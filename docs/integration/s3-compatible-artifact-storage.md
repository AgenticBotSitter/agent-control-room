# S3-compatible private artifact storage

This describes the provider-neutral object-storage adapter behind the existing
artifact-storage contract, and records what is and is not proven. It complements
[durable protected result storage](durable-result-storage.md), which owns the operator
configuration half of the same contract, and
[persistent artifact storage composition](persistent-artifact-storage.md), which covers how
an opened adapter is bound across the task services. Nothing here restates that wiring, and
no second task, queue or coordination store is introduced.

## One neutral class

`ARTIFACT_STORAGE_S3_COMPATIBLE_CLASS_V1` is `s3-compatible`. The class names the *shape* of
the store, never a provider brand: R2, MinIO, Ceph or any other compatible service is
selected by the captured deployment identity, not by a vendored client or a provider name in
an operator file. `storageClass: "r2"` stays refused by name (`artifact_storage_r2_unsupported`)
so an operator cannot advertise provider support this contract does not qualify — R2 is
reached through the neutral class.

## Operator configuration

`src/config/v1/artifact-storage.ts` is the single place where an untrusted object-storage
document becomes captured configuration. The object variant is a separate, strict schema
(`control-room.artifact-storage-settings/v1` with `storageClass: "s3-compatible"`), captured
by `captureS3CompatibleArtifactStorageConfigurationV1(settings, release)` and portable via
`exportS3CompatibleArtifactStorageSettingsV1`.

Its refusals, by named reason:

| Reason | Refused input |
| --- | --- |
| `artifact_storage_credential_material_refused` | any document carrying a password, access key, signed URL or token — checked before every other rule, so credential material is reported as credential material and not as an anonymous schema violation |
| `artifact_storage_local_configuration_required` | a local document handed to the object capture |
| `artifact_storage_object_configuration_required` | an object document handed to the local capture |
| `artifact_storage_r2_unsupported` | `storageClass: "r2"` |
| `artifact_storage_class_unsupported` | any class other than `s3-compatible` |
| `artifact_storage_endpoint_invalid` | an empty, oversized, whitespace- or NUL-bearing endpoint that is not a URL, or a URL without a hostname |
| `artifact_storage_endpoint_insecure` | any origin that is not `https:` |
| `artifact_storage_endpoint_credentials` | a URL carrying a username or password |
| `artifact_storage_endpoint_not_canonical` | a URL with a path, query, fragment, port or non-canonical spelling — the recorded endpoint and the dialled origin must not differ |
| `artifact_storage_endpoint_public` | an anonymous object host: an `r2.dev` bucket domain or an `s3-website` endpoint |
| `artifact_storage_bucket_invalid` | an empty bucket, an IP address, or a name that is not a DNS-style S3 bucket name |
| `artifact_storage_content_type_unsupported` | any media type other than the one bounded private result type |
| `artifact_storage_total_below_file` | a total smaller than one file |
| `artifact_storage_settings_invalid` | any unknown key, missing field or out-of-range bound |

Three properties are deliberate.

**The contract has no credential field at all.** Authentication belongs to the injected
client, so a key cannot be carried, captured or exported even by accident: the settings
document has nowhere to put one, and a document that tries is refused as credential
material.

**"Private store" is enforced at the deployment boundary.** A publicly readable object host,
a non-TLS origin and embedded credentials are each refused by name, because each one means
the store is not a Control Room private artifact store.

**The namespace digest is always derived.** `objectArtifactStorageNamespaceDigestV1(storageNamespace, endpoint, region, bucket)`
binds the public namespace to the exact deployment without returning or publishing the
deployment. A caller cannot supply a digest — it is an unknown key and is refused — so a
forged or stale digest cannot bind a namespace to a different store. The portable export
carries the namespace, its digest and the bounds, and deliberately omits the endpoint,
region and bucket, which are deployment data rather than public product content.

## The adapter

`src/artifacts/v1/s3-compatible-storage.ts` implements `ArtifactStoragePortV1` and
`ArtifactReadPortV1`. `openS3CompatibleArtifactStorageV1({ client, configuration, scope })`
binds one store instance to one exact project/task/run identity.

Every store call goes through the injected `S3CompatibleClientPortV1`: the adapter performs
no network work of its own. The port is `putObject` / `headObject` / `getObject` /
`listObjects`, and the client must report the two failures that matter as values rather than
guesses — `object_exists` (the create-once precondition rejected the write) and
`unavailable` (the outcome is unknown). Any other thrown value is treated as `unavailable`,
because an unrecognised failure cannot prove the state of the store.

Object keys derive from the captured deployment and the bound scope, never from a caller; a
caller receives an `opaqueLocator` derived from the deployment identity rather than the key
it maps to, so a caller cannot redirect a later read to another store. Results are
digest-verified on read: bytes that no longer match the recorded metadata fail safely and
leave that metadata standing. Duplicate writes replay one object under one locator instead
of writing again, an existing object with different content is a conflict that is never
overwritten, and a lost write reply fails closed, poisons that instance and reconciles on
restart. Oversized, malformed and credential-bearing results are refused before any store
call, the capacity bounds refuse the next artifact without touching the store, and a listing
that names a foreign, repeated or oversized key is refused as ambiguous.

What the adapter deliberately does not have:

- no credential field and no credential handling;
- no bucket, endpoint, key or resolvable URL in any result it returns;
- no task, lock, lease, approval or completion authority of any kind. The objects written
  here are result bytes and nothing else; nothing in this module reads or writes coordination
  state, and no coordination decision may be derived from a stored object or from a listing.

The backup inventory keeps its own boundary. `artifactBackupInventorySchemaV1` pins
`storageClass` to the literal `local` and admits no store field, so an object deployment can
never be recorded as backup or restore authority by re-labelling an inventory or by
substituting an object deployment's namespace digest.

## Evidence

`pnpm test:results` covers the round trip, key derivation, replay, conflict, lost-reply
poisoning and restart reconciliation, ambiguity refusals, capacity, deadline, cancellation
and the ownership boundary; `pnpm test:backup-recovery` covers the inventory authority
refusal; `pnpm check:demo` type-checks the whole tree; and
`node scripts/check-test-lane-coverage.mjs` proves every added test file is reachable from a
GitHub Actions lane.

Every case uses a disposable fake client. There is **no real bucket, credential, network
call, upload, deletion or production effect** anywhere in this work, so the evidence is
**source-tested with disposable data only**. It is not a live object-store claim, not a
provider qualification (R2, MinIO or Ceph behavior is not exercised), and not a physical
restart or backup claim.