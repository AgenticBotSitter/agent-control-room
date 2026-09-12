# Optional OpenClaw and Claude interfaces: pinned source screen

2026-09-08, CR baseline `d87af13`. Source-only follow-up to
`c5-extension-dispositions.md`; no candidate code/tests executed, packages installed,
engine started, credentials inspected or services created. Exact URLs, lengths and
SHA-256 values are in [the acquisition receipt](c5-primary-source-receipt.json).
Root retains final selection and licensing review.

## Decision contribution

OpenClaw and the Python Claude SDK have inspectable lifecycle implementations worth
testing when their optional adapters are requested. Neither is a thin drop-in
replacement for the required Hermes/Codex path. The archived assertion that both
Claude SDKs are MIT is incorrect at these newly inspected pins: Python's root license
is MIT; the TypeScript repository's root license and README expressly refer to
Anthropic Commercial Terms. This does not by itself prohibit all external use, and
no full interpretation of those linked terms or downstream dependencies is claimed.

| Component | Exact inspected identity | Evidence / disposition |
| --- | --- | --- |
| OpenClaw | `openclaw/openclaw@c41d3410d2809d54245eefd6a18844daeccd323b`; package manifest `2026.9.3` | E1 selected gateway lifecycle source and selected test assertions. Optional supported gateway adapter lead; not runtime-qualified. |
| Claude Python SDK | `anthropics/claude-agent-sdk-python@f1315c69a74db1c15fed2e5974918495d90b7d57`; manifest and `_version.py` agree `0.2.152` | E1 selected subprocess/query source and cancellation-test assertions; viable bindings lead, with actual engine remaining separately licensed and unexecuted. |
| Claude Code CLI | `anthropics/claude-code@8e02f6ddce21f4c2585d2be501651c1d6b16246a`; separately resolved npm `@anthropic-ai/claude-code@2.1.265` | Exact public tree/license and package metadata screened, not engine source E1. No engine implementation/test closure found in that repository tree; package contents not downloaded. |
| Claude TypeScript SDK | `anthropics/claude-agent-sdk-typescript@969e1d552badd4f9f9eeda236f523d51c09c0a8d`; separately resolved npm `@anthropic-ai/claude-agent-sdk@0.3.265` | Exact public tree/license/README and package metadata screened, not client implementation E1. Public `src` paths found are session-store examples, not the shipped client. No rejection from absence in this repository alone. |

Repository revisions and separately resolved package versions are **not claimed to
be byte-equivalent builds**. Registry metadata identified immutable versioned
tarball URLs and integrity values but those tarballs were not fetched or verified.
No private/closed engine source is inferred from a public issue/example repository.

## OpenClaw: actual interface, not dashboard resemblance

At the pinned source:

- `src/gateway/server-methods/agent.ts` registers `agent` and `agent.wait`;
  `agent-run-handler.ts` validates parameters, captures principal/run observer,
  performs preflight and calls the shared agent-turn service with admission guards.
- `src/gateway/agent-turn/agent-turn-service.ts` calls session preparation/persistence,
  admission, delivery and execution phases. Imports span session/config mutation,
  skills, media, principal checks and runtime dispatch. This is an existing runtime
  service, not a standalone pure task queue to copy into CR.
- `agent-dedupe.ts::resolveAgentDedupeKeys` keys by caller idempotency ID and optional
  execution-approval follow-up ID. `replayAgentTurnIfCached` returns cached acceptance
  as `in_flight`, including the original run/session identity when present. This
  inspected helper does not compare a CR task-payload digest. That is a mapping
  question, not proof the whole upstream admission path lacks validation.
- `agent-wait.ts` validates parameters and checks authenticated profile/session
  visibility before `waitForTurn`. The actual auth handshake/transport closure was
  not inspected here; source-level visibility logic is not authentication acceptance.
- `agent.test.ts` imports focused test suites. Selected assertions in
  `agent.base.test-utils.ts` cover pending recipient-routing deduplication and cleanup
  after failed routing. `agent.abort-integration.test-utils.ts` covers an accepted
  acknowledgement before heavy work and abort during that gap preventing dispatch;
  its fixture substitutes agent execution. Tests were read in focused excerpts,
  not run or reviewed wholesale. A guessed `agent-wait.test.ts` returned404 and is
  retained as failed discovery, not negative product evidence.

Minimum proposed reuse: external pinned gateway API mapped beneath one CR attempt,
not importing the session/agent scheduler or adopting upstream ACK as task completion.
Map CR attempt/request identity to actual run ID and session identity; preserve
existing approvals, terminal receipts and result review. Before optional support,
test changed-payload same-ID replay, accepted-before-dispatch cancellation,
disconnect/reconnect and completed/unknown wait outputs through the existing CR
adapter boundary. This is a future fit packet, not a new protocol definition.

