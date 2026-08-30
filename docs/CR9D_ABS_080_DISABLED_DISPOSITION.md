# CR9D-ABS-080 publication disposition

**Disposition:** Disabled
**Recorded:** 2026-08-29
**Contract:** `control-room-abs-news-publication-readiness/v1`
**Assessment ID:** `assessment:abs-publication:cr9d-080`
**Assessment digest:** `sha256:7ed780e1e4d8206bfadb50fc3e6379ed328b82602a7256bb3533c7790ca07caf`
**Disposition ID:** `disposition:abs-publication-disabled:b76d8c0e1177b5fc15d466f8`
**Disposition digest:** `sha256:946385677cb98ffdbbf587c9708d8aade921f5145608447f032173bd0607c099`

## Result

No public ABS publication was attempted or authorized. No public mutation, network request, credential resolution, deployment, adapter call, automatic retry, or external effect occurred.

The repository now represents publication readiness as an exact ordered assessment rather than prose or an implied pass. The current assessment is blocked by all nine required gates:

1. `exact_destination_identity`
2. `immutable_article_revision`
3. `authoritative_completion_resolution`
4. `reviewed_live_adapter`
5. `node_approval_attestation`
6. `credential_custody`
7. `destination_idempotency_qualification`
8. `rollback_and_reconciliation_procedure`
9. `owner_attended_approval_window`

Each gate is recorded as missing, with its required evidence class and a digest-bound negative-authority prerequisite record. Missing evidence cannot be represented as eligible, and a partial package or destination identity fails validation.

## What the disposition means

- `status` is `disabled`.
- `requiresNewAssessment` is true.
- `automaticRetryAllowed` is false.
- `actualPublicationAttempted`, `publicMutationObserved`, and `externalEffectOccurred` are false.
- `publicationAuthorized`, `grantsApproval`, and `grantsExecutionAuthority` are false.
- `requiresIndependentCheckpoint` is true because repository-local authenticated storage cannot by itself prove rollback resistance against restoration of an older complete database file.

A later assessment can become only an owner-approval candidate when every gate is independently evidenced and current and both the exact package and destination identities are complete. Even that candidate grants no publication authority and cannot run through the current repository runtime, which remains explicitly fake-only.

## Durable implementation

`publication-readiness.ts` defines the exact prerequisite, assessment, and disposition schemas and the repository-owned current disabled record. `publication-readiness-store.ts` provides a scope-bound, HMAC-authenticated, append-only SQLite ledger. The ledger records assessment and disposition atomically, makes exact replay inert, rejects chronological rollback and same-ID drift, and detects row deletion, metadata drift, a wrong integrity key, and added schema behavior.

This disposition closes the CR9D offline ABS lane honestly. It is not evidence of a live publication pass and does not clear the separately blocked live-read gate.
