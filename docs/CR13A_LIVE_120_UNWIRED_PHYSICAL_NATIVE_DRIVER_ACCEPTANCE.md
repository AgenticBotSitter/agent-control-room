# CR13A-LIVE-120 unwired physical native-driver implementation

**Status:** implementation frozen; independent zero-repair review required
**Product target:** `959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38`
**Integration base:** `1ee5409c0b66afbd802582459af864ec0d198f5c`
**Model:** `gpt-5.6-sol`
**Reasoning effort:** `xhigh`
**Effect boundary:** repository code, fake-only tests, static inspection, and ordinary build verification; no native
driver construction, bind-capability issuance, port selection, socket/listener operation, runtime wiring, SSH,
credential, Hermes/provider, production, deployment, DNS, or hosting effect

## Outcome

The owner authorized one unwired, fake-tested native loopback driver with one allowlisted `node:net` server module and
explicitly withheld runtime wiring and a physical listener attempt. Exact product target
`959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38` implements that boundary without crossing it.

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
- the already-reviewed length-prefixed single-frame decoder with maximum frame bytes and chunk limits;
- transport pause/resume, fixed low/high watermarks, and a hard buffered-byte ceiling from an opaque capability;
- separate start, admission, connection, idle, frame, total-attempt, drain, and shutdown deadlines;
- one-use owner-window and durable-marker truth, exact contract/implementation binding, tunnel-peer and host-key proof,
  exclusive-port readiness, and platform-signer trust inside the private capability;
- terminal post-marker ambiguity, terminal cleanup failure, no automatic restart, and recovery that cannot bind or
  reopen; and
- ordered timer clearing, socket destruction, bounded server close, capability release, and late-callback guards.

These are implementation claims awaiting hostile review, not physical evidence. The unavailable private capability
issuer, absent signer composition, and absent runtime consumer are intentional blockers.

## Verification evidence

The product target passed:

- macOS stage zero: `ready_for_runtime_check`;
- TypeScript: pass;
- full repository lint: pass;
- dedicated physical-driver gate: 32/32;
- combined CR13A gate: 137/137;
- registered pretests: 769/769;
- core tests: 372/372;
- public/application posttests: 372/372;
- production build and rendered routes: 4/4;
- migrations `0001` through `0036`: 119 PostgreSQL tables verified through the no-IPC Node fallback; and
- exact-range whitespace check: pass.

The ordinary `tsx` migration wrapper was denied permission to create its own temporary IPC pipe by the Mac sandbox
before any migration work. The established `node --import tsx` fallback then verified all migrations. This tooling
denial was unrelated to the new driver and did not invoke it.

The focused evidence includes four terminal scenarios, 32 concurrent prepare calls, 32 concurrent start calls with
one accepted start and 31 fail-closed duplicates, 32 serialized close calls, 32 serialized recovery calls, exact
object/status provenance, copy/accessor/symbol/Proxy rejection, frozen callable surfaces, borrowed-receiver rejection,
captured-intrinsic checks, public sanitation, import/consumer allowlists, and zero native effects.

## Honest limits and next gate

Repository tests did not run the physical backend and cannot prove that macOS will bind, admit, apply backpressure,
meet deadlines, close resources, or recover as designed. No platform signer, private locator broker, owner-spend
composition, or runtime activation exists. The implementation has not been independently accepted.

A different report-only reviewer must attack the exact product target under
`docs/reviews/CR13A_LIVE_120_IMPLEMENTATION_INDEPENDENT_REVIEW_PACKET.md`. Any High, Medium, or Low finding rejects the
target. The frozen packet SHA-256 is
`e42cde8b401117e8bb71971315fff0219a5e8f17827e7df7a480a42ca967c9b5`. A passing review permits only ordinary
integration consideration. It does not authorize a listener attempt, runtime wiring, SSH, credentials,
Hermes/provider contact, production use, or deployment.

## Reevaluate

Reevaluate before adding a bind-capability issuer, locator broker, signer, barrel export, runtime consumer, activation
candidate, owner window, physical qualification harness, port/socket/listener action, SSH or credential path,
production contact, or deployment. The first physical attempt remains a separate owner-attended, one-attempt decision
with its own immutable packet and no retry after uncertainty.
