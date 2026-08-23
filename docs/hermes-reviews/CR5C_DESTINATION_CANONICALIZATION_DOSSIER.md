# CR-5C destination canonicalization and network enforcement dossier

**Status:** Complete 2026-08-23
**Worker route:** Johnny5 — Hermes Agent (`stealth/ox-alpha` via Nous), Debian VPS container
**Task class:** doc-only security analysis (issue #48; refines contradiction-review F5)
**Repo state:** `main` @ `049bf80` ("Merge pull request #42"), branch `worker/johnny5/48-destination-canonicalization`
**Purpose:** Refine F5 into implementable policy choices for paths, URLs, hosts, DNS/IPs, ports, redirects, and rebinding. No networking is implemented here.
**Stop boundary:** Doc-only. No code, config, migrations, or keys. **No network scans, resolutions, or live connects were performed** — every network statement below derives from the cited documents or is labeled as general protocol knowledge with an `[inference]` marker where it goes beyond them.

## 1. The split that unblocks D-4 (F5 refinement)

Contradiction-review F5's core correction: four independent reports already place the load-bearing check node-side (ATX case 5 expected decision, THM T7 mitigation, OPS §2 telemetry item 6, INV A4 seam note), so "who owns canonicalization" as a blocking monolith misreads the state. The decision actually decomposes:

| Sub-decision | Status | Basis |
|---|---|---|
| **D-4a: node connect-time identity pinning** | **ready — no decision needed** | Four sources concur (F5); this dossier specifies it (§4) |
| **D-4b: server allowlist canonicalization owner** | genuinely open | INV A4 flagged for Sol; narrowed by §2 below |

Nothing in this document resolves D-4b; everything in it assumes D-4a proceeds regardless, because rebinding defense (THM T7) lives entirely at the node and cannot be delegated to the server even in principle — the server never sees the socket.

## 2. Local filesystem targets vs network destinations

The two destination classes must be governed by different validators because their failure modes are disjoint:

**Filesystem targets** (matrix case 3): threats are traversal (`..`), symlink escape, and non-canonical spelling (`//srv/...`, trailing slash, URL-encoding). Canonicalization is *local and total*: resolve symlinks, normalize lexically, then compare against the ceiling root. Fail closed when canonicalization fails (e.g., dangling symlink). No external state involved; testable purely symbolically (fuzzed path corpus per matrix case 3 class).

**Network destinations**: threats are scheme/port downgrade, DNS rebinding, IP-literal aliasing, IPv6 bracket ambiguity, redirect laundering. Canonicalization is *not local* — resolving `api.example.test` requires DNS, which is exactly the attacker-controllable input (T7). Therefore network canonicalization splits again into:
- **String-level canonicalization of the requested destination** (scheme/host/port normalization before allowlist comparison) — deterministic, symbolic-testable;
- **Resolved-identity verification at connect time** (what IP/certificate the socket actually terminates at) — environment-dependent, needs the integration fixture (§8).

Invariant carried from ATX case 3/5 unchanged: **authorization compares canonical forms only; raw-string equality never authorizes.** Current central check is raw string equality on `allowedNetworkDestinations` (`canonical-store.ts:218-220`) and digest binding covers the raw string (`src/security/digest.ts:67+`, verified `canonical-store.ts:212-214`) — meaning today a non-canonical spelling of an allowed host would fail closed at the central gate (good default direction), but also that no spelling-equivalence exists anywhere yet (INV A4's observation).

## 3. Canonical input representation candidates

For the **requested destination string**, before any comparison or digest computation:

| Candidate | Rule | Notes |
|---|---|---|
| C1 — strict-literal | no canonicalization; exact match only | current behavior; safest, least usable; equivalent spellings need separate entries |
| C2 — RFC-normalized URI | lowercase scheme/host, strip default port, percent-decode once, drop fragment/userinfo | matches how humans write allowlists; percent-decode-once avoids double-decode confusion |
| C3 — structured tuple | parse to `{scheme, host, port}` and compare component-wise | what the node guard needs anyway for §4; superset of C2 |

Recommendation `[inference]`: adopt **C3 as the internal representation everywhere** (central effect-intent create AND node guard AND digest input), with C2 as the parsing stage producing it. Reasons: (a) the digest currently binds the raw string (`digest.ts:67+`) — if server and node ever normalize differently, digests diverge and effects fail spuriously, so one shared representation must feed the digest too (this is a schema-stable change only if done before CR-5C freeze); (b) component-wise comparison makes scheme/port exactness (ATX case 5) structural rather than stringly. Rejection rules: unknown scheme → reject; missing port → derive from scheme then require explicit match; userinfo present → reject outright (never legitimate in effect destinations).

## 4. Enforcement point (D-4a specification)

Layered, each independently fail-closed:

1. **Central (existing, keep):** effect-intent create checks destination against authority allowlist (`canonical-store.ts:218-220`) — authoritative for *intent creation*.
2. **Node pre-flight (new, `src/node-policy/network.ts` per TRACE D-4):** before queue-to-handler handoff, re-parse destination per §3 and verify ⊆ local ceiling's `networkDestinations` (OPTS shape, `CR5C_LOCAL_POLICY_CONTRACT_OPTIONS.md:63,191`). Compromised-server containment: signature validity ≠ permission (INV A1/A6 lineage).
3. **Node connect-time pinning (new, same module):** resolve the host **once** per effect, record `{host → resolved IPs, port, scheme}`, open the socket **only** to a pinned address, and re-verify the connected peer against the pin at TLS handshake. Any subsequent resolution during the effect returning a non-pinned address = violation → deny receipt `network_destination_violation`, terminate the effect path. This is ATX case 5's "pin first resolution / re-verify at connect" made concrete, and it is the T7 control.
4. **Post-connect:** no re-resolution; all I/O rides the pinned socket. A tool needing a second connection repeats steps 3 under the same ceiling.

Ownership answer implied by this layering `[inference]`: D-4b narrows to *"who writes the normalized allowlist entries"* (server-side normalization at policy-authoring time vs letting each node normalize) — recommend server-side at authoring time, because nodes then compare parsed-tuples without owning normalization logic, shrinking the trusted node-side parser surface.

## 5. DNS resolution / revalidation choices

Options considered for step 3's resolver interaction:

- **R1 — resolve-once-pin (chosen above):** first resolution wins for the effect's lifetime. Simple, deterministic, bounds rebinding to "attacker controls the FIRST answer," which the certificate check then constrains.
- R2 — periodic revalidation: catches long-lived effects crossing DNS TTLs, but re-opens the window mid-effect and multiplies resolver interactions; deferred unless effects routinely exceed TTL-scale durations (no evidence in any report).
- R3 — DoT/DoH hardening: improves transport hygiene but does not change the trust model (the resolver is still the adversary in T7); out of scope for v1.

Honest limit, stated per acceptance criteria: **DNS pinning alone does not guarantee TLS identity.** Pinning constrains *which machine* we talk to at the IP layer; the guarantee that it is *the named host* comes only from the TLS handshake verifying the peer certificate against the allowlisted hostname (SAN match). The two together give the invariant; either alone does not. ATX case 5's wording ("host pinned at first resolution") is implemented as IP-pin + cert-verify pair, never as IP-pin alone.

## 6. IP literals, private ranges, redirects, opaque operations

**IP-literal policy:** reject IP-literal destinations unless the allowlist entry is itself an IP literal, canonically written (IPv4 dotted-quad normalized; IPv6 lower-case compressed form per RFC 5952 `[inference]`; reject non-canonical bracket/dual spellings like `[::ffff:127.0.0.1]`). Rationale: hostname→IP equivalence can't be checked without DNS (defeating pinning), so equivalence must be identity. Matches ATX case 5's expected decision verbatim.

**Private-range policy:** node-local guard rejects connections to link-local, loopback, RFC1918, ULA, and link-local multicast ranges unless the ceiling explicitly names that literal address. This contains SSRF-style pivoting if a compromised server attempts to aim the node at infrastructure `[inference] — extends the threat model's spirit to server-compromised allowlists (T1)`.

**Redirects:** the pinned-connection model makes HTTP-level redirect handling moot for v1 tools — a redirect to another origin requires a NEW connection, which repeats §4 step 3 under the same ceiling and fails closed on mismatch. Policy stated simply: **redirects never inherit authorization; every hop re-verifies.** No automatic following across destinations within one effect `[inference]`.

**Opaque tool operations:** some tools take destinations the node cannot parse (e.g., opaque URLs handed to a browser tool). For these the digest binding (`digest.ts:67+`) remains the control — the exact opaque string is authority-bound — plus the socket-level guard still applies to whatever the tool actually opens, because the network guard operates below tool semantics. Where a tool cannot expose its effective destination, it MUST be excluded from `networkPolicy: "allowlist"` ceilings entirely rather than trusted blindly — recorded as a fixture requirement (§8, F-O).

## 7. Safe deny behavior + attack summary

Deny behavior (consistent with OPTS denial-code vocabulary, `CR5C_LOCAL_POLICY_CONTRACT_OPTIONS.md:110`): emit node-local detail code `network_destination_not_allowed` / `network_violation` outside the closed wire enum; journal the denial; never echo the offending destination into any receipt visible beyond the node (receipt-secrecy rule from #33 findings). Central mirror unaffected — the node denial is advisory to the audit trail, not a protocol error frame.

Attack classes covered → control mapping:

| Attack | Control |
|---|---|
| Scheme/port downgrade | C3 tuple exact-match (§3) |
| Path traversal / symlink escape | filesystem canonicalize-then-compare (§2) |
| Spelling-equivalence confusion | single shared canonical representation feeding digest too (§3) |
| DNS rebinding mid-session | resolve-once pin + connect re-verification (§4–5) |
| First-resolution hijack | TLS cert verification against allowlisted name (§5) |
| IP-literal aliasing / IPv6 tricks | identity-only IP matching, RFC 5952 form (§6) |
| Redirect laundering | per-hop re-authorization (§6) |
| Opaque-tool laundering | digest binding + exclusion rule (§6) |

## 8. Test fixture requirements

Symbolic (buildable now, consistent with PR #40 catalogue): fuzzed path corpus (case 3 class); URL corpus covering scheme/port/userinfo/IP-form/percent-encoding variants for C3; tuple-subset property between ceiling and request; digest-stability property (same logical destination ⇒ same digest across allowed spellings, differing across distinct ones); private-range rejection table; redirect-hop re-verification unit; opaque-exclusion enforcement.

Real integration environment required (stated explicitly, not attempted): local DNS fixture serving lying/moving answers (ATX case 5 class = integration, not property); TLS endpoint with controlled certificate to exercise cert-vs-name verification; live resolver behavior under TTL expiry for the deferred R2 question.

## 9. Open questions for Codex/Sol

1. Confirm C3 as THE canonical representation including digest input (schema-affecting; must precede freeze).
2. Server-side allowlist normalization at authoring time (our suggested D-4b answer) — confirm owner.
3. Private-range default-deny list scope (§6) — confirm the range set and the exception syntax for ceilings.
4. Whether R2 (revalidation) should be scheduled based on expected effect durations or permanently deferred.

## Method note

Sources read @ `049bf80`: `docs/hermes-reviews/CR5C_AUTHORITY_EFFECT_ENFORCEMENT_INVENTORY.md` (A4/D2 rows, line 19/46, recommendation 5 at line 88), `CR5C_ADVERSARIAL_TEST_MATRIX.md` (cases 3 and 5, lines 53–74), `CR5C_NODE_LOCAL_THREAT_MODEL.md` (T7 line 43, T8 line 44), `CR5C_IMPLEMENTATION_REQUIREMENTS_TRACE.md` (S7, D-4 line 54, dependency graph line 113), `CR5C_LOCAL_POLICY_CONTRACT_OPTIONS.md` (lines 14, 40, 63, 110, 191, 206, 215), `CR5C_RESEARCH_CONTRADICTION_REVIEW.md` (F5, lines 40–46); source files `src/persistence/canonical-store.ts:212-220`, `src/security/digest.ts:67+`, `src/domain/v1/types.ts` (AuthorityEnvelope via OPTS citation). All line refs pinned to commit `049bf80`. Items marked `[inference]` go beyond cited text: RFC 5952 canonical form choice, private-range enumeration, redirect/opaque policies, D-4b ownership suggestion, C3 adoption rationale. No live DNS, scans, or connections were made.
