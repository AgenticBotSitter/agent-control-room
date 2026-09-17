# Control Room MCP action surface (CONN-009)

Thin, harness-neutral adapter over the existing project-coordination services.
MCP and the protected website produce the same canonical records, refusals,
and audit identities because they call the same service object:
`ProjectCoordinationHttpService`. The adapter is a carrier, never an
authority.

## What it is

`src/mcp/v1/project-coordination-actions.ts` — `ProjectCoordinationMcpActions`
wraps an already-composed `ProjectCoordinationHttpService` and exposes seven
tools:

| Tool | Delegates to |
|---|---|
| `control_room_read_project` | `service.read` |
| `control_room_appoint_coordinator` | `service.appointCoordinator` |
| `control_room_replace_coordinator` | `service.replaceCoordinator` |
| `control_room_revoke_coordinator` | `service.revokeCoordinator` |
| `control_room_pause_policy` | `service.pauseDelegationPolicy` |
| `control_room_resume_policy` | `service.resumeDelegationPolicy` |
| `control_room_revoke_policy` | `service.revokeDelegationPolicy` |

Reads return the bounded page (project, coordinator head, policy summary,
active work, conflicts, attention) through the caller's existing owner
authorization. Writes pass the caller's identity, current revision, and
idempotency key straight through, so idempotency and revision checks run in
the same durable engine the website uses.

## What it is not

- No MCP server install, network listener, credential, provider, or
  production effect. Pure delegation functions; bring your own transport.
- No second task, permission, or approval system. Authorization is the
  existing `WebSessionAuthority` inside the HTTP service.
- Tool descriptions grant no authority and name no private configuration.
  Each description states the caller must already hold the grant.

## Refusal parity

Refusals are the engine's, surfaced visibly through both transports:

| Case | HTTP | MCP | Code |
|---|---|---|---|
| Stale revision | refused | refused | `stale_revision` |
| Changed content, same key | refused | refused | `coordinator_replay_conflict` |
| Unknown project | throws `not_found` | refused | `not_found` |
| Unknown tool | n/a | refused | `unsupported_tool` |
| Missing/empty idempotency key | n/a (route requires it) | refused, engine untouched | `invalid_input` |
| Self-approval, missing head, revoked policy, etc. | refused | refused (pass-through) | engine code |

The adapter adds exactly two boundary refusals of its own
(`unsupported_tool`, `invalid_input`); everything else is the HTTP
service's outcome object returned unchanged.

## Evidence

`tests/project-coordination-http.test.ts` (in-scope file, already lane
registered) gains seven parity tests that run both surfaces against the
same fixture and compare outcomes field-for-field: read equality,
appoint revision equality, stale refusal equality, replay-conflict
refusal, unsupported/unknown refusal, no-write-on-invalid-input (head
version still 0 after), and the description audit.

Mutation proofs (each cripple run against a scratch copy, named test
observed failing, tree restored byte-identical):

| Guard crippled | Failing test |
|---|---|
| `default:` branch returns accepted instead of `unsupported_tool` | mcp refuses unknown tools visibly and unknown projects like http |
| Boundary check removed (empty key reaches engine) | mcp refuses missing idempotency keys without touching the engine |
| `readProject` returns a fabricated empty page | mcp read returns the same page as http read |
| `replaceCoordinator` maps `stale_revision` to `accepted` | mcp and http refuse stale revisions with the same code |
| Description drops the word "grants" | mcp tool descriptions grant no authority and reveal no private configuration |

## Limits

The adapter proves transport parity against the fixture-backed service,
not against a live MCP client or the compiled product. Wiring it into a
real server transport is a separate, explicitly scoped step.
