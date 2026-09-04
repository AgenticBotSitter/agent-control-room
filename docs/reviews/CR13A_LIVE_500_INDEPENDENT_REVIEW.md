# CR13A-LIVE-500 independent product review

**Disposition:** ACCEPTED for ordinary integration of the inert contract only

**Review type:** different independent report-only remediation re-review

**Findings:** High 0; Medium 0; Low 0

**Accepted product commit:** `2689c10e9964b3ec936253a776ef470e01948e44`

**Accepted product tree:** `4c47d229b6d9fb60606eaa68ac0129cae5b62fb0`

**Rejected product and accepted product parent:** `f58b0b44395324706ef440321ff6144af8672507`

**Contract SHA-256:** `59c44ac4dc0f66a9888a251a7dfeb2539d4418885f9aebb6b26e5644380c342a`

**Focused test SHA-256:** `677bd46a47530463bcd33e03e209e32188064950cd0ff3fafb8e04ef157fff77`

## First review and remediation

The first independent reviewer rejected the original product with 2 High, 1 Medium, and 0 Low findings:

- H-001: the factor verifier, challenge minter, and replay guard were named but not bound to exact trusted products,
  reviews, keys, or current signed manifest/registry entries; challenge authority, domain, entropy, and durable
  reservation were incomplete;
- H-002: challenge, factor, ceremony, recheck, body, and seal lifetimes had ceilings but no complete mandatory
  chronology, fresh trusted-time observations, future-time rule, or terminal rollback/skew/expiry handling; and
- M-001: one-use applied only to one ceremony/call, so another ceremony could reuse the same request/attempt scope.

The remediation defines three pairwise-distinct challenge-minter, factor-verifier, and attempt/replay-guard product
and key bindings. Every binding carries exact commit, tree, independent review, key role, key identity digest,
fingerprint, revision, registry entry, and issuer-product ownership. A current signed manifest and trust registry must
select them, and a separately accepted manifest/registry extension is mandatory before any protected implementation.

One module-minted request now binds tenant, node, source owner, runner, and attempt identity. An authenticated durable
attempt marker is required before initial preflight or any owner, factor, sealing, or network effect. After preflight,
the issuer must mint one exact-scope, domain-separated challenge with at least 256 bits of entropy and durably reserve
it before display or factor verification. The verifier evidence binds the exact current verifier product and key and
must be independently verified for the exact scope.

The chronology now fixes fresh private PostgreSQL transaction-time observations at challenge creation, factor
acceptance, final trust recheck, nonce/body construction, and immediately before sealing. It closes inclusive
not-before, exclusive expiry, a five-second future-skew ceiling, and terminal outcomes for unavailable, rolled-back,
skewed, expired, reordered, or uncertain time.

Each exact request/tenant/node/source-owner/runner/attempt tuple permits one ceremony, challenge reservation, factor
call, and seal. Challenge reservation, success, and every post-marker uncertainty permanently burn the tuple. A known
pre-challenge refusal closes it without authorization, and every restart requires new request, attempt, ceremony,
challenge, and nonce identities. Exact replay is inert.

The different independent reviewer closed H-001, H-002, and M-001 and reported no new finding.

## Other review results

The contract binds exact accepted LIVE-480 and LIVE-490 product, tree, review, and acceptance evidence. Singleton
provenance, nested freezing, hostile accessor/proxy/Symbol non-execution, captured-intrinsic resistance, exact
transitive imports and exports, safe-barrel-only consumption, and sanitized public evidence pass.

Status truth is exact: 42 actual totals are zero; all eight authority grants are false; and no blocker, physical
qualification, candidate, activation, runtime, implementation, or deployment claim is made.

## Verification

- macOS stage zero: `ready_for_runtime_check`; no runtime/native check invoked;
- focused LIVE-500 suite: 14/14 passed independently;
- combined LIVE-490/LIVE-500 preflight: 29/29 passed independently;
- existing CR13A suite: 473/473 passed independently;
- complete repository lifecycle: 769/421/392 passed;
- TypeScript and full lint: passed independently;
- production build: all five phases passed independently;
- rendered routes: 4/4 passed independently;
- migration verification: migrations 0001-0038 and 124 tables passed using only the disposable local verifier
  database; and
- `git diff --check`: passed independently.

The ordinary sandbox denied only the migration verifier's temporary local `tsx` IPC pipe. The identical verifier
passed through Node's installed `tsx` loader without production database or network contact.

## Effects and authority

Both reviewers were report-only. They created no file, commit, or branch change and performed no network, native
source/provider, credential/key, protected-host-value, external database-service, deployment, DNS, hosting, or other
external effect. Acceptance covers only ordinary integration of inert vocabulary and singleton parsers. It grants no
owner prompt, factor verification, challenge, clock, nonce, body construction, sealing, signing, registration, store,
PostgreSQL, capsule, source/provider, process, native, runtime, deployment, hosting, DNS, approval, or execution
authority.
