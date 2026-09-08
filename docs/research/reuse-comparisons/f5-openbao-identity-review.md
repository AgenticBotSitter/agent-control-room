# Independent OpenBao checkpoint identity mapping review

2026-09-08. Source-only review; no service, adapter, policy or custody change.
**No blocking finding in the narrowly stated mapping constraint.** Root retains
the custody decision; this is not a generic OpenBao rejection.

Reviewed root identity map, actual OpenBao service-fit evidence description, and
existing CR etcd checkpoint advance/access implementation. Re-read the two immutable
OpenBao files into memory with15-second deadlines, verifying the exact report hashes:

- path_data.go22,605bytes:
  f655936491ccb3cc939821e522d31910d2b3af6d0e556efbed5c483465363729
- path_metadata.go25,320bytes:
  ac52ed91b0862654b61378b4c22652d91f34700d611f01fee5a4fb18490f8f37

Both URLs use `https://raw.githubusercontent.com/openbao/openbao/` plus pin
dd9c19c37a878cf4a81b18efb8d6f0599c7da923 and `builtin/logical/kv/` plus filename.
No downloaded source retained or executed; no cleanup target or new disk footprint.

## Confirmed source semantics

Data read selects current or requested version and reads its VersionMetadata.
The returned metadata.created_time comes from that selected version (lines122–142).
Data writes create a new timestamp (330–335). AddVersion increments CurrentVersion,
stores that per-version timestamp and initializes key CreatedTime only when nil
(680–695). Root correctly distinguishes version creation from key creation.

The metadata API exposes both its per-version map and independent key CreatedTime
plus CurrentMetadataVersion (metadataResponseData302–328). Root does not overlook
that stronger *readable metadata*; it correctly notes the currently tested runtime
role lacks that path. Key timestamp continuity across ordinary writes alone is not
an unforgeable object/instance identity, and root explicitly avoids that claim.

validateCheckAndSetOption compares options.cas to meta.CurrentVersion (208–217).
The inspected data write invokes that validator, creates the next version and uses
backend transactional storage when available. That internal atomic transaction
protects the write's own consistency; it does not expose a caller-supplied compare
against key creation time, prior CR bytes/digest or metadata generation. No such
additional public atomic condition was found in these two files.

Metadata updates have a separate metadata_cas comparison against
CurrentMetadataVersion and own transactional path; metadata creation requires0 when
that condition is supplied. Those operations do not add a second condition to the
ordinary data write. Data patch also has its existing data-version CAS path, not an
etcd-style multi-predicate transaction API. This scoped inspection is not a search
of every OpenBao endpoint, plugin or possible approved architecture.

## CR comparison and actual service evidence

`prepareEtcdCheckpointAdvance` validates CR checkpoint scope/next revision/digest,
then sends one transaction comparing creation revision, modification revision,
exact value and zero lease. Access binds expected cluster/key creation identity;
receipt verifies cluster and later revision. Endpoint authentication and durable
store qualification remain separate as their source comments state.

Root correctly declines to invent etcd-shaped responses from Bao's different
primitive. A separate metadata read plus numeric data CAS is not automatically
equivalent to those atomic comparisons. This is a specific adapter identity gap,
not proof that scoped Bao storage cannot support any acceptable custody model.

Existing Bao service packet establishes actual scoped read/update CAS and denied
runtime deletion/recreation behavior on the tested instance. Its synthetic payload
is not canonical RollbackCheckpointV1 and no CR store adapter ran. Runtime inability
to delete is relevant authority reduction, but not proof that an owner/admin,
snapshot restore or another permitted actor cannot replace state. The root report
preserves this distinction and does not claim a reproduced recreate race.

Conclusion: retain Bao as a viable candidate while root resolves the exact binding
and actor/restore assumptions. Canonical advancement, lost callback, replaced/missing
head and restore tests remain required for any chosen adapter. No new policy,
metadata permission, protocol or security exception approved by this review.
