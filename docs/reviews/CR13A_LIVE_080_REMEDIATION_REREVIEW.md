# CR13A-LIVE-080 remediation independent re-review

**Reviewer:** fresh independent reviewer `cr13a_live080_remediation_rereview`, different from the producer and first LIVE-080 reviewer
**Integration base:** `b0b129824f99dbaeb86f7cc6eac4001530fbe1fa`
**Rejected target:** `4ecc453f9ac0f6d6edb30455620d0b8fa0a90c3e`
**Remediation target:** `884ff423914ab4e442500bd194970b0713da72ca`
**Rejected report SHA-256:** `0f43e735ce30fe418dd93a4d5221497dde25b9f3c50d95c501f1322064bc7688`
**Repair budget:** zero; no product, documentation, branch, commit, or repository changes were made

## Finding closure

### M-001 — Closed

The lifecycle no longer stores a complete `ConnectionEnrollmentPrivateLoopbackProtectedFrameV1`. Its retained frame state is limited to `#frameDigest`, `#frameBytes`, and `#frameChunks` at `private-loopback-listener-lifecycle.ts:336-338`. Frame validation copies only those primitives at lines 401-405.

`#clearEvidence` clears all reduced frame facts plus transient connection and drain timing evidence at lines 530-535. It is called by `#fail`, `abort`, premature `finish`, wrong-order transitions through `#requireState`, mapped failures, and successful finish before receipt construction.

Successful finish snapshots only the three validated primitives, clears lifecycle evidence, marks the object complete, and only then constructs and parses the receipt at lines 472-512. Runtime-induced receipt-construction failure leaves the object terminal with no retained evidence. Later reuse returns bounded state errors and cannot recover protected material.

Private attacks covered premature finish, every wrong-order public transition after frame acceptance, rejected and behavioral close observations, abort, incomplete shutdown before drain and before listener close, receipt-construction failure, successful finish, and post-terminal reuse.

### L-001 — Closed

Receipt parsing enforces `listenerId` as an ordinary string with a 27–160 character bound before syntax, digest recomputation, or public-safe scanning at lines 283-285.

Private boundary probes confirmed:

- 26 characters: rejected
- 27 characters: accepted
- 160 characters: accepted
- 161 characters: rejected

Accessor and Proxy forms were rejected without executing caller behavior.

### L-002 — Closed

The expected rehearsal reference is derived from the already shape-validated `planDigest` by `rehearsalReferenceForPlanDigestV1` at lines 33-35. Receipt parsing requires exact equality at lines 285-288.

Changing only `rehearsalReference` or only `planDigest`, followed by recomputing the public receipt digest, was rejected. Jointly replacing both with another internally consistent pair remains possible only because this standalone public record is explicitly consistency-only, not authenticated evidence. That record still cannot change any fixed native, effect, or authority claim, and no application or runtime consumer treats the standalone receipt as authenticated or native truth.

## Findings

### High

None.

### Medium

None.

### Low

None.

## Deterministic reproduction

All required gates reproduced against the immutable remediation target:

- macOS stage zero: pass, `ready_for_runtime_check`; no native attempt
- TypeScript: pass
- ESLint: pass
- Focused listener/framing/admission suite: 34/34 pass
- Complete connection suite: 76/76 pass
- Repository pretests: 769/769 pass
- Repository core tests: 419/421 pass with the two established platform skips
- Repository posttests: 327/327 pass
- Production build: pass
- Rendered-route checks: 4/4 pass
- Database verification: migrations `0001`–`0036` applied; 119 PostgreSQL tables verified
- Base-to-remediation `git diff --check`: pass
- Rejected-target-to-remediation `git diff --check`: pass

The initial disposable dependency presentation used a symlink to the prepared dependency directory. The package manager refused before executing a project script because it would not modify that dependency directory non-interactively. A subsequent offline reconstruction attempt stopped because one package tarball was absent from the local store; offline mode prevented network fallback. The final review used a fully private copy of the already-prepared dependencies with automatic dependency reinstallation disabled. These were setup corrections only and did not alter or repair the reviewed product.

