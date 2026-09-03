# CR13A-LIVE-070 independent review

**Disposition:** `rejected`
**Integration base:** `a6c08e1553cbb6d3e3db0e262a5e115c8356c664`
**Product reviewed:** `ff00d3ffdcc5afd59bc0cc31d8a29e685fb6d587`

## Independence and scope

This was a zero-repair, report-only review by a reviewer different from the producer and the prior LIVE-060 reviewers.
The immutable product was exported into a disposable private copy. No repository file, commit, branch, pull request,
listener, SSH connection, credential, provider, production database, deployment, DNS record, or network service was
changed or contacted.

## Findings

### Medium M-001 — The protected handoff can be manufactured by recomputing its unkeyed digest

Evidence:

- `src/connection-registry/v1/private-loopback-framing.ts:139-143` removes `frameDigest` to form the unsigned material.
- Lines 146-174 accept any exact ordinary record whose caller-supplied digest equals
  `sha256Digest(unsignedProtectedFrameV1(frame))`.
- Lines 176-181 then reduce that accepted record to the two fields entering LIVE-060.
- The parser does not re-extract the delivery ID from `rawFrame` and compare it with the protected record's
  `deliveryId`.
- Producer tests at `tests/connection-enrollment-private-loopback-framing.test.ts:224-230` mutate fields while retaining
  the old digest; they do not challenge a caller-recomputed digest.

An independent probe decoded a valid frame, changed only `deliveryId`, recomputed `frameDigest` with the exported
`sha256Digest`, and confirmed that the protected parser accepted the semantically mismatched record and reduced it to
the altered routing hint. A second probe replaced `rawFrame`, `deliveryId`, and `frameBytes`, recomputed the digest, and
manufactured a newly accepted protected handoff without using the decoder.

Impact: the record proves consistency with a publicly computable SHA value, not provenance from the bounded decoder. It
therefore cannot establish that LIVE-060 input came through the reviewed framing boundary. Downstream outer
authentication and inner enrollment verification remain present, so no direct unauthenticated enrollment was
demonstrated; this limits the finding to Medium.

Required remediation:

- Make decoder provenance unforgeable and instance-bound, such as a module-private branded capability/WeakSet for this
  ephemeral handoff, or a keyed integrity mechanism if the record must cross a serialization boundary.
- Re-extract the delivery ID from the raw frame at protected parsing or reduction and require exact equality.
- Add regressions proving that caller-recomputed digests over changed raw frame, byte count, listener identity, or
  routing hint are rejected.

### Medium M-002 — Duplicate JSON keys are accepted with last-key routing

Evidence:

- `src/connection-registry/v1/private-loopback-framing.ts:183-186` uses native `JSON.parse`.
- Lines 187-198 validate only the resulting object snapshots. Duplicate lexical members have already collapsed and
  cannot be detected.
- An independent probe supplied duplicate outer `type` fields and duplicate body `deliveryId` fields. The decoder
  accepted the frame and selected the last delivery ID.

Impact: the framing boundary cannot prove one occurrence of each declared outer/body key and permits
parser-precedence-dependent routing syntax. The current downstream JavaScript parser uses the same last-key behavior and
the routing hint remains untrusted, so no authentication bypass was observed. Nevertheless, this contradicts the exact
single-frame/key-set contract and creates protocol ambiguity at a future cross-component transport boundary.

Required remediation:

- Reject duplicate members before ordinary object extraction using a bounded duplicate-aware JSON parser/tokenizer over
  the already bounded raw frame.
- Cover duplicate `type`, `body`, `deliveryId`, and other outer/body members in regression tests.
- Preserve fatal UTF-8, raw-frame forwarding, and the downstream authentication split.

### Low L-001 — Full-buffer aliases are accepted despite the documented alias-rejection claim

Evidence:

- `src/security/host-value.ts:307-321` proves that a view covers one ordinary complete `ArrayBuffer`, but cannot prove no
  second view references that buffer.
- `src/connection-registry/v1/private-loopback-framing.ts:225` relies on that check.
- `docs/CR13A_LIVE_070_PRIVATE_LOOPBACK_FRAMING_ACCEPTANCE.md:29-31` and ADR-156 claim aliased chunks are rejected.
- An independent probe created a second full `Uint8Array` over the same ordinary buffer; the decoder accepted it.

The decoder synchronously copies bytes and retains no caller buffer, so no concurrent mutation or caller-behavior
execution was demonstrated. This is an assurance/contract defect rather than an observed authority bypass.

Required remediation:

- Either define and document the enforceable rule as “exact full ordinary backing-store view, synchronously copied and
  not retained,” removing the absolute alias-rejection claim; or introduce an unforgeable fresh-buffer
  factory/capability if exclusive ownership is mandatory.
- Add a regression showing the chosen behavior and that later caller mutation cannot alter the decoded result.

### Low L-002 — Required whitespace validation fails

`git diff --check` exited `2`:

- `docs/CR13A_LIVE_070_PRIVATE_LOOPBACK_FRAMING_ACCEPTANCE.md:3`
- `docs/CR13A_LIVE_070_PRIVATE_LOOPBACK_FRAMING_ACCEPTANCE.md:4`

