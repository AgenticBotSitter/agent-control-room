# Local adapter admission decision

**Status:** proposed architecture decision pending implementation review.

## Decision

The installation journal's singular `agent_readiness` stage proves the first
bootstrap worker that makes a new installation usable. It is immutable
historical bootstrap evidence, not a registry of every agent that may later
join the installation.

The first additive local-agent case reuses the same topology-transition
lifecycle as an added remote worker. This decision is deliberately limited to
adding Claude while retaining the bootstrap Hermes route. Removal and rebinding
need a later general current-adapter-set startup verifier; this decision does
not claim they work yet.

A newly added local adapter may become available only when all of these facts
agree:

1. the original installation and final review remain valid;
2. the existing topology transition names that exact added worker;
3. the transition has paused new admission while the new route is checked;
4. an adapter-specific private composition re-verifies the exact worker,
   adapter revision, connector profile, installed-process readiness, protected
   result storage, scheduler/database authority, service observation, release,
   and permitted workspace contract;
5. while admission is fenced, a trusted coordinator stages the exact protected
   private composition and requested route set outside browser control;
6. the transition records matching reviewed evidence and commits, which removes
   the fence but does not itself create or enable a route; and
7. one controlled application restart captures the staged route, then startup
   re-verifies the committed transition and exact private composition before
   exposing that route or beginning queue pickup.

This is **one installation**, not a second setup state machine. The existing
PostgreSQL authority and transition journal retain the durable admission fence
and evidence record. The protected private configuration retains process
settings and the staged route. The transition journal does not publish routes,
mutate configuration, or enable workers. No adapter gets its own database,
scheduler, queue, credential store, receipt store, retry loop, or approval
system.

## Initial and later workers

The first supported Mac installation bootstraps Hermes Agent because its fixed
runner has already passed the bounded Mac qualification. Issue #191 prevents
the formerly planned macOS Codex-second step, so Claude Code becomes the next
Mac worker after its exact private installed-process composition and owner
qualification pass. A later supported Codex host follows the same
adapter-scoped path; macOS Codex remains fail-closed, while the reviewed Linux
Codex route may be enrolled.

An installer may eventually guide these steps consecutively, but it must not
rewrite the original `agent_readiness` receipt or silently broaden it from one
adapter to another. This first package retains the bootstrap Hermes route.
Removal or rebinding remains future work and must preserve unresolved work for
owner review.

## Source implementation boundary

The next Claude package may build the inert private composition, protected
staging record, and startup re-verification around a matching committed
local-worker transition. It may expose only the existing branded delivery
callback to the ordinary queue executor after restart. A bare caller-supplied
`deliver` function must remain invalid.

This decision authorizes source and disposable-test work only. It does not
authorize an installed Claude process, credentials, provider contact, a real
task, database changes, service changes, or a live transition.
