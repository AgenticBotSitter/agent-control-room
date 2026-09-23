# macOS Claude process custody source package

Status: source and disposable-fixture evidence only. This package does not
enable, qualify, install, stage, or run Claude. It is not yet connected to
`private-installed-process-host.ts` or the installed operator. Independent
security acceptance, release integration, and owner-attended CLI qualification
remain required before that connection can become available.

## Purpose and authority

`native/claude-code-process-v1.c` is a single-session native custodian beneath
the accepted L5 private process-host contract. The higher host must retain its
current authority fence and send GO only for the exact admitted attempt. A
VERIFIED response is filesystem evidence, never execution authority. A helper
response cannot establish qualification, owner presence, approval, delivery,
terminal result publication, or retry permission.

The custodian accepts exactly one executable, one owner-private workspace and
one fixed argument list, matching `CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1`. There
is no argv, shell, command string, environment, credential, resume, session-ID,
plug-in, MCP, or LaunchServices input. The executable must be a thin native
64-bit Mach-O executable for the current architecture. Scripts, interpreters,
universal binaries, symlinks and hard-linked executables are refused. This
intentionally leaves unsupported real installation layouts closed until a
reviewed qualification and installation design addresses them.

## Descriptor and frame contract: ACRCCP1

The helper is launched with no arguments. All six descriptors must already be
pipes or sockets owned by its caller. The owner-held parent must construct
distinct control/status and target streams; it cannot substitute ordinary
files, a terminal or an inherited generic subprocess environment.

| Helper descriptor | Meaning | Target descriptor |
| --- | --- | --- |
| 0 | Bounded private control input | Not inherited |
| 1 | Bounded sanitized status output | Not inherited |
| 2 | Reserved, no output | Not inherited |
| 3 | Target input | 0 |
| 4 | Target output | 1 |
| 5 | Target error output | 2 |

Target bytes are never parsed as custody frames. No target byte can forge a
status response. Other descriptors are closed on target exec using
`POSIX_SPAWN_CLOEXEC_DEFAULT`; only the three explicit dup actions are inherited.
The working-directory descriptor is used by the native fchdir spawn action,
then closed at exec. The target receives only fixed PATH, LANG and LC_ALL
values. HOME, login data, tokens, shell settings and dynamic-loader variables
are not inherited. Authentication compatibility is unproven and requires its
separate future owner qualification; this package reads no credentials.

Every integer is unsigned, big-endian. There is one 104-byte HOLD header,
followed by executable-path bytes and workspace-path bytes, without NULs.

| Offset | Bytes | Value |
| --- | --- | --- |
| 0 | 8 | ASCII `ACRCCP1` followed by LF |
| 8 | 4 | HOLD opcode, exactly 1 |
| 12 | 4 | Executable path length, 2–4095 |
| 16 | 4 | Workspace path length, 2–4095 |
| 20 | 4 | HOLD deadline duration, 100–30000 milliseconds |
| 24 | 4 | Post-start deadline duration, 100–600000 milliseconds |
| 28 | 4 | Reserved, zero |
| 32 | 8 | Expected non-root owner UID, equal to effective and real UID |
| 40 | 8 | Exact executable device |
| 48 | 8 | Exact executable inode |
| 56 | 8 | Exact workspace device |
| 64 | 8 | Exact workspace inode |
| 72 | 32 | Exact executable SHA-256 bytes |

The initial header has a fixed 30-second deadline. Subsequent operations use a
monotonic clock. At most 64 held components per path are accepted; executable
hashing is bounded to 512 MiB and the HOLD deadline. Paths are absolute,
component-wise opened without following links, and reject dot components,
empty components and control characters. Protected ancestors must be owned by
the owner or root, have no extended ACL and no group/other write permission.
Only the exact root-owned `/private/tmp` ancestor may have sticky mode 01777.
The workspace itself is owner-owned mode 0700. The executable is regular,
single-link, executable, non-set-ID and not writable by group/other.

After VERIFIED the next frame is GO or CANCEL. Every control frame is exactly
16 bytes: ASCII `ACRC` at bytes 0–3, an opcode at byte 4, and zero reserved
bytes at 5–15. The opcodes are GO=2, CANCEL=3, TERM=4 and KILL=5. TERM and KILL
are accepted only after STARTED. CANCEL during HOLD returns CANCELLED with no
child. After STARTED, CANCEL requests group KILL. There is no second HOLD or
GO, and at most 32 post-start commands are accepted.

