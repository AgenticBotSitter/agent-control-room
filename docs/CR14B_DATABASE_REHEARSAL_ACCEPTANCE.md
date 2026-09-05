# CR14B database rehearsal tooling acceptance

Date: 2026-09-05. **Accepted for repository implementation and injected/disposable SQL tests only.**

- Base: `e327c3c7be75ef9489316e2f9fb561ada5929764` (PR #285).
- Rejected initial candidate: `8070faed08baa425ca88a3d2136b8dbfa22717da`.
- Accepted runtime: `7c52ad3ea88255a9ec6faccadea69eb9af66162d`.
- Tree: `7de613ba8be83ffea3292012bdda8e1e2fce3710`.
- Branch: `codex/cr14b-private-database-rehearsal`.
- Publication: [PR #286](https://github.com/MarvinAi5/control-room/pull/286), stacked on #285; not merged.

## Delivered

One fixed, single-use operator workload uses the actual private application services and bounded database
pool. It validates a separately approved preparation packet, real production preflight and a synthetic fixture
before writes. It creates/replays/pauses/reads a project, checks two immutable command/audit effects, reads
the Idea catalog and current synthetic connection signal, exercises restricted columns and bounded database
operations, drains, reopens the pool once, reconciles receipts and revokes the synthetic session.

Two reserved native probe sessions observe SQLSTATE-specific lock/statement/transaction limits. Idle-session
disappearance is explicitly not an exact timeout-cause claim. Fixed error sanitization, single-use execution,
cancellation fencing and exactly-once owned-client cleanup preserve uncertainty without automatic replay.
The built `rehearsal.js` entry is separate and inert; nothing mounts it in a web route, scheduler or service.
See `CR14B_DATABASE_REHEARSAL_CONTRACT.md` for actual bounds and evidence semantics.

## Observed checks

| Check | Result |
|---|---|
| macOS stage zero | Ready; no install |
| Final focused CR14B | 133/133 passed |
| Full pretest | 769/769 passed |
| Full main | 560 total, 558 passed, 2 existing Windows-only skips |
| Full posttest | 392/392 passed |
| TypeScript, full lint, whitespace | Passed |
| Private VPS build and compiled checks | Passed; 8/8 |
| Preserved Sites build and rendered checks | Passed; 4/4 |
| Disposable PGlite migrations | 0001–0040; 127 tables |
| Independent remediation re-review | 18/18; no remaining findings |

Full lifecycle scripts ran with installed Node/tsx. Focused counts overlap. The private artifact and full
test lifecycle were rebuilt/rerun after correction. Sites/migrations passed before the isolated rehearsal
evidence correction, which does not change their consumers/schema. Existing build warnings are nonblocking.
Current-head GitHub CI is separate and remains required; publication does not imply a merge.

The lost-acknowledgement test commits one synthetic command in PGlite, injects acknowledgement loss and
verifies the runner stops without replay or planned reopen. This is injected failure evidence, not a real
network-disruption test. PGlite metadata and connection timing remain explicitly injected test limitations.

## Review and outstanding effects

Preserve the initial one Medium/two Low rejection and accepted correction in
`reviews/CR14B_DATABASE_REHEARSAL_*`. The corrections distinguish observations from inferred timeout/physical
connection claims and reject a configured-but-missing signal. No live failure was concealed or relabeled.

No real PostgreSQL service, physical listener, credential, agent/provider, browser, native qualification,
provisioning, deployment or merge occurred. Owned-client shutdown is not independent proof of every backend's
absence. The runner does not delete any database/role/service. Physical attempts and idle close cause are
explicitly unobserved/unavailable. Setup, fixture preparation, exact operator cleanup, actual process restart,
backup/restore and physical ingress retain their named gates. B-WIRE/B-PILOT and CR14G remain incomplete.

**Next repository block:** CR14B disposable fixture/preparation handoff, Astra Xhigh. Make the synthetic
fixture and exact operator preparation repeatable without installing/provisioning/running it. Then continue
unblocked CR14C adapter/task integration while real host, identity and deployment choices await the owner.
