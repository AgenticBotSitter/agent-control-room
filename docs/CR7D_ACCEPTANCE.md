# CR-7D acceptance — adapter SDK and conformance kit

**Status:** Accepted for effect-free repository implementation.

## Delivered

- Public versioned adapter SDK with a deliberately observation-only surface.
- Shared conformance kit for compatibility evidence and normalized harness events.
- Hermes adapter wrapper around the pinned gateway compatibility gate and safe event normalizer.
- Codex adapter wrapper around the pinned compatibility gate and safe `exec --json` decoder.
- Example third-party adapter and tests showing the smallest safe extension seam.

## Acceptance evidence

The CR-7D suite proves that:

- the public adapter object has no start, execution, approval, credential, dispatch, lease, or effect operation;
- the existing Hermes and Codex mappings pass one shared conformance path;
- raw Hermes session IDs and Codex thread IDs appear only as digests in normalized output;
- incompatible pins, malformed fixtures, session mismatch, unknown output fields, and secret-bearing output fail closed; and
- the example adapter passes only as an effect-free observation adapter.

Run the focused gate with:

```text
npm run test:cr7d
```

The focused result is 5 passed, 0 failed, 0 skipped. `npm test` runs the 19 CR-7C tests and 5 CR-7D tests first: 24 passed, 0 failed, 0 skipped. It then runs the existing 413-test repository suite: 411 passed, 0 failed, and 2 platform-specific tests skipped. Type checking and full lint pass. The production build and both rendered-route tests pass. Database verification applies migrations through `0020` and verifies 68 PostgreSQL tables.

## Residual gates

- SDK conformance does not change the Hermes zero-tool requirement or the Codex credential-isolation/native eligibility blockers.
- No adapter can use the SDK to bypass canonical policy, authority, approvals, leases, replay handling, artifact verification, or node delivery.
- CR-7E procedure and knowledge registry work remains separate; instructions and knowledge must not become adapter authority.
- All work remains local under the owner-requested GitHub hold through 2026-09-01.