Every response is exactly 16 bytes: ASCII `ACRS` at 0–3, status at byte 4,
exit-kind at 5, groupAbsent at 6, zero at 7, exit value at 8–11, and zero at
12–15. Statuses are VERIFIED=1, STARTED=2, EXIT=3, REFUSED=4, UNCERTAIN=5 and
CANCELLED=6. Only EXIT contains an exit-kind (1=code, 2=signal), value, and
groupAbsent=1. All other fields are zero. Status contains no PID, path,
credentials, arguments, raw errors, model output or host identity. Writes are
nonblocking and fixed-size; an unavailable status sink fails closed and cannot
block cleanup.

## Release and retirement boundaries

HOLD retains descriptors for every path component, rechecks the named and held
identities, and hashes the held executable before returning VERIFIED. It does
not spawn the target. GO first repeats those checks. Then `posix_spawn` uses
`POSIX_SPAWN_START_SUSPENDED`, a fresh process group, fixed argv, an explicit
signal mask/defaults and the held workspace descriptor. No target user code
may execute during the following validation.

The helper checks the kernel-recorded parent, owner, process group and stopped
state; the kernel-recorded working-directory vnode; and the first file-backed
executable mapping's vnode. That mapped vnode must match the held executable.
It does not use `stat(proc_pidpath())` to certify an already mapped image.
Kernel inspection may lag spawn return, so it has a bounded 500-millisecond
observation window while the process remains suspended. Named-path validation,
held-file hashing and guest validation repeat immediately before SIGCONT.
STARTED is emitted only after all checks and successful SIGCONT.

The helper keeps the leader waitable until cleanup. TERM and KILL signal only
the verified fresh group. Natural leader exit also triggers group KILL so a
remaining ordinary descendant cannot turn leader exit into false retirement.
The helper then reaps the leader and observes group absence. No further group
signal is sent after leader reaping, avoiding a numeric PID/group reuse hazard.
A refused signal alone is neither success nor failure evidence: EXIT requires
both the actual leader status and group absence. Cleanup has a separate
three-second bound. Unknown cleanup, malformed input after STARTED, control
loss, helper cancellation, deadline expiry or status-write failure reports
UNCERTAIN rather than a terminal result. A pre-start mismatch that is safely
retired reports REFUSED. The helper never retries a launch.

## Deterministic, inert release artifact

`scripts/build-claude-code-process-native.mjs` explicitly builds with the
already installed Apple toolchain. It never downloads, installs, starts the
helper or chooses an installation path. An existing output directory is
refused. The artifact consists of a deterministic archive, canonical manifest
and checksum list. It binds platform, architecture, minimum macOS 13.0,
protocol, source digest, exact reviewed compiler flags, compiler/SDK versions,
license/notice bytes and executable bytes. `ownerQualified` remains false.

`macos-claude-code-process-native-sidecar.mjs` validates and copies these inert
bytes into a separate sidecar, binding the exact portable-release SHA-256 and
release version. It rejects extra archive members, links, traversal, incorrect
modes, archive corruption, mixed identities and inconsistent manifests. It has
no staging or executable-launch API. A caller using the sidecar must pin both
the portable-release digest and the sidecar-manifest digest from reviewed
outer release evidence. Structural validation without those external pins is
not authenticity evidence or activation authority. It does not modify the
portable release or the installed manifest/launcher format.

## Evidence and remaining limits

`pnpm test:native-fences` includes disposable-native tests for no target before
GO, fixed argv, environment/descriptor isolation, normal exit, CANCEL,
TERM/KILL, executable/workspace replacement, malformed/truncated frames,
incorrect hashes, deadline/control loss, deterministic builds, release pins
and package tampering. Native execution/build cases are macOS-only and skip on
other platforms. These tests run a tiny reviewed fixture, never Claude.

The checked fixture evidence covers the current macOS/architecture only.
There is no proof here for the other architecture, an actual installed Claude
binary, native credential/authentication behavior, dyld/runtime dependencies,
budget enforcement, install/restart composition, or a real task. A deterministic
race injection between the final pathname check and spawn is also not covered;
the suspended kernel-vnode check implements that refusal boundary and requires
independent security review.

This is process custody, not an OS sandbox. It does not contain a malicious
same-UID actor or a target that deliberately escapes its group via setsid or
other privilege mechanisms. SIGKILL of the helper cannot run cleanup; the
future owner-held supervisor must retain and prove that recovery obligation.
Those missing proofs must not be converted into a qualified worker or a cleared
L5 owner gate.
