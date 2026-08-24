# CR-5C.7 canonical filesystem and network target guards

**Status:** Implemented
**Date:** 2026-08-23
**Normative parent:** `CR5C_FINAL_SECURITY_CONTRACT.md`, ADR-028, and ADR-036
**Scope:** Real-path filesystem authorization plans and symbolic resolve-once HTTPS identity enforcement

## Outcome

Node-local target authorization now produces explicit, recheckable plans instead of treating a canonical request string as proof that the eventual target is safe.

### Filesystem

`authorizeExistingFilesystemTarget` resolves every configured root and the requested object through an injected `FilesystemInspectorV1`. Authorization requires canonical paths in one platform dialect, directory roots, true path-boundary containment, and the same volume. Prefix lookalikes and a path that resolves through a symlink, junction, reparse point, or mount outside the permitted evidence are denied.

`authorizeNewFileTarget` is separate. It refuses overwrite, resolves the direct existing parent, validates one basename, and returns a candidate plus pinned parent/root identities. It never creates the file. Windows validation rejects alternate separators, drive-relative forms, trailing dot/space aliases, reserved device names, and alternate data stream syntax. The most-specific matching configured root is selected deterministically.

Plans retain configured and real root paths, volume IDs, and root/target or parent object IDs. `revalidateAuthorizedFilesystemPlan` proves those observations still match and that a planned new target is still absent immediately before a future executor uses it. `NodeFilesystemInspector` supplies controlled local `realpath`/metadata evidence and maps all OS failures to fixed safe codes.

This closes lexical-prefix authorization. It does not claim that JavaScript revalidation alone eliminates the final check-to-open race. Actual write/destructive adapters must use the strongest platform relative-handle/no-follow primitive available and pass platform kill/race rehearsals in CR-5Q/CR-6.

### Network

The canonical v1 destination remains the exact string `https://<ascii-host>:<explicit-port>`. Runtime validation rejects normalization alternatives—including case changes, Unicode rather than IDNA ASCII, numeric IPv4 aliases, leading-zero IPv4, userinfo, path, query, fragment, wildcard, implicit port, and non-HTTPS schemes—rather than silently rewriting signed/digested authority.

`preparePinnedHttpsConnection` requires an exact sorted allowlist match and an executor that exposes its final destination and accepts a pinned TLS connection. An injected resolver is called once for a DNS host. Its bounded answer set is canonicalized, deduplicated, classified, and pinned. Any private, loopback, link-local, multicast, documentation, unspecified, reserved, malformed, or mixed answer denies the whole plan.

An exact canonical IPv4 literal in the local ceiling is the v1 typed exception for a special address; it authorizes only that identical address and bypasses DNS. IPv6 literal ceiling entries are deliberately unsupported by the frozen v1 destination grammar.

`verifyPinnedTlsPeer` requires the connected address and port to match the plan, the TLS server name to equal the canonical host, and the adapter to report successful certificate-hostname verification. A pin alone never proves host identity. Every redirect calls the same full authorization/planning function again, including same-origin redirects; authority is never inherited implicitly.

The guard uses only injected DNS and TLS evidence. There is no socket implementation and no test performs a live resolution or connection. Pin metadata needed across recoverable effects will become non-secret effect-claim metadata in CR-5C.8.

## Privacy and failure behavior

`TargetGuardError` exposes only a closed local code: invalid target, not allowed, unavailable, prohibited address, identity mismatch, or unsupported executor. Raw paths, destinations, resolver answers, certificates, and OS/library errors are never embedded in the error message or a wire receipt. Plans are node-local enforcement evidence, not remotely visible diagnostics.

## Deliberate stop boundary

This slice does not dispatch executors, open/write/delete target files, create sockets, perform live DNS or TLS, follow HTTP redirects, persist pin plans, claim effects, write pre-effect markers, consume approvals, or deploy a network proxy. Native filesystem race behavior and real DNS/TLS rebinding remain explicit CR-5Q/CR-6 rehearsals.

## Verification

`tests/node-target-guards.test.ts` covers POSIX and Windows containment, prefix tricks, simulated symlink/junction escape, volume/mount change, new-file overwrite, Windows ADS/device aliases, controlled Node real-path inspection, object-replacement revalidation, strict HTTPS grammar, one-resolution pinning, IPv4/IPv6 classification, mixed/private answers, exact literal exceptions, address/port/TLS-host checks, redirects, and opaque-executor exclusion.

The repository completion gate is `pnpm check`, `pnpm lint`, `pnpm test`, `pnpm db:verify`, and `pnpm test:build`.