Both lines contain trailing whitespace. This also contradicts the “whitespace validation: pass” claim at line 68.

Required remediation: remove the trailing whitespace, correct the evidence claim if necessary, and rerun the exact diff
check.

No High findings were identified.

## Mandatory questions

1. **Prefix and allocation:** Yes. The four-byte unsigned big-endian calculation is correct across byte partitions, does
   not allocate the payload before all four header bytes arrive, rejects lengths below two, and rejects values above
   both configured and protocol ceilings.

2. **Chunk exactness:** No overall. Empty, oversized, partial, detached, shared, Buffer, subclass, Proxy,
   accessor-bearing, symbol-bearing, and behavioral inputs fail closed without executing caller behavior. A distinct
   full-buffer alias is accepted, producing L-001. No caller mutation race was demonstrated because byte copying is
   synchronous and the caller buffer is not retained.

3. **Terminal state and cleanup:** Yes. Incomplete, trailing, second-frame, post-completion, repeated-finish, closed, and
   post-failure sequences produce bounded terminal outcomes. Internal header/payload storage is wiped and detached from
   the decoder on success, failure, or close. The protected returned raw string is intentionally retained.

4. **UTF-8 and JSON ambiguity:** No overall. Fatal decoding rejects malformed, overlong, direct surrogate UTF-8, and
   BOM-prefixed JSON. Split multibyte input succeeds consistently. Whitespace remains raw-byte distinct through the
   handoff digest, and prototype-shaped extra keys fail. Duplicate members are accepted with last-key behavior,
   producing M-002.

5. **Exact extraction and trust:** No overall because duplicate lexical members are not rejected. After native parsing,
   exact ordinary outer/body snapshots and the declared delivery type are enforced. The delivery ID is treated as an
   untrusted routing hint, and no other frame field gains trust at this layer.

6. **Protected handoff:** No. The digest covers the declared fields against unrecomputed drift, and behavioral additions
   fail closed, but M-001 proves a caller can recompute the unkeyed digest to create an accepted alias, including a
   routing hint that does not match the raw frame.

7. **Reduction and downstream boundaries:** The reduction itself emits exactly `rawFrame` and `deliveryId`; the larger
   record does not cross the LIVE-060 exact-input seam, and LIVE-050/LIVE-030 code is unchanged. M-001 means the reducer
   cannot prove those two fields originated from the decoder.

8. **Runtime integrity and bounded errors:** Yes for the exercised runtime boundary. Independent replacements of JSON
   parse, byte length, UTF-8 decode, regex execution, reflection, and typed-array cleanup were detected with
   `integrity_failed`, and replacement call counts remained zero. No raw exception escape or cleanup prevention was
   observed.

9. **Disabled runtime truth:** Yes. An instantiated disposable local pilot reported `enabled: false`; `start()` returned
   the bounded `disabled` code. No app path changed, and the framing product adds no networking/process import, route,
   socket bind, SSH launch, credential access, provider call, or external effect.

10. **Counts and final gate:** The claimed deterministic counts reproduced, but the whitespace gate failed and two
    Medium plus two Low findings remain. The product cannot be accepted.

## Reproduced evidence

- macOS stage zero: exit `0`, `ready_for_runtime_check`; lockfile SHA-256
  `48af07084f582b02c5c1827e5816df9bf8a3cd8643dbd22ba041807cd9e2383a`
- `npm run check`: exit `0`
- `npm run lint`: exit `0`
- focused framing/admission: `21/21` pass
- complete connection slice: `63/63` pass
- pretests: `769/769` pass
- core tests: `419/421` pass with the two established platform skips and zero failures
- posttests: `314/314` pass
- production build: pass
- rendered checks: `4/4` pass
- migrations `0001`–`0036`: pass; `119` PostgreSQL tables verified
- `git diff --check`: exit `2`, failed on the two lines identified in L-002
- independent boundary probes: `7/7` completed, including the negative observations supporting M-001, M-002, and L-001
- independent runtime-replacement probes: six selections detected before replacement execution
- instantiated disabled-listener probe: `enabled=false`, `startCode=disabled`

The first outside-tree probe launch failed before product loading because the package loader was resolved from the empty
parent directory; it was rerun with the exact prepared loader path. The first disposable runtime scratch file likewise
failed transformation before product loading because top-level await was interpreted as CommonJS; wrapping its entry in
an async function corrected the reviewer harness without modifying the product. Neither event executed a native or
external effect.

## Product, effect, and cleanup confirmation

The shared checkout remained clean and unchanged. The disposable product archive, private probes, build output, and
temporary PGlite runtime data were removed, and their absence was confirmed. No app was started and no listener, SSH
session, credential store, Hermes/provider, production PostgreSQL, deployment, DNS, or network endpoint was touched.

## Final disposition

`rejected`

Remediation requires a new immutable product and review by another different zero-repair reviewer. This report grants no
integration, listener, connection, SSH, credential, native, provider, production, deployment, DNS, or network authority.