The first database-verification invocation was blocked before verification because the sandbox denied the test runner’s temporary local IPC pipe. The same read-only verifier was rerun in the permitted disposable execution context and passed. It contacted no production database.

## Mandatory questions

1. **Yes.** The complete protected frame is never retained as lifecycle object state after validation. Only its digest, byte count, and chunk count are retained for a possible successful receipt.
2. **Yes.** Premature finish, every wrong-order call after frame acceptance, observation rejection, explicit abort, mapped failure, incomplete shutdown, and all centralized terminal failures clear reduced frame and timing evidence. Later calls remain terminal and disclose only bounded safe codes.
3. **Yes.** Successful finish snapshots validated primitives, clears evidence before receipt construction, and remains single-use. Receipt-construction failure and later reuse cannot retain or recover protected frame material.
4. **Yes.** Receipt parsing applies the exact 27–160 listener-ID policy before syntax and digest acceptance. Exact boundaries pass, adjacent boundaries fail, and behavioral values execute no caller code.
5. **Yes.** The reference is rederived from the validated-shape plan digest and compared exactly. Either field changed independently with a recomputed receipt digest fails. A jointly changed, internally consistent public record remains explicitly unauthenticated and grants no native or effect truth.
6. **Yes.** Plan creation, plan parsing, receipt parsing, and finish re-establish runtime custody before selected canonicalization, reflection, pattern, string, typed-array, or hash behavior. Replacements across all six families failed closed with zero replacement execution.
7. **Yes.** Exact-key ordinary-data capture, Proxy/accessor rejection, module-private frame provenance, listener and identity equality, capacity limits, chronological bounds, and terminal-state rules remain intact. Exact protected-frame clones remain rejected.
8. **Yes.** The public receipt exposes no raw frame, delivery ID, signature, address, username, credential, host, tunnel identity, or secret-shaped material. Native, effect, and authority claims remain fixed false under recomputed public digests.
9. **Yes.** The product adds no application or browser mutation route, socket bind, active listener, network/process import, SSH launch, Hermes/provider call, credential access, native action, production database contact, deployment, or DNS effect. Local-pilot wiring remains the disabled listener implementation.
10. **Yes.** Every required deterministic count reproduced. M-001, L-001, and L-002 are closed with no new High, Medium, or Low finding.

## Private hostile probes

The private, disposable probes covered:

- eleven frame-bearing terminal and cleanup scenarios;
- premature finish and all wrong-order methods after frame acceptance;
- rejected, behavioral, and Proxy observations with no caller execution;
- abort, incomplete shutdown, successful finish, receipt-construction failure, and later reuse;
- listener-ID lengths 26, 27, 160, and 161;
- reference-only, plan-digest-only, and jointly consistent public-record drift;
- fixed negative native/effect/authority claims after recomputation;
- module-private protected-frame provenance and exact-clone rejection;
- plan creation, plan parsing, receipt parsing, and finish under replacement of canonicalization, reflection, RegExp pattern, String, typed-array, and hash operations;
- safe error and receipt-output scanning; and
- application, route, runtime wiring, network, process, provider, credential, database, deployment, and DNS absence.

All private probes passed. No repair was attempted.

## Effects and cleanup

No application was started. No Control Room listener, port, SSH session, credential or Keychain access, Hermes/provider call, native attempt, production PostgreSQL contact, deployment, DNS, hosting, MCP, plugin, or external network action occurred. Database verification used only its disposable local verification database.

All three exact disposable review directories and the private probe file were removed. An absence check returned no remaining matching artifact. The shared repository remained clean and unchanged at `a1bc9090d7f9be5dfc9137cf2b00ec613f448b87`.

## Disposition

**accepted**

This report permits only ordinary owner-controlled integration of the immutable remediation. It grants no listener, connection, SSH, credential, native, provider, production database, deployment, DNS, network, or merge authority.
