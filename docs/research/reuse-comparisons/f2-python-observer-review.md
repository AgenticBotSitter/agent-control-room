# Independent Python SDK → CR observer review

2026-09-08. Source and existing-receipt review only; no rerun, downloads or native
operations. Reviewed report, Python client/peer fixture, Node bridge, acquisition
receipt, actual result receipt and prior corrected early-completion evidence.

**No blocking finding for the bounded observer-schema conclusion.** The report
correctly leaves transport ordering and final RC2 selection open. Root owns acceptance.

## Actual versus simulated path

The fixture imports selected real synchronous CodexClient, MessageRouter and generated
models using the exact nine-file prior acquisition closure. It does not replace their
methods or fabricate Pydantic payloads in the Node bridge. Minimal namespace packages
exclude the package facade as disclosed. Generated model names in direct output are
TurnStartedNotification, ThreadTokenUsageUpdatedNotification and
TurnCompletedNotification; UnknownNotification is explicitly refused.

Peer response carries the synthetic native thread/turn values. Actual typed response
provides started.turn.id and actual notifications are serialized with model_dump's
wire aliases before the Node observer binds that ID. This is not the TS experiment's
missing-native-turn problem patched with an invented local ID. IDs are still synthetic
peer identities, not a recovered native session or authorized provider turn.

The explicit fixture/emit request happens only after actual turn_start returns and
registers its queue. This is a deliberately favorable ordering, not a supported
protocol handshake or a fix for early completion. The previous corrected15-check
client receipt established the early-completion-before-response waiter gap; the new
report explicitly preserves it. Do not merge the favorable observer evidence into a
claim that the SDK handles all response/notification orderings.

## Seven outcomes agree with the receipt

- Valid case has three typed notifications and one completed fake callback with
  exact17input/8output/5cached/3reasoning counters.
- Wrong resume is refused by a **research gate** before turn_start, with zero
  notifications/settlements. This mirrors required existing CR binding but is not
  execution of the full runtime/controller authority path.
- Wrong thread/same turn reaches requested SDK queue, then actual CR observer
  rejects scope and records ambiguity. The SDK is not thread authorization.
- Wrong turn does not reach the requested queue; finite EOF ends the waiter and
  bridge explicitly disconnects the observer into ambiguity. This proves neither
  a SDK wrong-turn rejection nor a built-in timeout; report wording is accurate.
- Late usage is delivered and rejected after observer completion. The receipt
  remains completed with one callback, not retroactively ambiguous. Correctly stated.
- EOF before completion gives two notifications and an ambiguous callback.
- Throwing fake sink records two attempted calls, completed then ambiguous, both
  throwing. There are no durable commits or successful authorizations here.

The Node bridge processes the collected SDK notifications after the Python process
returns. Thus E3 is narrow **data/interface composition**, not an online shared
lifecycle where CR settlement cancels or controls the SDK process. This follows from
the authored source; no end-to-end live settlement claim should be inferred.

## Bounds, provenance and cleanup

The actual invocation uses sterile outer environment and a fixed local Python runtime;
no ambient provider credentials are added through config.env. Existing Python/Pydantic
packages are not transitively audited, appropriately disclosed. Source hash/set checks
occur before import, with module origins checked afterward. The prior receipt pins
are reused consistently; this review did not reacquire cleaned sources.

Direct output says all seven peers reaped; each result confirms peerReaped. Acquisition
receipt records exact-root cleanup, and this review independently confirmed that
`/private/tmp/cr-f2-python-observer.ydPfZz` is absent. No claim about arbitrary spawned
descendants is warranted; the finite authored peer has no child-spawn feature.
Alarm/outer timeout/output bounds are fixture limits, not SDK frame/queue bounds.

Nonblocking reproduction hardening: Python uses assert for source-set/hash checks
and does not explicitly reject every nested symlink before import. Current invocation
does not use -O and acquired files were created exclusively in an owned root, so this
does not invalidate the saved run. Before generalizing this fixture to reused or
externally supplied source trees, use explicit exceptions and reject symlink entries,
following the earlier router fixture's hardened pre-import pattern.

## Comparative disposition

Python/App Server is genuinely closer to the current native observer schema than
the TS exec stream. That advantage does not resolve early ordering, cancellation,
resource bounds or runtime packaging. Keep current direct transport and a deliberate
job-only TS SDK boundary as live alternatives; preserve CR binding, ledger and
uncertainty handling. No final transport selection or source removal approved here.
