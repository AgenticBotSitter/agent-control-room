# CR-8I effect-free completion-flow integration contract

**Status:** Frozen for the local CR-8I repository workflow
**Version:** `control-room-completion-flow/v1`
**Live state:** Disabled

## Purpose

CR-8I composes the accepted Action Inbox, Telegram response-proposal, Completion Gate, strong-factor approval, node-local secret, synthetic execution, artifact evidence, and bounded revision components into one disposable workflow. It does not merge their authorities. Every component remains governed by its own durable contract and system of record.

The integration adds a digest-only receipt that proves exact cross-component lineage. The receipt is evidence about an already recorded flow. It cannot create an approval, issue a node attestation, admit execution, resolve a live credential, dispatch work, publish an artifact, or perform an external effect.

## Required sequence

One accepted flow contains the following facts in order:

1. An open `question` Action Inbox projection offers a normal decision response while protected exact-operation approval remains unavailable there.
2. A tenant/project/risk-scoped Telegram message plan presents digest-bound choices. Its callback creates only a durable `TelegramResponseProposalV1`.
3. An independent policy step records the selected choice as a `CompletionPreferenceV1`; the Action Inbox projection may then move to `resolved`.
4. A separate protected path records one exact consequential approval request and one human strong-factor approval decision. The approved effect remains `proposed`, the decision grants no execution authority, and a separate node attestation is still required.
5. A synthetic-only credential catalog entry and single-use grant resolve one disposable scratch value to a fixed local consumer. Only the sanitized terminal receipt crosses the broker boundary.
6. One admitted local, non-network, non-effect operation produces a claim-bound artifact observation. A completion-gate reviewer requests explicit changes with an immutable finding.
7. One credential-free local correction produces a different artifact manifest. An immutable revision resolves the complete prior finding set, supersedes the first target, reruns every required verification, and receives a different independent final review.
8. The final snapshot is `ready`. Quality readiness still grants neither approval nor execution authority.

## Receipt bindings

`CompletionFlowReceiptV1` retains only IDs, canonical SHA-256 digests, final status, and literal negative-authority facts. It binds:

- the original and resolved question projections;
- message plan, presentation, callback, response proposal, and selected preference;
- exact approval request/decision and the approved-but-unexecuted operation digest;
- safe credential catalog, grant, and receipt digests;
- initial and corrected effect-free execution observations;
- acceptance profile, original target, requested-change review, findings, revision, revised target, verification set, final independent review, and ready snapshot.

The approved operation digest must differ from both executed local-operation digests. The first local observation must bind the single-use scratch receipt. The correction must carry no credential reference or scratch receipt. Neither observation may contain a node approval attestation.

## Exact-data boundary

The receipt builders accept only exact ordinary JSON data and exact whole-buffer `Uint8Array` artifact bytes. Proxies, accessors, symbols, sparse arrays, prototype drift, non-enumerable widening, shared/detached/partial binary views, extra schema fields, changed digests, scope drift, or reordered lineage fail closed before a receipt is produced.

Artifact bytes are independently hashed and compared with the manifest. The manifest, producer claim, and lineage digest are reconstructed through the existing artifact-evidence implementation. Raw artifact bytes are not returned in the receipt.

## Authority separation

The following values are literals in every valid receipt:

- `approvedOperationDisposition: "approved_not_executed"`;
- `liveEffectsPerformed: false`;
- `approvedOperationExecuted: false`;
- `productionCredentialMaterialPersisted: false`;
- `nodeApprovalAttestationPresent: false`;
- `grantsApproval: false`; and
- `grantsExecutionAuthority: false`.

A Telegram answer cannot substitute for the strong-factor approval. The central approval cannot substitute for the separate node attestation. Secret resolution cannot grant approval. Artifact evidence, verification, review acceptance, or a ready Completion Gate cannot authorize the approved external operation.

## Failure behavior

Invalid component data, tenant/project drift, artifact mismatch, authority conflation, impossible chronology, incomplete findings, incorrect revision lineage, missing verification, correlated reviewers, or a non-ready final snapshot produces a safe `CompletionFlowErrorV1` and no receipt.

The underlying ledgers remain authoritative. A failed receipt build does not rewrite, delete, retry, or reinterpret any component record.

## Explicitly deferred

- authenticated Claude discovery or execution;
- Telegram bot, webhook, chat enrollment, or production transport;
- production password-manager or destination-native credential providers;
- native process execution or provider networking;
- node approval-attestation issuance or consumption;
- execution of the approved consequential operation;
- production integrity-key and rollback-checkpoint custody;
- protected service deployment or external effects.
