# CR13A-LIVE-120 unwired physical native-driver implementation

**Status:** exact remediation independently accepted; ordinary owner-controlled integration ready
**Product target:** `5a579342b7a03bb013de21663c69a3a6118e11c6`
**Rejected target:** `959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38`
**Integration base:** `1ee5409c0b66afbd802582459af864ec0d198f5c`
**Model:** `gpt-5.6-sol`
**Reasoning effort:** `xhigh`
**Effect boundary:** repository code, fake-only tests, static inspection, and ordinary build verification; no native
driver construction, bind-capability issuance, port selection, socket/listener operation, runtime wiring, SSH,
credential, Hermes/provider, production, deployment, DNS, or hosting effect

## Outcome

The owner authorized one unwired, fake-tested native loopback driver with one allowlisted `node:net` server module and
explicitly withheld runtime wiring and a physical listener attempt. A different independent reviewer rejected the
first target with four High and five Medium findings. The exact report is preserved at
`docs/reviews/CR13A_LIVE_120_INDEPENDENT_REVIEW.md` with SHA-256
`baefddebe2af5bcf3f2132d2a8ef2b9bce9c84f02477fff8e95de9319b8b8e66`; passing producer tests did not override it.

Exact remediation target `5a579342b7a03bb013de21663c69a3a6118e11c6` closes the reported code paths without
crossing the authorized boundary. A different report-only reviewer accepted it with 0 High, 0 Medium, and 0 Low
findings. This permits ordinary owner-controlled integration consideration only.

The new server-only module contains a literal-IPv4-loopback Node networking backend and the shared five-operation
lifecycle controller. It deliberately exports neither the physical backend factory nor any bind-capability issuer.
Its private capability registry has no insertion path, the connection-registry barrel does not export the module,
and no application, API, browser, worker, scheduler, Hermes, service, startup, or deployment source imports it.
Consequently, the committed code cannot construct the native backend or call its listener path.

The module does export a frozen implementation description and an exact repository-fake driver. The fake drives the
same `prepare`, `start`, `status`, `close`, and `recover` state machine through four fixed outcomes:
`closed_verified`, `failed_before_bind`, `ambiguous_after_marker`, and `cleanup_failed`. Its status truth always says
repository fake, runtime unwired, native driver unaccepted, physical qualification unaccepted, activation ineligible,
zero listener attempts, zero network observations, zero external effects, and no automatic retry.

## Implemented physical boundary

The isolated physical backend is prepared for later review with these fixed controls:

- one `node:net` server module and captured Node server/socket operations;
- literal `127.0.0.1`, exclusive binding, and a backlog of one, without claiming a zero kernel queue;
- one admitted socket and immediate destruction of additional connections;
- private exact-socket admission before data handlers or decoding, bound to the attempt, ordinal, deadline,
  tunnel-peer proof, and host-key proof; the admission and proof registries deliberately have no insertion path;
- the already-reviewed length-prefixed single-frame decoder with maximum frame bytes and chunk limits;
- captured and frozen decoder construction and methods, with no dynamic decoder dispatch;
- transport pause/resume based on observed pending bytes, fixed low/high watermarks, and a hard buffered-byte ceiling;
- separate start, admission, connection, idle, frame, total-attempt, drain, and shutdown deadlines;
- one-use private proof objects for owner spend, durable marker, exact contract/implementation binding, tunnel peer,
  host-key custody, exclusive-port readiness, and platform-signer trust instead of caller-reducible booleans;
- terminal post-marker ambiguity, terminal cleanup failure, no automatic restart, and recovery that cannot bind or
  reopen; and
- one idempotent cleanup path with timer and callback clearing, decoder wiping, socket destruction, separately bounded
  drain/shutdown, capability release, and late-callback guards.

The remediation intentionally makes every native post-marker cleanup end as `cleanup_failed`. Without a trusted
signer, durable attempt ledger, independent high-water checkpoint, and native-resource observer, volatile local state
can never become `closed_verified`. These are independently reviewed implementation claims, not physical evidence.
The unavailable capability/admission issuers, absent signer composition, and absent runtime consumer remain blockers.

## Verification evidence

The product target passed:

- macOS stage zero: `ready_for_runtime_check`;
- TypeScript: pass;
- full repository lint: pass;
- dedicated physical-driver gate: 34/34;
- connection gate: 123/123;
- combined CR13A gate: 139/139;
- registered pretests: 769/769;
- core tests: 372/372;
- public/application posttests: 374/374;
- production build and rendered routes: 4/4;
- migrations `0001` through `0036`: 119 PostgreSQL tables verified through the no-IPC Node fallback; and
- exact-range whitespace check: pass.

The ordinary `tsx` migration wrapper was denied permission to create its own temporary IPC pipe by the Mac sandbox
before any migration work. The established `node --import tsx` fallback then verified all migrations. This tooling
denial was unrelated to the new driver and did not invoke it.

The focused evidence includes four terminal scenarios, 32 concurrent prepare calls, 32 concurrent start calls with
one accepted start and 31 fail-closed duplicates, 32 serialized close calls, 32 serialized recovery calls, exact
object/status provenance, copy/accessor/symbol/Proxy rejection, frozen callable surfaces, borrowed-receiver rejection,
captured-intrinsic checks, ambient `Number` replacement, frozen decoder dispatch, private admission/proof insertion
searches, cleanup/deadline/backpressure source invariants, public sanitation, import/consumer allowlists, and zero
native effects.

The different zero-repair reviewer reproduced all nine original defects at the rejected target and closed each one at
the exact remediation. Its current-run gates passed at 34/34 focused, 123/123 connection, 139/139 CR13A, 769/769
pretests, 419/421 core tests with two established Windows-only skips, 374/374 posttests, production build, 4/4 rendered
routes, and migrations 0001-0036/119 tables. The independent hostile probe passed 3/3 with zero replacement executions,
protected-byte exposures, native constructions, capabilities, admissions, physical listener/socket/port attempts,
network observations, or external effects. Preserve the accepted report at
`docs/reviews/CR13A_LIVE_120_REMEDIATION_INDEPENDENT_REREVIEW.md`; SHA-256:
`420e0d3313915d9a0b71cc6fa537f3742e64359186ba569021b4d3ece95e3f7c`.

## Honest limits and next gate

Repository tests and the independent review did not run the physical backend and cannot prove that macOS will bind,
admit, apply backpressure, meet deadlines, close resources, or recover as designed. No platform signer, private
locator broker, owner-spend composition, or runtime activation exists. The frozen remediation packet SHA-256 remains
`28e91c4cbbd948c2636e1e1aeae19b1c27b5a113909c50fdaa50708f8c3e8dca`.

Independent acceptance permits ordinary integration consideration. It does not authorize a listener attempt, runtime
wiring, SSH, credentials, Hermes/provider contact, production use, or deployment.

## Reevaluate

Reevaluate before adding a bind-capability issuer, locator broker, signer, barrel export, runtime consumer, activation
candidate, owner window, physical qualification harness, port/socket/listener action, SSH or credential path,
production contact, or deployment. The first physical attempt remains a separate owner-attended, one-attempt decision
with its own immutable packet and no retry after uncertainty.
