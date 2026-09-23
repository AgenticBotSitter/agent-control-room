# Private installed-manifest native-sidecar binding

**Status:** source-only and inert. This package reads an already-published
private installed manifest and returns frozen binding data. It does not create,
rewrite or upgrade that manifest; stage or execute native bytes; open an
installation journal; construct a journal port; start a service; or make
operator composition ready.

## Version boundary

The original
`control-room.private-installed-configuration-custody/v1` manifest and API are
unchanged. They continue to load canonical configuration data while reporting
`native_journal_operation_custody_missing`. The v2 reader does not accept v1
as an implicit upgrade, and the v1 reader does not accept v2.

The v2 manifest adds one separately versioned
`control-room.private-installed-configuration-native-sidecar-identity/v1`
tuple beneath the journal declaration. The tuple is canonical and exact. It
binds:

- the release version and portable release-manifest SHA-256;
- the outer macOS launcher-manifest SHA-256;
- the installation-journal sidecar-manifest, archive, artifact-manifest and
  executable SHA-256 values; and
- fixed `darwin`, `ACRJNL1`, and `arm64` or `x64` identities.

All tuple fields are required. Extra fields, aliases, a different platform or
protocol, malformed versions and malformed digests refuse. This first identity
version is macOS-specific, so the outer launcher manifest is meaningful and
mandatory. A future installation format that lacks an outer launcher must use
a separately reviewed schema rather than omit or invent that digest.

## Returned preparation

The v2 custody reader verifies the protected installed manifest, private
configuration and journal directory using the existing no-follow/native ACL
boundary. It retains the journal root's original device and inode from initial
custody and requires the same identity on every later configuration reread.
Renaming or replacing the journal root therefore refuses even when the
replacement has the same owner and mode; neither directory is removed.

On success it returns a deeply frozen
`control-room.private-installed-configuration-manifest-bound-preparation/v1`
data packet containing the exact installation ID, canonical private
configuration data, real installed journal path and retained root identity,
owner and mode, plus the exact native-sidecar tuple. It returns no callback,
native port, executable path, staging location or journal object.

The native sidecar remains outside the immutable portable release tree. The
source-only installed journal composer can now join this packet to a separately
staged sidecar and the retained held-session journal chain. It compares the
release, platform, architecture, protocol, sidecar-manifest, archive,
artifact-manifest and executable identities, retains the original journal
owner/device/inode, and burns its one-use factory before invoking an injected
port. The reader and composer still never stage native bytes or derive a
substitute installed location, and neither clears
`native_journal_operation_custody_missing` without installed operator wiring,
independent acceptance and owner-attended native qualification.

## Evidence

`tests/private-installed-configuration-custody.test.ts` covers exact v1/v2
separation, canonical sidecar tuple validation, frozen data-only output,
caller mutation and proxy/getter refusal, and journal-root replacement across
reread. The tests use disposable directories and an injected verifier. They do
not compile, stage or run a native helper.
