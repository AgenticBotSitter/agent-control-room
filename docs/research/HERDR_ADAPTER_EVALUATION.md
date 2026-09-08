# Bounded Herdr adapter evaluation

Date: 2026-09-08. Local Control Room baseline: `b8bdffd`.
Owner scope: pinned source/license review, disposable read-only monitoring,
disconnect/reconnect/restart/duplicate-session tests, and replacement comparison.
This is a new explicit evaluation request, not an extension of the prior overnight
deadline. No public/private repository push, Actions, real agent or VPS operation.

## Decision

**Keep a thin optional Herdr observation adapter as a reuse candidate. Do not
replace the current native execution connector or adopt automatic resume.**

The experiment demonstrates a practical existing interface for session monitoring.
Use upstream Herdr for any future interactive terminal hosting rather than build
another multiplexer. This does not yet select Herdr as a production dependency:
OS-account isolation, host qualification and deployment packaging remain open.

No current production module is removed: the responsibilities do not overlap
enough to justify deleting accepted execution/authority code. The main saving is
avoiding future custom terminal hosting, session discovery and reconnect UI work.
Do not sell this as completion of unattended task lifecycle ownership.

## Exact pin and acquisition

- Release: [v0.9.0](https://github.com/herdrdev/herdr/releases/tag/v0.9.0), published
  2026-09-07; release metadata reports immutable.
- Annotated tag object: `cca4af8dfad160bc5fb5ae133b70882b5fe28f61`.
- Peeled source commit: `b99002ac99b09e00b4ca692436cb15a6b0d676f1`.
- Source archive SHA-256:
  `dbb75bfeb331261c3c84b3e751cb7a52852faf944f7d887af53faf9b571ae7a0`.
- Mac arm64 binary SHA-256:
  `32b53df09872628059c789a69f02a6b8e29e14ddf26711421f3463f70c1aef17`.
  Matches the release asset digest; `--version` returned 0.9.0. This checks asset
  integrity against the release, not independent reproducible-build provenance.
- Rust/Zig toolchains were not present and were not installed. No upstream Rust
  build/unit suite was executed. The matching prebuilt binary was evaluated.
- Acquisitions, sizes, retained evidence and cleanup are in
  [the download ledger](../REUSE_DOWNLOAD_LOG.md).

## What was implemented and tested

`research/herdr/monitor.mjs` is an evaluation-only adapter, not imported by the
application or exposed over HTTP. It invokes only the pinned binary's existing
`pane list` CLI command. There is no arbitrary command, start, prompt, resume,
stop, installation or terminal-content reader in its public interface.

It projects bounded pane metadata into opaque machine/session/project/pane
correlation keys, advisory status and duplicate-session warnings. Titles, paths,
raw session identifiers and arbitrary metadata are omitted from the projection.
These hashes are correlation hints, not anonymization guarantees or authorization.
The invoking operator must assign unique machine/session aliases.

The prototype retains stale observations as offline, invalidates late responses
after disconnect, checks Unix socket/parent ownership and permissions, bounds CLI
time/output, and distinguishes socket replacement using local inode/birth metadata.
That generation is an observation epoch, not a cryptographically verified server
identity or a distributed lifecycle lock. No automatic poll/retry daemon is added.

### Important failure and correction

Initial actual-binary attempts using `agent list` returned zero rows even though
two panes retained the reported synthetic Hermes session. Adding a wrapper hint
and then trying custom lifecycle reports did not establish live-agent detection.
Three attempts failed their nonempty-agent assertion; each test server and captured
cat process was stopped. This was not passed off as live Hermes compatibility.

Inspection of the actual `pane list` response showed both session references with
unknown status. `src/app/agents.rs::agent_info` filters out terminals that do not
have an effective agent label. The correction was to use the already-supported
pane metadata endpoint and preserve **unknown** session-bearing panes. No upstream
patch, fabricated agent state or terminal screen reader was introduced.

### Accepted local evidence

| Check | Result and scope |
| --- | --- |
| Projection/negative cases | Five Node tests pass: metadata minimization, duplicate identity refusal, duplicate-session flagging, machine isolation, unknown status, stale views, late-result fence, overlap refusal and mixed-generation refusal. |
| Pinned Hermes plugin tests | Three upstream Python tests pass, unchanged, with subprocess mocked; no Hermes imports, plugin installation or provider calls. |
| Actual socket permissions | API and client sockets observed as 0600; adapter refuses temporary 0660 mode and recovers after restoration. Test parent remains 0700. |
| Session monitoring | Two actual cat panes in separate workspaces retain identical synthetic Hermes session IDs; adapter reports distinct project/pane keys and flags both duplicate references. No real agent is detected or qualified. |
| Disconnect/reconnect | Temporarily rename only the disposable API socket: observer goes offline while captured pane processes remain alive. Restore the path: same observation generation returns. This is local endpoint loss, not SSH/network evidence. |
| Multiple observers | Two independent read-only clients observe the same two panes without creating more panes or resuming work. This does not test exclusivity among command-writing clients. |
| Restart | Gracefully stop and restart the actual server. Layout restores, generation advances, old cat PIDs are gone, replacement processes are cat, and native auto-resume remains disabled. No power-loss/crash or live handoff qualification. |
| Shutdown | Final server/owned cat processes exit and API socket disappears. Polling does not restart the server. Successful test state is removed. |
| Memory | One Mac snapshot: server RSS 21,248 KiB (~20.8 MiB) with two cat panes. Excludes real agents and is not a load benchmark or VPS memory budget. |
| Repository checks | Full TypeScript check, focused evaluation lint and whitespace check pass; no application dependencies or production source changed. |

The actual-binary script recorded eight checks in
[the sanitized receipt](HERDR_BINARY_EVIDENCE.json). Counts above describe different
scopes, not a deduplicated total. Empty `limitations` in that machine receipt means
no additional runtime assertion fallback was used in the final run; the scope
limitations in this report and `fixtureOnly:true` still apply.

## Hermes integration and security inspection

Pinned `src/integration/assets/hermes/__init__.py` identifies integration version
**5**, resolving the earlier documentation mismatch. It registers session-start,
reset and pre-LLM hooks. CLI pre-LLM calls can recover a resumed session ID;
subagent/background platforms are excluded. Reporting uses an argument vector,
one-second subprocess timeout, discarded stdout/stderr and no shell evaluation.
Exceptions/nonzero reporting are not surfaced as successful delivery evidence.

Installing the plugin writes under Hermes home and enables it in config; we did
neither. It does not require a Hermes core fork. It supplies session identity, not
complete lifecycle, result provenance, usage or descendant-cleanup proof. Its
environment-controlled executable and socket assume a trusted local environment.

`src/api/server.rs` sets Unix API socket mode 0600. Client sockets do likewise in
`src/server/socket_paths.rs`. Processes running as the same OS account can access
the API, which also exposes mutating operations. An allowlisted read-only adapter
is not a server-side read-only credential, project ACL, sandbox or separate user.
Do not expose this socket as a generic web proxy or let untrusted agents share the
operator's account without a separately reviewed isolation design.

Windows uses named pipes. The general JSON API calls `bind_local_listener`, while
`bind_private_local_listener` installs an explicit restrictive DACL for selected
private terminal paths. Do not assume the latter proves equivalent restrictions
on every pipe. Windows effective permissions and SSH target behavior were not
tested here; this is a review item, not a demonstrated vulnerability.

## Dependency licenses

Root Apache-2.0 is compatible in direction with our selected project license,
subject to actual compliance. Vendored portable-pty and libghostty-vt carry MIT
licenses; the included Microsoft ConPTY license/notice is MIT. Preserve applicable
copyright/license/NOTICE material and mark modified upstream files if later reused.

Fetched exact-version metadata for **all 265 registry packages** in the 267-package
Cargo.lock (the other two entries are local Herdr and portable-pty). Every registry
entry returned license metadata; full URLs, versions, checksums and metadata hashes
are retained in [the inventory](HERDR_CARGO_LICENSE_INVENTORY.json).

Most metadata offers MIT/Apache or other permissive licenses. Items needing explicit
notice/choice tracking include Unicode-DFS-2016 and Unicode-3.0 combinations,
terminfo 0.9.0's WTFPL, and r-efi's MIT/Apache/**or** LGPL alternatives. An optional
LGPL alternative is not evidence the whole application must be LGPL. This is an
inspection result, not legal clearance of the distributed binary.

Full crate license texts and the target-specific link graph were not downloaded.
Ghostty's Zig dependency declarations are separate from Cargo.lock and include lazy
packages; source build requires Zig. Determine which Zig/native dependencies enter
the selected binary and collect their actual notices before bundling or distributing
it. Do not label the entire binary Apache-only based on the root file. Optional
operator-managed Herdr installation avoids us bundling it, not the operator's own
license obligations.

## Specific replacement and integration cost

| Component/responsibility | Keep, reuse or avoid | Cost comparison |
| --- | --- | --- |
| `src/node-bridge/native-connector.ts` (98 lines at baseline) | Keep | It owns one admitted task, reporting, bounded close and uncertainty. Herdr terminal operations do not supply that contract; replacing it would add adaptation, not remove equivalent work. |
| `src/harness/hermes-native-v1/node-runtime.ts` (421 lines) and `adapter.ts` (193 lines) | Keep | Approval/lease/current-policy/run binding remains necessary. Terminal session IDs and screen status are not substitutes. |
| `native-https-client.ts`, journals and settlement/recovery modules | Keep | Machine trust, exact saved results and cleanup evidence must survive any optional terminal hosting. No deletion justified by this experiment. |
| New terminal multiplexer/session browser | Prefer Herdr if this feature is pursued | Reuse binary/CLI; avoids terminal rendering, PTY ownership and resume UI implementation. It adds installation/version/permission support work. |
| Read-only session observations on project pages | Thin adapter candidate | Local prototype proves metadata projection. Production work still needs enrolled-source configuration, project visibility filtering, freshness delivery and UI mounting. No arbitrary terminal API. |
| SSH reconnect and compatible-version operation | Reuse Herdr's implementation for a Herdr console; adapt policy ideas elsewhere | Do not port Rust transport into our HTTPS connector merely to claim reuse. Remote qualification is additional work. |
| Real native cleanup producer | Unresolved | Cat shutdown is insufficient. Herdr's Unix shutdown snapshots session PIDs and escalates signals; it is not a complete proof for escaped/new descendants or our signed per-run settlement. |

**Current production lines removed: zero.** This is a useful optional observation
and interactive-console component, not a shortcut past the execution or deployment
critical path. No trustworthy calendar saving can be claimed from this bounded
experiment; cost is low for the local read-only prototype, higher for protected
web integration, and high/unproven for replacing execution infrastructure.

## Other useful parts worth carrying forward

- `src/remote/restart_policy.rs`: keep a compatible server running despite binary
  version differences; require explicit missing capabilities instead of updating
  every machine together. Existing source tests inspected, not run here.
- Project/workspace attention rollups and explainable status rules: display why an
  agent appears blocked/unknown, and keep cached status visibly stale. Never turn
  an idle indicator into task approval or a free execution slot.
- Session reference handling and deduplication: useful regression cases for
  explicit-ID resume; do not import default automatic resume into managed jobs.
- `src/platform/windows.rs::StatusCommandGuard`: suspended process creation,
  Job Object assignment and kill-on-close are useful patterns for bounded status
  helpers. This specific code concerns status commands, not a demonstrated
  drop-in solution for all native agent descendants. Windows tests remain gated.
- Built-in Hermes detection manifests can help diagnostic presentation. Pin rules
  or disable automatic downloads during qualification; versioned screen matching
  remains advisory and should not replace structured native result APIs.

## Next integration boundary

If adopting, mount this first as **optional read-only Sessions observations** under
existing project authorization. Keep source enrollment and permitted workspace
mapping operator-owned; expose unknown/offline honestly; never publish raw socket
access, paths, prompts or session tokens. Qualify the selected Mac/Linux host setup
and permission isolation before production. Then decide whether a separate Herdr
operator console is worthwhile. Do not add custom terminal/session infrastructure
until this candidate is compared for that exact feature.

Still not established: real Hermes/Codex plugin compatibility, SSH reconnection,
Windows behavior, descendant-cleanup guarantees, live upgrade/handoff, production
tenant isolation, binary reproducibility and full redistribution notice closure.
