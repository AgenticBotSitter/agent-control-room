# Independent root review: AO workspace follow-up

2026-09-08. Read the complete Go fixture, fit report, direct receipt and current
`src/harness/codex-v1/workspace.ts`. No test rerun or acquisition. This review is
independent of the fixture author and does not constitute production lease design.

No blocking contradiction for the bounded real-Git observations. The single test
executes actual upstream Restore/Stash/Apply operations. Its duplicate restoration
is sequential across new Workspace objects, not an OS process restart. Branch
contention is sequential, not a race test. Stale registration is produced by
removing an owned synthetic checkout and leaving Git registration intact. Conflict
assertions require the upstream conflict error, retained preservation ref and
markers, and unchanged HEAD. The fixture's arbitrary marker check does not certify
every conflict hunk or successful manual resolution.

The decisive mismatch is explicitly asserted: a branch is advanced by a real
synthetic commit, then restored with the original BaseRef; returned metadata retains
the old BaseRef while actual HEAD remains advanced. This is valid branch-oriented
behavior, not an upstream bug. The current CR manager instead checks actual
headRevision equality before granting its run/path/device/inode-bound active lease.
Returning BaseRef as headRevision would bypass that observation and is not allowed.

Source/transitive dependencies are pinned by the acquisition and runner described
in the report. The reader has not rebuilt them independently. The actual Git
fixture has empty remotes and explicit configuration isolation; private runner
guards do not cover every direct subprocess, as disclosed. Normal child completion
and cleanup are recorded, not universal process-tree containment or native Windows
acceptance. The direct receipt records exit0, no signal and the expected four log
observations. One test's assertions are not four independently executed tests.

## Root disposition

Accept the new evidence without repeating these cases. Preserve AO as a candidate
donor for conflict/stash/stale-registration mechanics. Do not map its whole Restore
result directly into CodexWorkspaceCreateEvidenceV1 or replace the current lease
manager. Actual observed revision, physical identity and canonical path remain
required, and reconstruction of Git registration is not reconstruction of a CR lease.

The remaining choice is a real adapter cost question: whether those lower-level
operations can be reused under CR's detached direct-child path contract, versus
porting selected mechanics with maintained upstream parity tests. A Go sidecar,
new protocol or custom Git lifecycle is not authorized merely by this review.
Do not expand the test census until this mapping is specified. No production code
is removed and the complete workspace outcome is still unproved.
