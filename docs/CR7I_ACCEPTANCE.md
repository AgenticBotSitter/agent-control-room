# CR-7I disposable combined vertical acceptance

**Status:** Accepted for the effect-free repository vertical
**Date:** 2026-08-28
**Scope:** Effect-free composition of the accepted CR-7 repository surfaces

## Acceptance objective

Prove one useful, deterministic CR-7 workflow across the reviewed package registry, Hermes and Codex observation adapters, authenticated harness history, northbound MCP proposal/read boundary, explicit proposal review, synthetic executor, and scoped result evidence. The vertical must make every absent authority gate visible and must not use a native provider, credential, network listener, production service, or deployment.

## Frozen sequence

1. Register one strict procedure package with both pinned Hermes and Codex compatibility declarations.
2. Record a producer-independent accepted review plus independent exact-manifest mappings for both adapters.
3. Activate the Hermes mapping as reviewed configuration and prove that the resolved package cannot approve, dispatch, execute, supply policy, or grant authority.
4. Pass both real public adapters through conformance using only sanitized evidence and confirm that neither exposes an execution, dispatch, or approval member.
5. Submit an authenticated, project-scoped MCP job proposal whose input digest is the exact active package digest.
6. Prove that the proposal receipt creates no job, authority, or dispatch. Record a separate proposal-review decision.
7. Cross one explicit test-only materialization seam that binds the reviewed package digest and proposal digest into a synthetic canonical job/attempt fixture. This seam is test scaffolding, not an MCP capability or production materializer.
8. Run only the deterministic synthetic executor and derive a content hash from its in-memory output.
9. Normalize sanitized Hermes and Codex frames into separate run histories bound to the same job, attempt, node, and project. Persist and reread complete authenticated histories while proving raw native identifiers never cross the public boundary.
10. Read the succeeded job and verified artifact through exact scoped MCP tools and prove the durable MCP state still records zero authority grants and zero dispatches.

## Required invariants

- Package content, provenance, review, manifest mapping, and active history remain exact and externally integrity-key authenticated.
- Package activation is configuration only. Its public result retains literal negative authority, policy, approval, dispatch, and execution fields.
- Adapter conformance and normalized events are observation only. Sanitized fixtures do not qualify or invoke native Hermes or Codex.
- The MCP proposal is intent only. Accepting its internal review record still does not materialize canonical work or create authority.
- The test-only materialization step is explicit, separately digest-bound, and cannot be reached through the MCP server API.
- Harness histories are complete, consecutive, tenant/project/job/attempt/node bound, keyed, and free of raw native identifiers.
- Synthetic execution performs no external effect. MCP result reads expose only safe job/artifact facts, not bytes, locators, credentials, native handles, or private host identity.
- Passing this acceptance does not waive any CR-7Q native or deployment blocker.

## Verification

The focused command is:

```text
npm run test:cr7i
```

The final acceptance record must also include type checking, lint, the combined CR-7Q gate, the complete repository suite, production build, rendered-route tests, migration verification through `0021`, and `git diff --check`.

Completed local evidence:

- CR-7I focused vertical: 1/1 passed.
- CR-7Q security regression gate: 120/120 passed.
- CR-7 pretest group: 45/45 passed, including CR-7I.
- Complete main repository suite: 416 total, 414 passed, zero failed, and two intentional Windows-only skips on macOS.
- Type checking and full lint: passed.
- Production build and two rendered-route tests: passed. The build retains the documented Vinext `node:crypto` externalization warning and route-classification caveat; neither caused a failed route or test.
- PostgreSQL migration verification: `0001` through `0021` applied and 73 tables verified.
- `git diff --check`: passed.

## Explicitly not authorized or claimed

- No Hermes or Codex native provider call, credential access, approval response, effect-capable tool, or service operation.
- No MCP listener, OAuth/issuer deployment, TLS, revocation service, production database, or canonical proposal materializer.
- No protected registry service/API or production integrity-key custody.
- No lease, reservation, node admission, owner attestation, credential grant, dispatch, effect claim, or external effect.
- No GitHub action, commit, push, pull request, or deployment while the owner-local hold remains active.
