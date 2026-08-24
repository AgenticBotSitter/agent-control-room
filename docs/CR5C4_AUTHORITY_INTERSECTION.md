# CR-5C.4 pure authority intersection and denial privacy

**Status:** Implemented
**Date:** 2026-08-23
**Normative parent:** `CR5C_FINAL_SECURITY_CONTRACT.md`, ADR-026 through ADR-029, and ADR-033
**Scope:** Deterministic local admission decision, approval verification input, effect classification, and coarse wire denial receipts

## Outcome

`evaluateLocalPolicy` is a synchronous deterministic function. Its only time source is an injected `Clock`, read once. It receives a previously verified owner ceiling, verified lease identity and complete authority chain, locally registered executor capability, protected-key availability, current external-effect count, normalized request, and an optional approval public key resolved through the separate approval-trust boundary.

An accepted decision proves containment across:

- tenant, node, project, job, attempt, lease ID, lease epoch, and authority digest;
- every delegated parent digest and no-widening relationship;
- executor and operation membership in ceiling, lease authority, and local executor capability;
- credential subsets and canonical target containment in both authority sources;
- ordered risk, external-effect policy, duration, concurrency, and exact decimal cost limits;
- local key availability, lease/authority time windows, and executor enforcement capability; and
- when required, an Ed25519 owner approval bound to the exact node/class, project, job, attempt, normalized operation digest, risk, and effective deadline.

The function performs no persistence, dispatch, network, filesystem, or wall-clock access. An accepted result is an admission proof only; it cannot execute an effect and does not claim single-use approval consumption.

## Local operation identity and effect classification

`ExecutorCapabilityV1` now carries a sorted `externalEffectOperationIds` subset of its operation catalogue. A request's `externalEffect` flag must exactly match this local classification. This closes the server-controlled relabeling gap recorded in ADR-033.

`computeNormalizedOperationDigest` excludes delivery- and lease-retry metadata so an equivalent re-offer remains stable, but binds tenant/node/project/job/attempt, executor and operation IDs, credential references, normalized target, risk, external-effect classification, requested duration, and measurable cost. The evaluator recomputes this digest locally before admission.

## Cost and approval behavior

Money is converted to integer 1/100,000-dollar units and compared without floating-point inequality. Noncanonical, over-precision, or unsafe numeric lease limits deny as `cost_unmeasurable`. If either authority source specifies a cost limit, the request must specify measurable cost. Positive cost requires the executor's monotonic reservable meter and must be no greater than both limits. Durable reservation remains a later admission-store responsibility.

The owner approval signature is verified locally from a separately resolved approval key. The attestation must be currently valid, expire no later than the effective authority deadline, and match every security scope. Approval issuance, revocation lookup, and durable single-use consumption remain later boundaries; an online server key alone cannot satisfy this input.

## Denial privacy

Detailed denial reasons remain in `LocalPolicyDecisionV1`. A total closed mapping reduces them to the frozen coarse wire categories. `buildWireDenialReceipt` accepts only a denied decision plus server-known receipt/message/job/attempt references and timestamp. Its strict output schema contains no request payload, local paths, allowlists, operation digest, authority digest, ceiling digest, key identifier, raw error, or free text.

## Deliberate stop boundary

This slice does not persist accepted/refused admission, consume approvals, reserve cost or concurrency, dispatch executors, create effect claims, monitor expiry, resolve real filesystem paths, perform DNS/TLS enforcement, issue approvals, or integrate live bridge messages. Filesystem containment here assumes an already canonical normalized path and uses conservative case-sensitive boundary comparison; CR-5C target guards must still prove symlink, reparse-point, mount, case, redirect, and rebinding behavior before dispatch.

## Verification

`tests/node-policy-evaluator.test.ts` covers deterministic acceptance, every identity binding, future/expired local time, owner-ceiling widening attempts across authority dimensions, delegated-chain expansion/detachment, operation effect misclassification, approval absence/forgery, concurrency, protected-key availability, exact cost metering, and receipt non-disclosure. The executor capability JSON Schema is regenerated, and the prior probabilistic signature-mutation test now flips a significant signature byte deterministically.

The repository completion gate remains `pnpm check`, `pnpm lint`, `pnpm test`, `pnpm db:verify`, and `pnpm test:build`.
