# CR14B private Node serving — independent re-review

Date: 2026-09-05. Reviewer: `cr13a_live290_review`. Architect records the returned review.

- Base: `0c520fbe2a9b13199ac19b93236726054bcbd47e`.
- Rejected parent: `61845c45ca2b98fda110117258389af832493863`.
- Accepted product: `070a1405a0441ca1225271d6a1d74773df29c3e0`.
- Accepted tree: `4aacfed5b2372589202de4cfb1740fd42cc722c3`.
- Disposition: **ACCEPTED, 0 High / 0 Medium / 0 Low remaining**.

All four findings are closed:

1. REV-001: the AST source inventory positively pins the sole runtime `node:http` owner to
   `src/web/v1/private-serving.ts` and asserts no source consumers. The old direct `node:net` inventory and
   disabled custom-listener consumers remain unchanged. Socket typing comes from the existing HTTP type.
2. REV-002: owned expectation/continue 417 refusals now carry the common private response policy. The
   contract distinguishes Node-generated pre-handler timeout failures and does not claim physical evidence.
3. REV-003: successful factory construction transfers ownership; close-before-start demonstrably closes the
   application without creating a server. Invalid construction does not transfer ownership.
4. REV-004: bounded all-settled cleanup waits for both network and application closure, including an early
   network error while app cleanup is pending, or reports uncertainty at the shared deadline.

The compiled test additionally confirms that rendered JS/CSS references exist in the immutable client asset
snapshot. Reviewer verification: 25/25 serving/asset/bridge tests, cumulative whitespace pass and clean tracked
tree/index. Architect verification is recorded separately in `../CR14B_PRIVATE_SERVING_ACCEPTANCE.md`.

No reviewer edits, installs, source repairs, physical listener/socket, external network/database, credentials,
native/provider, browser, ingress or deployment effects occurred. Acceptance covers repository/injected
behavior, not real HTTP parsing/wire timeouts, OS cleanup, PostgreSQL, TLS/MFA or a deployed private pilot.
