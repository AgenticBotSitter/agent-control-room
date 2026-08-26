# CR-6A native service packaging contract

**Status:** Active contract — static packages may implement it; native install/start tests remain owner-authorized operations.  
**Scope:** The platform supervisor around one existing portable Control Room node bridge. This contract does not alter job authority, enrollment, key storage, or network policy.

## 1. Non-negotiable boundary

A service package supervises one bridge process and one bridge-owned local journal. It is not a second Control Room, scheduler, credential broker, or privileged executor. It may start, stop, restart, diagnose, and remove that one process only.

The package must not:

- create or regenerate node keys, enrollment state, authority ceilings, or trust bundles;
- resolve credentials, add network destinations, install dependencies, or run arbitrary shell hooks;
- claim that a file exists, a service runs, an account is correct, or a key store is available without an owner-run native rehearsal;
- place secrets, private keys, raw host identity, unredacted paths, or environment values in units, templates, diagnostics, logs, or commits.

The bridge remains fail-closed: no usable signing key means no signed frames and no new work. A lost or corrupt identity requires explicit re-enrollment; supervisor restart never silently makes a new identity.

## 2. Package identity and layout

Every package declares the same value-free identity:

| Field | Required value |
|---|---|
| Product | `control-room-node` |
| Package version | immutable package release identifier |
| Runtime identity | one configured local user or service principal, never an administrator/root default |
| Bridge state root | configured private root, one journal per node identity |
| Configuration root | configured private root containing references only |
| Log channel | native supervisor log plus structured safe application log |
| Network posture | outbound bridge transport only; no listener, port, tunnel, or firewall change |

Paths are injected at installation time from a local, non-committed configuration file or supervisor setting. Package source contains placeholders and safe reference names only. The package validates that configured paths are absolute, nonempty, and distinct where separation is required; it reports a fixed safe error code instead of echoing the value.

The journal, protected-security-state stores, disposable artifact root, and logs must be separate configured paths. The runtime principal owns only its bridge state/config/log roots and has no write access to the package release directory.

## 3. Lifecycle contract

| Request | Required behaviour |
|---|---|
| Install | Validate static package and configuration only. No implicit start, enrollment, key-store operation, download, migration, or firewall change. |
| Start | Launch one bridge process after local configuration checks. It begins in `stopped`/`backing_off` until its existing signer and transport are ready. |
| Stop | Request graceful bridge stop first; bounded timeout then supervisor termination. No delete or re-enrollment action. |
| Restart | Same as stop then start. Existing journal is retained and reconciliation resumes it. |
| Disable | Prevent future automatic launch; retain state for explicit recovery. |
| Uninstall | Disable and remove only package-owned release files. State, keys, journals, configuration, logs, and artifacts are retained unless a separately approved owner cleanup procedure names exact paths. |
| Update | Stage a new immutable release beside the current release, validate it, atomically select it, then restart. Never overwrite the active executable in place. |
| Rollback | Select the immediately previous retained release and restart. It must reuse the same local state; rollback never rolls back key/trust/ceiling journals. |

Package update or rollback is not an authorization to change protocol versions, node identity, trust roots, or local authority ceilings. If the selected release cannot read existing durable state safely, it must refuse to start and report `state_incompatible`.

## 4. Isolation and process ownership

The supervisor must give the bridge a distinct process group or platform equivalent. A graceful stop first asks the bridge to stop accepting work and drain its own bounded shutdown work; cancellation then reaches the entire bridge-owned process tree, not unrelated user processes.

The package must prohibit executable discovery through writable working directories, inherited `PATH`, shell expansion, profile scripts, or current-directory lookup. It uses an explicit runtime executable and a fixed working directory owned by the package release. The runtime environment is minimal and value-free in committed templates.

All platform packages must specify a restart policy with bounded backoff. Repeated failure stays visible as failed/backing-off; it must not enter a tight restart loop or erase diagnostic evidence.

## 5. Logging and diagnostics

Application logs are structured, timestamped, bounded, and contain safe codes, lifecycle state, package version, and opaque correlation IDs only. They must not contain frame bodies, artifact locators, private paths, credentials, key identifiers beyond already-safe public IDs, raw environment values, or OS error text that can disclose them.

Each package supplies effect-free diagnostics that inspect static syntax and report one of:

- `ready_for_owner_start` — static package/config checks pass; this does not mean the service is running;
- `configuration_invalid`, `state_incompatible`, `runtime_missing`, `supervisor_unavailable`, or `unsupported_context`;
- `native_evidence_required` — a claim needs an owner-attended start/restart/cancel/sleep/reboot rehearsal.

Diagnostics never start, stop, install, load, unload, reload, elevate, or modify a native supervisor.

## 6. Platform binding rules

| Platform | Supported static package posture | Required refusal / caveat |
|---|---|---|
| macOS | LaunchAgent in the enrolled user’s Aqua login domain | LaunchDaemon and SSH/pre-login contexts are unsupported because they use the wrong or locked Keychain context. The unresolved macOS key-provider qualification remains visible. |
| Windows | User-context task/service wrapper with profile loading and Job Object process-tree ownership | Refuse pre-logon or unloaded-profile mode. Do not use LocalMachine credential scope. Native Windows Service behaviour requires owner evidence. |
| Linux | systemd unit for a host with systemd; separate container-oriented specification when systemd is absent | The current VPS container has no systemd; its package must report `supervisor_unavailable`, not pretend the unit can run there. Secret delivery remains an explicit later decision. |

The packages must label their platform in filenames, metadata, and diagnostics. A package never silently selects another platform’s supervisor or emulation layer.

## 7. Static conformance requirements

The CR6A conformance harness checks package files without operating a supervisor. For each platform it must prove:

1. correct platform marker and one `control-room-node` identity;
2. explicit non-administrative runtime principal placeholder;
3. explicit executable and fixed working directory; no shell interpolation, wildcard discovery, or inherited PATH dependence;
4. no secret-looking values, host identifiers, private absolute paths, network listeners, downloads, installers, or privileged escalation;
5. bounded restart and stop behaviour; no destructive uninstall target;
6. immutable release selection and rollback fields;
7. static diagnostics are read-only; and
8. macOS, Windows, and systemd-less Linux caveats remain visible.

## 8. Native acceptance (owner only)

The following are intentionally not automated from this repository: service installation, first start, native key-store unlock, privilege prompts, profile loading, macOS login/session behaviour, Windows Job Object enforcement, systemd/container behaviour, sleep/reboot, and persistent cleanup. Each requires an owner-approved, attached-terminal rehearsal with exact targets and rollback steps.

Passing static conformance authorizes neither installation nor operation. A failed native rehearsal is recorded as negative evidence and does not get repaired by an unattended agent.

