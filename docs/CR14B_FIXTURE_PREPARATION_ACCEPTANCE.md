# CR14B fixture preparation — repository acceptance

Date: 2026-09-05. Architect: Codex, Astra Xhigh.

**Accepted implementation:** `fd8b2736a806735dc07ada577df31967c573a96b`.
**Tree:** `a6cf590e7c4ff73b57409a700414a55177091c86`.
**Base:** `78a6a983b70ccec28f5f1d79787d1e175e345909` (database rehearsal PR #286).

The separate operator entry now prepares the synthetic data needed by the reviewed database rehearsal.
It requires an existing dedicated empty database and a distinct migrator, locks/checks the schema and all
127 public tables, uses one joined transaction and supplies fresh private test material once in memory only
after acknowledged commit and successful owned-client shutdown. It neither provisions nor runs on import.
See `CR14B_FIXTURE_PREPARATION_CONTRACT.md` for exact bounds and remaining operator requirements.

Independent review in `reviews/CR14B_FIXTURE_PREPARATION_REVIEW_2026_09_05.md` accepted the exact product
with zero High, Medium or Low findings. It independently ran stage zero and 28 preparation/rehearsal tests.
This follow-up acceptance/status commit changes documentation only, not the reviewed runtime.

## Architect verification

- Stage zero: ready, Node minimum and pnpm 11.19.0 satisfied; no install/lockfile change.
- New preparation tests: 19/19; full CR14B focused set: 152/152.
- Repository pretests: 769/769; main: 579 total, 577 passed/two existing Windows-only skips; posttests: 392/392.
- TypeScript `--noEmit`, full repository lint and whitespace checks: pass.
- VPS build and final compiled private artifact tests: 9/9, including inert preparation import.
- Preserved Sites build and rendered route checks: 4/4.
- PGlite migrations 0001–0040: 127 tables verified.

These include one-transaction seed/handoff, occupied and changed-schema/login refusal, failure/cancel/deadline,
lost commit acknowledgement without replay, failed shutdown, expired/one-use handoff, fresh keys, and generated
fixture material feeding the complete reviewed synthetic SQL journey. Tests never connect to a real service.

## Remaining acceptance boundaries

PGlite's one-session/database-name/TEMP and session-identity limitations are explicit in the test helper.
No real PostgreSQL concurrency/ACLs, physical connection/session absence, owner credentials, real agent,
listener, browser, provisioning, deployment or merge was exercised. Client shutdown is not server absence;
acknowledged fixture counts are not proof of emptiness after uncertainty. Exact database/role cleanup remains
operator-owned. `realPostgresAccepted` stays false, including the native result type.

Repository fixture/preparation handoff is complete. Real B-DB-PREP/B-DB-REHEARSE, IdP/MFA/ingress, listener/browser,
backup/restore and B-PILOT remain separately authorized work. Continue unblocked **CR14C native-run adapter and
task/result integration** next, keeping Astra Xhigh for its boundary work. Do not restart the disabled custom
loopback qualification program or silently accept an installed Hermes runtime.
