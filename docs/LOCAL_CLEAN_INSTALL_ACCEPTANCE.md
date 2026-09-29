# Disposable clean-install acceptance harness

**Status:** source-only acceptance rehearsal. It is not the public installer,
an activation command, or proof that a database, service, worker, launcher or
backup system is ready for real use.

## Reuse decision

- **Reference / adapt concepts only:** T3 Code's MIT-licensed smoke-test idea, pinned at
  `6a699f0f2fbd8847d7ec2df8d9245ce8c2eb8707`, specifically the separation
  between a downloadable release, a disposable install location, and a final
  smoke check.
- **Retain:** Control Room's own checksum-verified release stager, isolated
  production-dependency preparation, durable setup-plan journal and safe
  service-lifecycle planner.
- **Do not adopt:** T3's downloader, service manager integration, runtime,
  profiles, credentials, database or deployment model.

## What the harness proves

The test first makes a disposable release bundle using the supported release
assembler. The actual acceptance journey then receives only the three files a
user would download: an archive, a manifest and a checksum file. It extracts
that archive and invokes `scripts/launch-local-setup.mjs` from the extracted
release in separate Node processes. The shipped launcher imports only other
exact manifest-bound release members. It calls only the supported installer
entry points to:

1. verify and unpack that release into an inert version folder;
2. prepare production dependencies with an injected fake package-manager
   runner (no package download or package scripts);
3. write and reconstruct a private **simulated rehearsal journal** across a
   process restart; this is expressly not the production setup-plan journal;
4. produce a simulated safe service-operation ordering without installing or
   starting a service; and
5. demonstrate that a changed staged release is refused after reconstruction.

The test uses disposable folders, simulated opaque proof digests and a
controlled fake package manager, so the test never contacts a network. A real
user invocation runs the reviewed package manager and may need Internet access
to obtain dependencies; the report says this plainly. Neither path creates or
migrates PostgreSQL, accesses credentials, installs a supervisor, switches a
live version, launches Control Room or starts an agent.

## What still needs to be built

This is the first acceptance layer, not the finished installation experience.
`launch-local-setup.mjs` is a public source-only rehearsal command, **not**
the one-click macOS launcher. The remaining seams are that outer launcher and
setup screen wired to the real durable plan journal, owner-authorized real
dependency setup, PostgreSQL and protected-data readiness, backup/restore
rehearsal, real service installation, and later agent activation. Those steps
need their own approvals and must not be implied by this test.
