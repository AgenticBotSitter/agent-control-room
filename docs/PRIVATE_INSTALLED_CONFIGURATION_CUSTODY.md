# Private installed-configuration custody

## Reuse decision

**Retain, but do not expose here:** `InstallationPlanFilesystemJournalV1`
remains the sole private setup journal. Its existing append-only revision rules
are not reimplemented. It is path based, however, so a one-time native check
cannot safely grant later journal operations. This package therefore returns
no journal and reports `native_journal_operation_custody_missing` for operator
composition.

**Adapt:** the protected-file, no-follow descriptor and native ACL verification
patterns already used by the private PostgreSQL production boundary are reused
for a small read-only installed-configuration boundary.

**Build:** `private-installed-configuration-custody.ts` adds only an exact
data manifest/parser and a fixed read-only data-custody port. It decodes JSON
data only. JSON cannot supply the operator's callable dependencies; those must
be injected separately by reviewed source. The package cannot load a module,
callback, profile, credential-store item, environment variable, home
directory, current directory, or arbitrary keychain entry.

## Boundary

The manifest is canonical JSON, owned by the configured user, mode `0600`, and
is adjacent to exactly one canonical JSON configuration file and one existing
private journal directory. Trusted constructor input pins the manifest's exact
byte length and SHA-256 digest; the manifest in turn pins the installation ID,
owner, configuration file name, exact byte length and SHA-256 digest. Reads use
`O_NOFOLLOW | O_NONBLOCK`, descriptor identity checks, exact-length and digest
checks, and an injected native verifier over every protected ancestor, the
manifest, the configuration file and the journal directory. Native calls and
opens have active cancellation and bounded deadlines. Nothing creates,
repairs, deletes or changes a directory.

The returned loader is deliberately data-only and read-only. It returns
`configuration_ready`, not an operational installation. The adjacent journal
is checked only as present configuration-binding evidence. The native handle is
then closed, so the check is not represented as authority for future journal
reads, recovery, or appends. Production operator composition remains explicitly
blocked until a reviewed journal boundary retains native descriptor custody
during every operation (or a native journal implementation supplies equivalent
protection). This package is not wired to the CLI or a live startup path. No
credentials were read and no native or installation action was performed.

## Blocker and refusal taxonomy

- `native_custody_verifier_missing` is the only returned construction blocker:
  the caller did not supply a plain, callable native verifier.
- `native_journal_operation_custody_missing` is returned inside an otherwise
  configuration-ready result. Configuration data is safe to load, but the
  operator and journal remain unavailable.
- `private_installed_configuration_custody_refused` is an integrity or shape
  refusal, including path, owner, mode, link, identity, digest, length, ACL,
  substitution, proxy, or canonical-JSON failure.
- `private_installed_configuration_custody_deadline` means a file open or native
  verification did not complete inside its fixed bound. A caller must not turn
  it into success or silently retry an owner operation.
