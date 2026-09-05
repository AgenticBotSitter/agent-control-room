# Overnight build checkpoint — 2026-09-05

Authorized work window: 04:25:09–12:25:09 UTC, stopping earlier only if currently authorized work is complete.
Persistent goal: follow the completion program, implement substantial blocks, test, obtain independent reviews,
fix findings and publish private PRs. Preserve merge/live-effect approvals; no deployment, provisioning,
live credentials or real-agent connection. If one lane needs live permission, continue other authorized code.

## Completed blocks

### CR14B private Node serving

- Accepted runtime: `070a1405a0441ca1225271d6a1d74773df29c3e0`.
- [PR #285](https://github.com/MarvinAi5/control-room/pull/285), stacked on #284; no merge/deployment.
- Bounded Node request/response bridge, inert loopback service, immutable browser-asset snapshot and compiled
  authenticated SQL integration. See `CR14B_PRIVATE_SERVING_ACCEPTANCE.md`.
- Independent review: initial 1 Medium/3 Low corrected; re-review accepted with zero remaining findings.
- Final local checks: 115 focused; 769 pretests; 540 main passes/2 existing skips; 392 posttests; 7 private
  and 4 Sites compiled/rendered checks; TypeScript/full lint/whitespace; 127-table migrations.
- No listener, real database, credentials, provider/agent, browser, DNS/IdP or deployment effect occurred.
- Exact documentation head `e327c3c` passed GitHub CI run `33946020421` at 05:14:07 UTC.

### CR14B SQL/application database rehearsal tooling

- Accepted runtime: `7c52ad3ea88255a9ec6faccadea69eb9af66162d`.
- [PR #286](https://github.com/MarvinAi5/control-room/pull/286), stacked on #285; no merge/deployment.
- Single-use prepared-packet runner, fixed synthetic application/SQL checks, two bounded native probe
  adapters, planned pool reopen, cancellation/cleanup and sanitized evidence. Server-only inert compiled entry.
- Initial 1 Medium/2 Low corrected; independent re-review accepted with zero remaining findings.
- Final checks: 133 focused; 769 pretests; 558 main passes/2 existing skips; 392 posttests; 8 private and
  4 Sites artifact checks; both builds; TypeScript/full lint/whitespace; migrations0001–0040/127 tables.
- No actual PostgreSQL, listener, credentials, agent/provider, browser, setup, deployment or merge effects.
- Idle close cause and physical connection attempts remain unavailable/unobserved. Pool reopen is not OS
  restart; exact operator DB/role cleanup and real-session absence proof are still separate.
- Exact documentation head `78a6a98` passed GitHub CI run `33948058630` at 06:00:47 UTC.

### CR14B disposable fixture/preparation handoff

- Accepted runtime: `fd8b2736a806735dc07ada577df31967c573a96b`.
- [PR #287](https://github.com/MarvinAi5/control-room/pull/287), stacked on #286; current-head CI remains required.
- Separate server-only operator entry, existing empty DB/schema/role checks, one joined synthetic seed
  transaction and fresh one-use private test material. No installation, migration, role change or live setup.
- Independent review: zero High/Medium/Low findings, 28 preparation/rehearsal checks passed independently.
- Final checks: 152 focused; 769 pretests; 577 main passes/two existing skips; 392 posttests; nine private/four
  Sites artifact checks; both builds; TypeScript/full lint/whitespace; migrations0001–0040/127 tables.
- No actual PostgreSQL, listener, credentials, agent/provider, browser, provisioning, deployment or merge.
- Native preparation/rehearsal and operator cleanup still require their own explicit scoped authority.
- Exact documentation head `dfc1f36` passed GitHub CI run `33949755377` at 06:39:19 UTC.

### CR14C supported Hermes native-run adapter

- Accepted runtime: `4b5fb69d8386cdf859ba22079aef3e7771f45f18`.
- [PR #288](https://github.com/MarvinAi5/control-room/pull/288), branch `codex/cr14c-hermes-native-run-adapter`,
  stacked on #287; current-head CI remains required. No merge or runtime activation.
- Durable node-private run journal; pinned capability/session mapping; bounded outbound HTTPS and progress;
  exact-ID cancellation and status recovery. No core fork, personal profile cloning or application activation.
- Initial two Medium timing findings corrected; independent re-review accepted with zero remaining findings.
- Final checks: 47 focused, 152 private-app regressions, 769 pretests, 624 main passes/two existing skips,
  392 posttests; both builds; nine private/four Sites checks; TypeScript/full lint/whitespace. Unchanged
  migrations0001–0040/127 tables also verified. Review independently ran all 47 focused checks.
- No real network connection, credentials, listener, agent/provider, native profile, provisioning, deployment
  or merge. File persistence used an exact test-owned disposable directory with cleanup.
- Hard cost/deadline enforcement, private HTTPS topology and installed-host qualification remain specific
  live gates. Canonical task/result/review integration is the next substantial repository block.

- Exact documentation head `fc199dd` passed GitHub CI run `33952565284` at 07:41:30 UTC.

### CR14C canonical native progress delivery

- Accepted runtime: `f7d0c1115e0b3a321b3c9c9b6ee6efced83122eb`; private publication tracked in build status.
- Native adapter snapshot -> durable node outbox -> signed protocol -> authenticated canonical harness
  evidence. Per-run acknowledgement ordering and reconnect recovery never restart native work.
- Initial two Medium/two Low findings corrected; independent re-review accepted with no remaining findings,
  independently running 51 tests plus type/whitespace checks.
- Final checks: 74 focused, 769 pretests, 651 main passes/two existing skips, 392 posttests; both builds;
  nine private/four Sites checks; TypeScript/full lint/whitespace. Unchanged 127-table migrations verified.
- No real network/agent/database, credentials, listener, deployment or merge. Registration and snapshots
  do not mutate canonical job completion, approvals or effect/artifact authority.
- Private task/result UI, task admission/dispatch, verified artifact transfer and owner review remain.

## Next authorized repository work

1. Continue C-WORK: canonical project task/attempt, admission/effect integration, native lifecycle/usage mapping
   and result/review wiring. The native adapter component is accepted but not active. No real agent qualification tonight.
2. B's live setup/pilot remains a separate gate; continue other settled UI/digest lanes if a particular live
   prerequisite blocks integration. Existing worker capsules remain undispatched drafts.
3. Keep accepted code in feature branches/private PRs; preserve dependency-order/current-CI/merge approval.

Current setting: Astra Xhigh. No owner model change is needed for the next architecture/integration block.
Actual private PostgreSQL preparation, IdP/MFA/hostname/ingress, browser acceptance and live agent runs remain
explicit later gates. The work-computer alias still requires employer approval. A tested component is not a
running beta; report concrete live blockers without converting simulator evidence into a pass.
