# Local release staging

**Status:** inert, owner-attended release placement. Staging is not an
installation, activation, update or service operation.

This slice independently implements the checksum-first, isolated temporary directory
and version-directory concepts from T3 Code's MIT-licensed installers at
revision `6a699f0f2fbd8847d7ec2df8d9245ce8c2eb8707`. It reuses Control Room's
accepted release manifest and extracted-tree verifier. No T3 runtime, service,
profile, provider or connection code is copied or materially adapted.

## What it does

With an explicit `--owner-attended` flag, the stager:

1. accepts only canonical absolute release and installation-root directories;
2. requires the release directory to contain exactly the archive, its external
   manifest and `SHA256SUMS`;
3. verifies the checksum and the external manifest before any extraction;
4. parses the gzip/tar bytes itself, rejecting links, traversal, malformed
   headers, duplicate or unlisted entries before writing them;
5. writes only to a uniquely owned temporary directory beneath `versions/`;
6. reruns the existing extracted-release verifier;
7. records and durably retains a content-bound, per-version publication marker
   in the private installer root;
8. atomically renames the complete verified tree to a hidden, deterministic
   ready directory; and
9. atomically renames only that complete tree to `versions/<version>`.

A retry over the exact verified version returns `alreadyStaged: true`. An
occupied but changed version is refused and left untouched. Owned temporary
data is removed on success and refusal. Concurrent exact attempts share the
same content-bound marker and ready directory, then converge on the same
verified version. The marker is retained instead of deleted so one attempt
cannot remove another attempt's coordination state; retries verify its exact
content. Release files and the directories that name them are flushed before
publication, and the versions directory is flushed after each publication
rename. A crash before ready publication leaves no public version; a retry can
rebuild. A crash after ready publication can resume from the exact verified
tree. A crash during the final same-filesystem rename leaves either the ready
directory or the complete version, never a partial public tree.

This protection assumes the owner-private installation root has one compliant
installer protocol writer. A different process with the same account's file
permissions can always tamper with private files; staging does not claim to
defeat the operating-system account that owns it.

## What it deliberately does not do

The sanitized result is `verified_release_staged` with remaining category
`production_dependencies_not_prepared`. It does not:

- install production dependencies;
- create or switch a `current` link or pointer;
- write an install-complete marker;
- configure, install or start a background service;
- create or migrate a database;
- read or write credentials;
- use the network, publish or sign anything.

Those are separately reviewed installation stages. A staged release cannot be
selected or started merely because this command succeeded.

## Command

Both directories must already exist and must be supplied as canonical absolute
paths:

```sh
node scripts/stage-local-release.mjs \
  --owner-attended \
  --release-directory /absolute/path/to/release-assets \
  --install-root /absolute/private/path/to/agent-control-room
```
