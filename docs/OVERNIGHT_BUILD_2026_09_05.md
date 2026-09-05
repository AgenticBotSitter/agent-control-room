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

## Next authorized repository work

1. Continue C-ADAPTER/C-WORK: pinned upstream native-run capability/profile/session mapping, bounded lifecycle,
   event/usage truth and task/result wiring. No real agent connection or native qualification tonight.
2. B's live setup/pilot remains a separate gate; continue other settled UI/digest lanes if a particular live
   prerequisite blocks integration. Existing worker capsules remain undispatched drafts.
3. Keep accepted code in feature branches/private PRs; preserve dependency-order/current-CI/merge approval.

Current setting: Astra Xhigh. No owner model change is needed for the next architecture/integration block.
Actual private PostgreSQL preparation, IdP/MFA/hostname/ingress, browser acceptance and live agent runs remain
explicit later gates. The work-computer alias still requires employer approval. A tested component is not a
running beta; report concrete live blockers without converting simulator evidence into a pass.