Runtime cost is concrete: the manifest requires Node `>=24.16.0 <25 || >=26.1.0`,
unlike CR's Node22 baseline. Separate runtime installation is therefore the plausible
initial boundary. Manifest dependencies include native PTY, provider SDKs, MCP,
SQLite-related packages, image/HTML tooling and workspace packages; copying the
whole gateway imports much more than a transport. Full transitive closure was not
resolved. Root MIT license explicitly points to `THIRD_PARTY_NOTICES.md`; that file
records incorporated MIT components and their notices. Neither root MIT nor the
inspected notice file establishes complete distribution clearance.

## Claude Python: useful real lifecycle machinery, not a complete-run guarantee

`_internal/transport/subprocess_cli.py` actually selects a CLI (including a bundled
candidate), builds stream-json command options, handles explicit session/resume/fork
options, launches a subprocess, reads bounded framing and owns child bookkeeping.
It registers active children for shutdown and rejects Windows batch shims rather
than silently invoking `cmd.exe`. It has environment propagation and optional
telemetry hooks: constructing/connecting it is a native effect, not a pure parser.

`_internal/query.py` has actual bidirectional control correlation using request IDs,
pending responses/events, a reader that wakes outstanding requests on error, control
request timeouts and tool permission callbacks. Its task-lifecycle tracker explicitly
documents a remaining ordering limitation: a delegated task may settle before the
turn result while a continuation is still pending. Empty task bookkeeping does not
prove that the whole run ended; the comment says a CLI run-boundary signal is needed.
Do not translate that bookkeeping into CR completion or claim a new custom ledger
would solve it. This is an inspected upstream warning, not a reproduced failure.

`tests/test_close_cancellation.py` uses a synthetic CLI answering version/control
requests; selected assertions require cleanup under an already-cancelled scope.
It differentiates POSIX process-observation tests from a platform-neutral mock test.
Reading these tests does not qualify Windows process trees or real Claude cleanup.

The binding's MIT LICENSE is now directly inspected, correcting the old SBOM's
unverified-file flag. Python>=3.10; declared dependencies are anyio, sniffio,
conditional typing_extensions, MCP and jsonschema, with optional telemetry/examples.
These declarations are ranges, not a resolved license closure. The `_bundled`
directory in the source tree does not supply the engine source/license; no bundled
binary was retrieved. Keep separate installed-engine terms and exact runtime identity.

Optional adoption trigger: a Claude contributor needs these supported control or
permission callbacks. Compare this actual binding against the CLI stream interface
with synthetic peers first, then separately authorize exact native acceptance.
No copying of the query's MCP/tool policy into CR and no automatically granted tools.

## CLI and TypeScript: precise missing-source/terms disposition

The complete Git tree responses for the two selected public repositories report
`truncated:false`. Their selected path inventories contain license/examples rather
than a public CLI engine or SDK client implementation/test tree. This establishes
the scope of these repositories, not that shipped package code is inaccessible
everywhere. A package-file inspection remains a possible later stronger seam.

The CLI and TS LICENSE files have identical hashes and explicitly state all rights
reserved and Commercial Terms applicability. TS README repeats those terms and
allows different licenses for specifically marked components/dependencies. Accordingly
the archive's blanket “SDKs are open/MIT” statement must not justify copying TS code.
This report does not decide what the linked commercial terms permit for a separately
installed runtime or service; exact intended use requires review before selection.

Registry metadata separates platform payloads: CLI2.1.265 lists eight optional
OS/architecture packages and Node>=22; TS SDK0.3.265 likewise lists eight optional
platform packages and Node>=18. Those payloads were not downloaded; no whole-package
dependency/source/license claim follows. The archived2.1.240 auth-blocked CLI result
is historical evidence only and does not qualify these releases.

Result: optional conditional external interfaces, no vendored client/engine choice.
Missing exact shipped implementation and dependency terms is an honest limit, not
permission to treat a README as E1 or fabricate an equivalent client.

## Acquisition limits and cleanup

All requests used15-second deadlines and streamed byte checks. Initial sandbox DNS
failed with zero response bytes. One recursive OpenClaw tree exceeded the2.5MB
per-response limit and was stopped; it was not retried. The check threw before
printing the crossing chunk length/hash, so that partial receipt has unknown exact
bytes. Completed response bodies total862,405 bytes including repeated fetches to
recover truncated tool output. The total was intended to stay within5MiB, but an
exact aggregate measurement cannot be asserted because of that missing partial
counter. No further acquisitions are needed for this bounded screen.

Only hashes/metadata and this report are retained. All retrieval processes exited;
no temporary source root, install, candidate process or service needs deletion.
No tests run; no E2/E3/E4 upgrade. Required Hermes/Codex and C3 reading remain outside
this optional screen and are not deferred by it.
