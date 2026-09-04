# CR13A-LIVE-290 unreachable native target-runtime observer

**Status:** architecture frozen for repository implementation
**Stacked base:** accepted LIVE-280 product `c1743b7f7b5c8362cec3d33b149e3f51c5e5fda6`
**Accepted LIVE-280 rereview SHA-256:**
`bd8281cf4e0336eba7f55de2b8cde9e39e9305860a2a8287e3dcf74af52d7853`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** source implementation, static inspection, deterministic non-invocation tests, and safe zero-use
status only; no observer invocation, host/process/environment/path read, signer, clock, nonce, candidate, owner window,
shell retrieval, native listener, locator, resource, persistence, provider, network, deployment, DNS, or hosting effect

## Purpose

LIVE-280 identifies `real_target_runtime_attestation_missing` as the first blocker. LIVE-290 implements only the
lowest native layer needed later: one private no-input observer source that could collect the minimum target-class and
process-epoch material. The observer is captured but structurally unreachable and never invoked, so this block creates
no host observation or attestation.

This is real implementation work, not a repository fake. It is deliberately incomplete: raw observation is not a
signed, fresh, replay-protected attestation and cannot clear the target-runtime blocker.

## Source and custody boundary

The native observer lives in a dedicated module outside the safe connection-registry barrel. At module initialization
it may import and capture only the exact native functions and intrinsic operations required for a future observation.
It must not call those functions or read process/global properties during initialization.

The module creates one frozen private observer function and stores it once in a module-private WeakMap keyed by the
exact module-owned implementation record. The WeakMap has no lookup operation in this block. There is no exported
observer, getter, bridge, callback, token, capability, raw record, host value, or invocation path. No other production
module imports the implementation.

## Minimum future private observation

If a later separately authorized block makes the observer reachable, one invocation may privately collect only:

- operating-system platform family;
- architecture class;
- operating-system release class needed for compatibility evaluation;
- runtime family and exact semantic version;
- process identifier and parent-process identifier for one process epoch;
- process executable path solely for later private content-identity verification;
- process start/uptime material solely for later boot/session binding; and
- the exact accepted observer implementation identity.

All values remain private and ordinary in-memory. This block must not observe, return, serialize, log, persist, digest,
sign, compare, normalize, or expose them. It must not read hardware UUID, serial number, device/host name, user identity,
home or working directory, environment variables, arguments, open files, network interfaces, address, port, SSH state,
credentials, Keychain, or provider content.

## Captured native ceiling

The implementation may capture references to these future operations only:

- `node:os.platform`
- `node:os.arch`
- `node:os.release`
- `node:os.uptime`
- intrinsic reads of `process.version`, `process.execPath`, `process.pid`, and `process.ppid` inside the unreachable
  observer body

It imports no filesystem, child-process, network, DNS, HTTP, crypto signer, database, timer, SSH, credential,
Keychain, provider, native listener/issuer, or deployment module. It does not run `system_profiler`, `sysctl`, `uname`,
or another command.

## Public safe evidence

The module may export only:

- one exact frozen implementation record;
- one exact frozen zero-use status record;
- strict exact-provenance parsers for those records; and
- one fixed sanitized error class.

The records bind accepted LIVE-280, list the captured operation names, and state truthfully:

- native observer source present: true;
- observer private and stored: true;
- observer exported, retrievable, invoked, or runtime-wired: false;
- host/process/environment/path observation performed: false;
- raw observation, attestation, signer, clock, nonce, replay checkpoint, candidate, and owner authorization present:
  false;
- target-runtime blocker cleared, candidate eligible, physical qualification accepted, and activation eligible: false;
- all actual observer, host, process, environment, path, signer, persistence, timer, network, protected-value, native
  listener, and external-effect totals: zero; and
- all eight authority grants: false.

Records, arrays, callables, errors, and error prototypes are frozen. Public material contains no raw or transformed host
identity, path, PID, version observation, command, provider value, native diagnostic, or stack.

## Failure and future reachability

The future observer must fail closed and sanitize all native failures. A failure or uncertainty cannot prove target
compatibility, authorize a retry, or create an attestation. Later reachability requires a new same-module one-use bridge
that binds a fresh nonce, trusted clock, exact candidate/attempt, signer, and independent replay checkpoint before any
observation. LIVE-290 implements none of those.

## Verification and acceptance

Completion requires exact accepted LIVE-280 binding; one private frozen stored observer; source proof of zero WeakMap
lookups and zero initialization reads; no runtime consumer; exact frozen safe records; hostile and ambient
zero-execution tests; all counts zero and grants false; full producer verification; an immutable packet; and a
different independent report-only zero-repair review with 0 High/Medium/Low.

Acceptance permits ordinary integration of unreachable observer source only. It does not authorize observer retrieval
or invocation, host/process/path observation, attestation, signer or clock use, candidate assembly, owner authorization,
native listener activity, provider contact, persistence, runtime wiring, deployment, blocker clearance, or production
use.

## Reevaluate

Reevaluate before adding a WeakMap lookup or bridge; invoking the observer; reading any host/process/path value;
digesting or signing an observation; adding nonce/clock/replay state; importing the module from production code;
assembling a candidate; creating an owner window; retrieving the native shell; performing a listener or physical
attempt; contacting a provider; wiring runtime use; or deploying.
