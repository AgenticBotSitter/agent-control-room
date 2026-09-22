# Private installation-journal native custody contract

**Status:** source-only storage-session extraction and injected adapter. They
perform no native operation, compile no helper, and do not make installed
operator composition ready. The blocker remains until a separately reviewed
held native implementation, release packaging, disposable adversarial evidence,
and owner-attended qualification are complete.

## Reuse decision

Retain `InstallationPlanFilesystemJournalV1` as the only installation-plan
store and retain all of its revision, legal-transition, replay, publication
witness, recovery, concurrency, and settled-inspection rules. Do not translate
those rules into C and do not add a second journal or receipt store.

Adapt the operation-scoped held-descriptor pattern already established by the
protected-directory helper. A journal operation needs a broader primitive set,
but it has the same essential rule: open every protected path component without
following links, retain native custody of the exact object across the effect,
and never use a later absolute pathname as authority.

`private-installation-journal-native-custody-preparation.ts` is the safe
preparation boundary. It captures the installation, owner and exact
journal-root identity, then prepares a bounded `read_history`,
`inspect_settled_history`, or `append` request. Capabilities are operation-
specific: settled inspection receives no create, write, link, unlink, or sync
capability; history reading receives only the exact unlink and directory-sync
mechanics needed by the retained publication recovery; append receives that
same bounded recovery capability before its publication mechanics. It
explicitly remains unready; there is no path-based fallback and no claim that
a TypeScript fake proves native behavior.

## Implemented source seam

`InstallationPlanFilesystemJournalV1` now opens one injected storage session
for each public operation. The retained plan validation, legal transitions,
publication witness, recovery and concurrency rules remain in that class.
`append` calls the internal history reader on the already-open append session;
it cannot recursively acquire a second read session. That same session spans
initial read, retained recovery, winner observation, exclusive publication,
stored-plan verification, final root verification and confirmed close.

The default storage session preserves the existing source journal behavior and
retains its root and newly created file descriptors for the operation. The
private held-session adapter supplies no filesystem fallback. It accepts only
the prepared operation and one injected native session, validates the exact
installation/root/owner binding, bounds entry names and canonical bytes, gates
mutation capabilities by operation, enforces create-write-file-sync-directory-
sync-link ordering, carries abort and the absolute deadline through every call,
and treats an unconfirmed close as failure. This is adapter evidence only: no
native descriptor-relative implementation is present.

## Why a check-before/check-after wrapper is insufficient

The current journal uses absolute paths for directory enumeration, revision and
witness reads, exclusive temporary and witness creation, hard-link publication,
recovery unlink, and directory sync. Holding or rechecking the root only before
and after those calls does not stop an ancestor or root rename from redirecting
an intervening pathname lookup.

One native session must therefore retain the opened ancestor chain and journal
root for the complete public operation. Every entry lookup and mutation must be
relative to that held root. Reopening and matching the named chain is still
required before success, but it is detection and final binding evidence; the
held descriptor is what prevents redirection during the operation.

## Exact implementation packet

1. **Source-complete:** extract the filesystem mechanics inside
   `InstallationPlanFilesystemJournalV1` behind one private operation-scoped
   storage session. Keep the class and its logical transition/publication code
   authoritative. `append` must use one session for its initial history read,
   concurrent-winner handling, publication, recovery, verification and sync;
   it must not recursively open a second path-based session.
2. **Native implementation still missing:** implement the held storage session
   with only the prepared native primitives:
   no-follow component `openat`, `fstat`, no-follow `fstatat`, descriptor-based
   enumeration, `openat` read and exclusive create, exact bounded write,
   no-replace `linkat`, identity-bound `unlinkat`, distinct file and directory
   `fsync`, and bounded close. Entry arguments are validated basenames in the
   retained journal's target, temp and witness grammar. The native layer
   implements mechanics only; TypeScript continues to validate plans and legal
   transitions.
3. Define `write_exact_bounded` as writing all supplied canonical bytes to the
   descriptor returned by the immediately preceding exclusive create, without
   reopening, appending, truncating, or accepting a different identity. It
   handles partial writes, rejects zero progress or bytes beyond the bound,
   then verifies that descriptor's identity and exact final size. The caller
   supplies at most 65,536 bytes for a plan and at most 1,024 bytes for a
   publication witness. `fsync_file` must succeed on that same descriptor
   before any directory sync or hard-link publication. This sequence is used
   for both plan and witness bytes.
4. Keep the ancestor descriptors and journal-root descriptor open until the
   whole operation closes. Reverify owner, `0700` mode, no extended ACL, root
   identity and the named ancestor chain before any success. A changed chain,
   abort, deadline, malformed/lost reply, helper exit, or unconfirmed close is
   unavailable/uncertain and is never retried as a mutation.
5. Preserve current crash semantics exactly. `read_history` may retire only the
   witness-bound temp already recognized by the retained recovery algorithm.
   `inspect_settled_history` has no mutating primitive. `append` begins with the
   same retained publication-recovery capability as `read_history`; it cannot
   create a second recovery path or perform a broader cleanup. It then preserves
   exclusive temp/witness creation, exact bounded writes, file sync, no-replace
   hard-link publication, directory sync ordering, exact replay and one-winner
   concurrency.
6. Build a dedicated reviewed macOS helper and wrapper using the existing
   deterministic sidecar, captured-byte staging, bounded private framing,
   cancellation and reap patterns. Do not extend the one-shot protected-root
   creation protocol into a general command runner. No runtime compilation or
   download is permitted.
7. Only after the native session and retained-journal adapter pass disposable
   substitution/crash/concurrency tests should installed-configuration custody
   replace `native_journal_operation_custody_missing` with the adapted journal.
   It must bind the same installation ID, owner and journal identity already
   authenticated by the installed manifest. The separately versioned v2
   installed-manifest reader now supplies that exact frozen identity data,
   including the release-bound native-sidecar tuple and retained original root
   device/inode, but deliberately does not stage the sidecar or clear the
   blocker.

## Required evidence

- ancestor and journal-root rename/substitution at every native checkpoint;
- symlink, FIFO/device, hard-link, owner, mode and extended-ACL refusal;
- target/temp/witness substitution between every read and mutation primitive;
- abort, deadline, partial frame, lost reply, helper crash and unconfirmed reap;
- exact sequential and concurrent replay, changed-content conflict, publication
  recovery, foreign-temp preservation, settled inspection with zero mutation,
  and unchanged legal-transition acceptance from the retained journal suite;
- deterministic sidecar builds/assemblies followed by a separate
  owner-attended native qualification.

The preparation tests are contract evidence only. They do not compile or run a
native helper and do not remove the production blocker.
