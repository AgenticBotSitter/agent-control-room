# CR12B-IDEA-070 live-panel admission acceptance

**Status:** Complete for the exact repository-only, provider-disabled snapshot. No native provider call occurred.

## Accepted boundary

Control Room now has one provider-neutral admission seam between an Idea Lab session and any future live panel driver.
An adapter's own evidence is never enough. Before the coordinator can call a live driver, two separate server-held
authorities must accept the exact provider evidence and atomically consume one exact live-panel admission. Exact
same-admission/same-run replay may reconcile; the admission cannot be reused for another run.

The admission binds:

- tenant, workspace, session, immutable session digest, and one exact run ID;
- every planned participant and identity digest to one provider-evidence digest, opaque runtime identity digest, profile
  identity digest, and conversation identity digest;
- exact provider, adapter version, runtime version and revision, compatibility evidence, native qualification receipt,
  runtime manifest, and protected-value custody evidence;
- the session's exact round, message, provider-call, duration, and cost ceilings;
- one server-verified, owner-attended, strong-factor-backed, single-use effect window for only
  `idea_lab_live_panel`;
- concurrency one, a durable marker before every provider call, no automatic retry, and terminal ambiguity after an
  unknown marked call;
- cancellation between calls only, no panel steering, and resume for reconciliation only without resubmission; and
- a fixed filtered contribution record. Raw conversation, input instructions, streaming deltas, tool arguments,
  provider configuration, and raw provider identifiers are never retained.

The admission cannot approve work, issue commands, grant a lease, create a project, or grant general execution
authority. Project promotion remains the separate human-owner flow accepted in IDEA-030.

## Coordinator integration

The existing append-only coordinator now requires both authorities and the exact admission before a
`hermes_bot_mode_filtered` driver can run. Missing or rejected evidence fails before contact. Supplying live admission
material to the repository-fake path also fails before contact. The existing durable pre-call marker, restart recovery,
safe contribution builder, cost accounting, and terminal ambiguity/no-retry behavior remain authoritative.

The accepted successful-path test is injected and synthetic. It proves the seam and persistent ledger without opening a
network connection or installing a provider driver.

## Exact Hermes 0.21 packet

The disabled packet pins Hermes Agent `0.21.0`, revision
`29112bef099274229cadff79cdff7bf7b99c4b77`, adapter `adapter.hermes.gateway.v2` `2.0.0`, and the source-compatibility
contract at commit `629006dbaa958f55403fb926c4686c237d593523` from PR #180. It carries an empty accepted native-qualification
receipt list, no owner effect window, no accepted admission digest, and no live driver. Therefore its exact result is
`livePanelEligible: false`.

Source compatibility is not native qualification. The packet cannot be re-digested by a caller to change that result.
The default, browser, local-pilot, and production compositions remain provider-disabled.

## Verification

- New hostile admission suite: 8/8 passed.
- Combined CR12B suite: 59/59 passed.
- Registered pretest, core, and expanded 138-test post-test lifecycles passed with no failures.
- TypeScript, full lint, production build, 3/3 rendered-route checks, macOS stage zero, and whitespace validation passed.
- Migration verification applied all 30 migrations and verified 108 PostgreSQL tables.
- Tests cover missing authorities, forged/re-digested packet state, session/budget/time/participant drift, altered
  runtime version, protected-value custody, digest tampering, accessors, Proxies, live-admission smuggling into the fake
  path, exact synthetic acceptance, sanitized persistence, and terminal ambiguity with no retry.

## Effects not performed

No Hermes installation, native qualification, profile/configuration read, credential retrieval, provider contact,
process launch, MCP/plugin use, network request, production database or VPS contact, deployment, DNS, Cloudflare change,
project creation, or external effect occurred.

## Remaining gate

IDEA-080 may implement the provider-driver and native-qualification harness as another default-disabled repository
slice. A later owner-attended attempt still requires a fresh exact authorization after the driver, native evidence
requirements, cleanup, and sanitized evidence packet are reviewable. IDEA-070 itself grants no such authority.
