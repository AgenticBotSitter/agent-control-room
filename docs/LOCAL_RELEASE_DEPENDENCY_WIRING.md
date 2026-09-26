# Local release dependency wiring

**Decision:** retain the accepted Control Room dependency-preparation module
and include it in every verified local release. No package manager, downloader,
database, scheduler, credential store, service, or agent mechanism is added.

The release assembler already uses the accepted T3 Code reference/adapt-concepts-only decision:
versioned release layout, manifest verification and staged-release ordering from
the MIT-licensed T3 Code sources pinned at
`6a699f0f2fbd8847d7ec2df8d9245ce8c2eb8707`. This package copies no additional
T3 Code source. It independently implements the release-layout concepts by placing
Control Room's own tested dependency CLI and Node-only runtime in the same
manifest-bound archive.

The release manifest lists both files. Their byte digests therefore bind them
to the archive checksum and the extracted-release verifier refuses a changed or
missing copy. The runtime still accepts only an already staged, manifest-bound
version and an injected package runner in tests. Real package retrieval,
database work, services, credentials and agent execution remain separate,
owner-authorized installation actions.
