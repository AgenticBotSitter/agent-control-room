# CR-7C northbound MCP security contract

**Status:** Effect-free repository contract implemented locally; native/network transport deployment remains disabled.
**Protocol revision:** MCP `2026-07-28`.
**Authority:** This contract is subordinate to `SECURITY_AND_AUTHORITY.md`, `CR5C_FINAL_SECURITY_CONTRACT.md`, and ADR-012.

## Purpose and boundary

Control Room exposes a northbound interface for authenticated agents to observe bounded state and record proposals. MCP is not the worker queue, lease protocol, scheduler, approval authority, credential broker, or effect dispatcher. Internal delivery remains the Control Room node protocol and canonical persistence.

The implementation follows the stateless MCP core introduced in the official [2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/): each request carries its protocol method and authentication context. Tool names are routing identifiers, not capabilities. The server applies authorization independently on every request and every tool invocation, consistent with the official [tool authorization guidance](https://modelcontextprotocol.io/specification/draft/server/tools).

## Authentication

Each request requires both:

1. a short-lived Ed25519-signed Control Room access grant; and
2. the opaque bearer secret whose digest is bound into that grant.

The server accepts only the configured issuer key ID and canonical Ed25519 SPKI, the exact Control Room audience, a valid signature and grant digest, a maximum fifteen-minute lifetime, a live time window, sorted unique scopes, and sorted unique project IDs. Bearer comparison is constant-time. The raw bearer and signature never enter replay state, proposal state, tool output, evidence, or client evidence.

The server owns a monotonic trusted-clock observation. Clock rollback fails authentication. Proposal writes receive a second expiry check immediately before the durable mutation.

## Scope and tenant rules

Tool discovery is filtered by the signed scopes. Every read source receives the authenticated tenant and granted projects. Results are filtered again at the MCP boundary before validation and output. Project-specific requests outside the signed project list return only `project_denied`; hidden rows do not influence the visible truncation flag.

Available read tools cover:

- portfolio/project status;
- fleet/worker status;
- active work and attention;
- request lifecycle;
- terminal and nonterminal job status; and
- artifact manifest and verification evidence without bytes, locators, paths, or signed URLs.

## Proposal-only mutation surface

The only mutating tools are:

- `control_room.job.propose`;
- `control_room.delegation.propose`; and
- `control_room.approval.request`.

Their receipts always state `grantsAuthority: false` and `dispatchCreated: false`. There is no MCP tool for approve, execute, claim, lease, dispatch, credential issuance, secret retrieval, or effect performance.

A delegation proposal is recordable only when its child authority has a valid digest and is a strict containment of an authoritative parent resolved server-side. Recording it does not mint or activate that authority. Approval requests must expire after the current server time and no later than the calling access grant; recording one does not create an owner attestation.

Proposal review is an internal policy action. Even an accepted proposal remains separate from canonical job creation and dispatch. Any later materializer must use the canonical idempotent Control Room workflow and authority gates.

## Replay and persistence

The request replay key binds grant ID, client ID, and client request ID. Its authenticated durable binding also covers the exact tool name, tenant, project-scope digest, signed grant-body digest, and request digest. Exact completed replays return the prior result only after a fresh grant-current check and tool-specific schema/scope validation; changed content under the same key is denied; concurrent duplicates report `request_in_progress`.

Production wiring uses the private SQLite state implementation. It requires an absolute path in an owner-only directory, creates an owner-only regular file, uses full synchronous durability, bounds stored records, rejects unknown schema versions, and verifies the complete table/index definitions while rejecting added triggers or views. It also requires an external 256-bit integrity key and authenticates the complete replay/proposal security state so a database writer cannot legitimize substituted rows by recomputing ordinary digests. Completed replay results carry a content digest and exact request/tool/scope binding. Stored proposal bodies, normalized selectors, receipts, decisions, and chronology are re-derived and verified on every read. Abandoned in-progress replay claims are removed after restart; proposal idempotency then prevents duplicate proposal creation.

Proposal idempotency deliberately excludes the server observation timestamp, so the same authenticated proposal can retry later without becoming a conflict. A changed proposal under the same tenant/idempotency key or tenant/proposal ID fails closed.

## Redaction and error behavior

Inputs, stored proposals, replay results, tool discovery, and tool output pass the repository secret scanner. Output projections are closed and schema-validated. Tool text must be the canonical JSON encoding of structured content. The typed client verifies exact response envelopes and rejects malformed, inconsistent, or secret-bearing server output.

Authentication failures are transport failures with fixed `401 authentication_required` or `403 authentication_invalid` classifications. JSON-RPC errors use only standard safe codes and phrases. Tool denials use the fixed safe codes `invalid_tool_input`, `scope_denied`, `project_denied`, `replay_conflict`, `request_in_progress`, and `request_failed`. Private exceptions are never returned.

## Explicit non-authority

Repository tests and the synthetic end-to-end prove contract behavior only. They do not authorize a network listener, TLS termination, OAuth provider, reverse proxy, persistent service, public endpoint, native credential access, external MCP client, production database, deployment, or consequential effect. Those require separate architecture review and exact owner authorization.
