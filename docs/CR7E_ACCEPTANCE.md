# CR-7E acceptance

**Disposition:** Accepted locally for the effect-free procedure and knowledge registry implementation.
**Date:** 2026-08-28
**Native or external effects:** None.

## Delivered

- Strict, versioned procedure and knowledge schemas with canonical digests and provenance.
- Immutable PostgreSQL-compatible persistence for package versions, independent reviews, exact harness mappings, and promotion/rollback history.
- Exact adapter, harness, platform, lifecycle-verb, and manifest-digest compatibility checks.
- Serialized activation with accepted-review and verified-mapping gates plus optimistic lost-update prevention.
- Rollback only to a previously active reviewed version.
- Read-only registry UI fixture with explicit candidate/rejected/active and non-authority states.
- Safe active resolution that cannot approve, dispatch, execute, supply policy, or grant authority.

## Acceptance scenarios

The CR-7E contract suite proves:

1. strict schemas reject authority, policy, credential, and secret-bearing input;
2. immutable registration and exact replay reject identity or version drift;
3. reviews require evidence and a reviewer independent of the producer;
4. mappings require exact declared versions, platform, verbs, manifest digest, and an independent verifier;
5. a rejected revision leaves the prior package active;
6. stale concurrent activation fails rather than overwriting a newer decision;
7. rollback restores only a version that appeared in accepted activation history;
8. direct database mutation of versions, reviews, mappings, and promotion history fails;
9. knowledge and procedure payload shapes cannot masquerade as each other;
10. the registry UI contains no activation control and repeats the authority separation.

## Verification

Final verification commands and counts are recorded in `docs/BUILD_STATUS.md`. No native harness, network service, credential provider, deployment, or production project was touched.

## Remaining boundary

CR-7E does not make packages executable. A scheduler must still establish capability eligibility, policy approval, a lease, an authority envelope, node-local admission, and effect-specific approval where required. CR-7Q must adversarially review the combined harness, MCP, SDK, and registry boundaries before CR-7 is closed.
