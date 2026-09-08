# RC5 OpenBao checkpoint identity mapping constraint

2026-09-08. Root source inspection at OpenBao2.6.2 revision
`dd9c19c37a878cf4a81b18efb8d6f0599c7da923`; no new service or adapter execution.

## Finding that changes the adapter plan

Do **not** translate the data-read response's `metadata.created_time` into etcd's
stable key creation revision. OpenBao returns the selected **version's** creation
time there, and a normal successful update creates another version timestamp.
That proposed translation would falsely classify legitimate updates as replacement.

Inspected actual implementation:

- [path_data.go](https://github.com/openbao/openbao/blob/dd9c19c37a878cf4a81b18efb8d6f0599c7da923/builtin/logical/kv/path_data.go)
  lines122–142 select the version and expose its VersionMetadata.CreatedTime.
  Lines330–335 allocate the new timestamp per write. AddVersion at680–695 increments
  CurrentVersion, retains per-version metadata and only initializes key CreatedTime
  when absent. These are distinct identities, not interchangeable field labels.
- [path_metadata.go](https://github.com/openbao/openbao/blob/dd9c19c37a878cf4a81b18efb8d6f0599c7da923/builtin/logical/kv/path_metadata.go)
  lines302–328 expose per-version timestamps plus the separate key CreatedTime and
  current metadata version. This is a different API path from the data read.
- Data CAS validates only against current data version (path_data.go208–217).
  The inspected ordinary data write does not additionally compare a caller's key
  creation timestamp or CR checkpoint digest. Metadata CAS is a separate update
  mechanism, not an extra atomic condition on this ordinary data write.

This is a source-based finding, not a reproduced delete/recreate race or a complete
audit of every API. It does not assert that a timestamp is a cryptographically
unforgeable identity, or that an administrator/snapshot restore cannot preserve it.

## Consequence for the actual existing CR interface

The etcd adapter binds trusted cluster ID and key create revision, then compares
create/mod revisions, exact value bytes and no lease in one transaction. OpenBao's
tested scoped data read/update plus numeric CAS supplies a different primitive.
Do not fabricate etcd-shaped responses and claim equivalent protection.

Reusable CR logic remains: checkpoint schema validation, exact scope, expected
digest, next revision and bounded uncertain-call handling. A Bao-specific adapter
must separately establish its approved object/instance binding and preserve it
across normal writes. Its current tested token permits only exact data-path read/
update; reading key metadata would require a deliberate narrow policy extension,
not silently broadening the token or assuming data metadata is equivalent.

An extra metadata read alone is not an atomic recreate defense: determine whether
the threat model permits another actor to recreate the head between read and CAS,
and whether a supported upstream primitive can bind the write appropriately. The
ordinary runtime token's tested inability to delete/recreate reduces its authority
but is not evidence of independent restore/rollback custody. No new custom protocol
or compensating security layer is selected by this report.

Next decisive common cases remain actual canonical payload advancement, callback
loss, missing/replaced head and supported restore through the approved binding.
Before implementing the adapter experiment, settle this mapping rather than writing
a nearly-etcd adapter that cannot provide its claimed identity checks. The outcome
may favor different binding semantics or retaining the tested etcd adapter; it is
not a final candidate rejection based only on source.

## Source acquisition and retained data

Official API documentation opened via the web reader returned no readable lines;
it supplied no substantive evidence. A first sandbox fetch failed DNS before source
retrieval. The authorized public read then fetched two immutable files into memory
with15-second request deadlines, executed neither and retained zero source bytes:

| File | Bytes | SHA256 |
| --- | ---: | --- |
| builtin/logical/kv/path_data.go |22605|f655936491ccb3cc939821e522d31910d2b3af6d0e556efbed5c483465363729|
| builtin/logical/kv/path_metadata.go |25320|ac52ed91b0862654b61378b4c22652d91f34700d611f01fee5a4fb18490f8f37|

Requests used the raw.githubusercontent.com/openbao/openbao exact revision/path
corresponding to the links above. No new directory, package, credentials, listener,
service, application change or GitHub write. No cleanup target was created.
