# Private macOS service native host

**Status:** source-complete and disposable-test complete. It is not installed,
owner-qualified, or authorized to publish or start the real Control Room
LaunchAgent.

This package supplies the descriptor-safe native boundary required by the
accepted macOS service custody decision. It consists of the fixed `ACRSVC1` C
helper in `native/macos-service-v1.c`, its one-owner Node host in
`src/installer/v1/private-macos-service-native-host.ts`, and the inert build
and release-binding pair in `scripts/build-macos-service-native.mjs` and
`src/installer/v1/macos-service-native-sidecar.mjs`.

## Fixed authority

The helper has no command-string, shell, PATH lookup, arbitrary label, generic
process-control, network, credential, delete, repair, or retry input. Production
accepts only the current non-root owner, the fixed
`xyz.agentcontrolroom.local` label, its exact `gui/<uid>` launchd domain, and
the exact `/Users/<owner>/Library/LaunchAgents/xyz.agentcontrolroom.local.plist`
target. The only service-manager executable is `/bin/launchctl`, invoked with a
minimal fixed environment and operation-specific arguments.

The Node host independently captures and recomputes the supplied parent,
definition, and fixed-label service identity digests. The service-definition
contract digest is the canonical Control Room digest of the text value; the
helper's filesystem identity separately carries the ordinary SHA-256 of the
exact UTF-8 bytes. Publication succeeds only when both independently derived
values match their respective boundary. Before any invocation the host
opens and hashes the named helper without following links, verifies its
ownership, mode, link count, ancestors, and stable identity, then copies the
verified bytes into a newly created owner-only staging directory. The
configured source path is never executed. An identity-owned partial staging
object is removed after preparation failure only when its exact identity and
contents can be proven. Otherwise the host retains terminal custody and cannot
confirm cleanup until a later exact removal succeeds. Normal staging is removed
only by the host's exact, one-way cleanup operation.

## Native protocol and filesystem custody

`ACRSVC1` is one bounded binary request and one fixed 96-byte response. It
carries numeric operation codes, the owner UID, absolute deadline, held parent
identity, optional expected definition identity, exact target path, and only
for publication the reviewed definition bytes. Reserved fields and trailing
bytes must be zero. No ordinary output or path is returned.

The helper walks every target component from a held root descriptor with
no-follow opens. Ancestors may have no ACL or the single reviewed standard
macOS `everyone deny delete` entry; any grant, different denial, inheritance
flag, extra entry, or different principal is refused. The final LaunchAgents
parent and definition remain ACL-free. It also rejects unsafe owners, modes,
links, substitutions, pre-existing publication targets, and identity drift. Publication uses a
same-directory exclusive temporary file, full write, mode and ACL verification,
file and directory synchronization, exclusive rename, and a same-descriptor
reinspection. Any ambiguity after rename or service-manager entry is
uncertainty, never a retryable failure.

## Deadlines, cancellation, and process retirement

The Node host starts each helper in a fresh process group. The helper requires
that fresh group and makes its fixed service-manager child inherit it. This is
deliberate: if the helper leader exits, is cancelled, or is killed, the outer
host can still observe and retire every remaining descendant. A normal reply is
accepted only after the leader has closed and the whole group is absent.

On cancellation, deadline, malformed output, excess output, stderr, or process
failure, the host starts one absolute two-second cleanup budget, sends TERM,
escalates to KILL, and keeps checking group absence. Exhausting that budget is
uncertainty; leader close alone can never establish cleanup. Unresolved custody
is retained after the budget expires. The host remains terminal, refuses new
work, and cannot report confirmed cleanup until a later cleanup call observes
both leader close and full process-group absence. The C layer uses one
monotonic absolute retirement deadline for its owned child leader, and the
outer host supplies the final full-group proof.

## Deliberate activation blockers

The native host does not claim release verification: `verify_release` refuses
until the installed release-custody verifier is composed. It also does not turn
`launchctl print` into application health. `inspect_service_status` remains a
service-manager status observation only; both native health performance and
`observeHealth` fail closed until the separate authenticated application-health
verifier is composed. These blockers prevent this package from satisfying the
higher runtime's final admission by itself.

## Evidence and remaining owner gate

Disposable tests compile the real helper with the reviewed hardened flags and
replace `/bin/launchctl` at compile time with a test-only binary. They also use
a separate hostile fixture to prove readiness acknowledgement, cancellation,
deadline, TERM-resistant leader and descendant retirement, independent PID and
group absence, retained unresolved custody, malformed reserved bytes, source
substitution refusal, identity-digest recomputation, exact staging reuse,
adversarial partial-staging retention, and exact staging removal. A composed
test drives the Node host through the staged real
helper to a disposable definition and proves the canonical/raw digest split.
ACL tests reproduce the standard macOS denial and reject a grant or final-target
ACL. These tests do not call real `launchctl`, publish to the real
LaunchAgents directory, install a service, or start Control Room.

The helper is not part of the portable Node archive because that archive does
not preserve executable mode. The explicit build tool instead creates a
deterministic, separately executable artifact containing the helper, license,
notice, canonical manifest, and complete checksums. The verifier rejects extra
entries, links, altered modes, source/manifest/executable substitution, wrong
toolchain claims, or noncanonical bytes. The sidecar copier binds those exact
bytes to one release version and digest while remaining unable to compile,
install, or start anything. Every final artifact mode is applied explicitly;
the deterministic build and verification also pass under a restrictive `077`
process umask.

The outer installed-release assembly must still copy that already-verified
sidecar into the protected installation, bind its sidecar and executable
digests into the installed manifest, and supply the verified installed helper
path to this host. That assembly wiring, an attached-owner native
qualification, real service publication/start, fresh authenticated health,
restart/rollback, and data-preserving uninstall remain outside this source
package and retain their existing owner gates.
