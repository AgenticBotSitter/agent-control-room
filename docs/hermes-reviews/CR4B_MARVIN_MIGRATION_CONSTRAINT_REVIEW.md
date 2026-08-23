# CR-4B migration constraint review — Marvin qualification evidence

Work packet: **CR-4B** · Task class: **qualification** · Risk: **low** · Evidence report only — no SQL, TypeScript, tests, or documentation were modified.

## Review metadata

| Field | Value |
|---|---|
| Worker route | Marvin / Mac mini / Hermes (model routed as "Qwen 3.8 27B / provisional" per work packet; actual inference harness recorded below for honesty) |
| Harness | Hermes Agent (Telegram session), operator tools: git 2.50.1, pnpm 11.19.0, node v22.22.3, GitHub REST API via stored credentials |
| Machine | Alastair's Mac mini (Marvin's host), macOS 26.6.2 |
| Review time | 2026-08-22, ~19:30–20:30 MDT (single session) |
| Inputs | `db/migrations/0003_canonical_domain_delivery.sql` (342 lines) compared against `docs/CR4A_DOMAIN_CONTRACT.md`, `docs/CR3_DATA_DURABILITY_AND_RECOVERY.md`; supporting context: `docs/CR4B_TRANSACTION_DESIGN.md`, `docs/MIGRATIONS.md`, `src/persistence/canonical-store.ts`, `src/persistence/delivery-store.ts`, `db/migrations/000{1,2}_*.sql` |
| Repo state reviewed | `main` @ `7ca6573` ("Implement CR-4B transactional persistence") |

## Assumptions

1. The `sha256:` lowercase RFC 8785 digest convention (CR-4A §Authority ordering) applies to every column named `*_digest` / `content_hash`.
2. Canonical-domain `project_id` columns are intended to share the id space of the CR-0/1 `projects` table unless the build team documents otherwise (finding L-1 treats this as a question, not a defect).
3. "Run no live migrations" interpreted as: no migration executed against any real or shared database. The repo's own isolated PGlite verifier (`pnpm db:verify`) and unit tests were run locally as read-only-style evidence; they touch no external system.
4. Findings cite the SQL as of `7ca6573`; line numbers refer to `0003_canonical_domain_delivery.sql`.

## Commands used

```bash
git clone https://github.com/MarvinAi5/control-room.git && git log --oneline   # sweep + pin commit
# duplicate sweep: API list of all PRs (open+closed) → none touch CR4B/migration review
pnpm install --frozen-lockfile
pnpm run db:verify        # applied 0001, 0002, 0003; verified 40 PostgreSQL tables (isolated PGlite)
pnpm test                 # 27 tests, 27 pass, 0 fail
pnpm run check            # tsc --noEmit, clean
```

Static reading of migration 0003 against both contracts; repository code consulted only to determine whether a declarative gap is compensated transactionally (it is cited as evidence, not modified).

---

## Severity scale

- **High** — can produce incorrect authority/scheduling decisions or silent cross-tenant interference; fix before production data.
- **Medium** — weakens a stated CR-3/CR-4A guarantee; exploit or degrade requires unusual conditions; schedule before CR-4C/4D.
- **Low** — hygiene, documentation, or future-operational risk.

---

## Findings

### H-1 · Approvals: no binding, uniqueness, or consumption enforcement

**File/table:** `control_approvals` (L130–141), `control_effect_intents.approval_id` (L148, FK L161)

**Invariant (CR-4A):** "Approval | Decision bound to one operation digest, scope, actor class, and expiry"; "Approval applies only to its exact operation digest and cannot broaden the job authority envelope." CR-3 lists *"Was this approval consumed?"* as one of the questions demanding a single authority answer.

**Gap:** `control_approvals` has no uniqueness over `(tenant_id, operation_digest)` in a live state, no link forcing an effect intent that requires approval to cite exactly one approval, and no consumed/spent marker. Nothing declaratively prevents:

- two `approved` rows for the same `operation_digest` (double authorization paths);
- one long-lived `approved` row being cited by unlimited effect intents (replay of a single human decision);
- an `expired`/`revoked` approval still referenced by an `executing` intent.

**Failure scenario:** An operator approves effect E once. Two intents referencing the same approval execute E twice; or after revocation a third intent still cites the revoked row and proceeds, because no constraint or trigger notices.

**Recommended change/test:** Partial unique index `ON control_approvals(tenant_id, operation_digest) WHERE state IN ('pending','approved')`; plus a transactional consume step in the repository (approval transitions to a spent/expired state in the same transaction that moves the intent past `authorized`). Test: second intent citing the same approval in a concurrent transaction must block or fail; intent citing a revoked approval must be rejected.

**Enforcement:** Hybrid — uniqueness is declarative; consumption is inherently multi-record and must remain transactional.

### H-2 · Lease epoch uniqueness is not tenant-scoped

**File/table:** `control_leases` L104 `UNIQUE (job_id, epoch)`; same class: `uq_control_leases_one_active_job` L111–112 (job-scoped, unscoped by tenant), `control_attempts` L83, `control_checkpoints` L126.

**Invariant:** CR-4B doc: "Relational foreign keys include `tenant_id`, preventing an entity in one tenant from citing lineage in another even when an ID is known." Every other lineage key in 0003 is tenant-prefixed; these three are not.

**Failure scenario:** Job ids are globally unique primary keys today, so collisions require id reuse across tenants (restore-from-backup merge, id-allocation bug, future sharding). At that point a tenant-B claim computes `next_epoch = max(epoch)+1` against a tenant-A lease row and inserts a colliding `(job_id, epoch)` — the claim dies with a raw unique violation (scheduler outage for that job), or the partial active-lease index hides a foreign tenant's active lease. The failure mode is a cross-tenant availability bug, which is exactly what the tenant-scoping rule exists to prevent.

**Recommended change/test:** `UNIQUE (tenant_id, job_id, epoch)`; optionally re-key the partial index as `(tenant_id, job_id) WHERE state='active'`. Existing concurrency test (`only one concurrent claimant…`) already covers behavior; add a cross-tenant isolation case.

**Enforcement:** Declarative (index definition change only).

### M-1 · Digest and hash columns accept arbitrary text

**File/table:** `control_workflows.definition_digest` (L32), `control_jobs.authority_digest` (L51), `control_checkpoints.payload_digest` (L121), `control_approvals.operation_digest` (L133), `control_effect_intents.operation_digest` (L149), `control_artifact_manifests.content_hash` (L211), `control_inbox.body_digest` (L248), `control_idempotency.request_digest` (L281).

**Invariant:** CR-4A: "All `sha256:` fields are lowercase SHA-256 … serialized with RFC 8785"; "CR-4B/CR-4C must verify rather than trust caller-supplied digests at their boundaries."

**Gap:** None of these columns carries a format CHECK. The database — the last line of defense — happily stores `"md5:abc"` or empty-string-adjacent garbage, and any later comparison logic that assumes the canonical form silently misbehaves. TS validators enforce the format only for records that pass through them; direct SQL and future adapters bypass that.

**Failure scenario:** A compromised or buggy writer stores a non-canonical `payload_digest` for a checkpoint; verification later compares canonical digests against it and either always-rejects (checkpoint loop) or is patched to "normalize," defeating the tamper-evidence property.

**Recommended change/test:** `CHECK (definition_digest ~ '^sha256:[0-9a-f]{64}$')` (same shape for each digest column; agree the exact regex once, including whether `content_hash` uses the same scheme). Test: insert with malformed digest must fail.

**Enforcement:** Declarative.

### M-2 · Checkpoint ordering is unique but not monotonic

**File/table:** `control_checkpoints` L118 `sequence integer CHECK (sequence >= 0)`, L126 `UNIQUE (attempt_id, sequence)`.

**Invariant:** CR-4A: "`(attempt_id, checkpoint_sequence)` is unique and sequences never decrease."

**Gap:** Uniqueness prevents duplicate sequence numbers, but nothing enforces that a new checkpoint's sequence exceeds the attempt's current maximum — insert order is unconstrained, so a resumed/replayed writer can insert sequence 3 after 5, producing an out-of-order durable history that resume logic may replay incorrectly. Gaps are presumably acceptable (retry of a rejected declaration) and are not flagged.

**Failure scenario:** After a crash, a node resubmits checkpoints 4 and 6 where 6 was already stored; a naive writer inserts 4 afterward. Recovery replays 4 after 6 and corrupts resumed state.

**Recommended change/test:** Either a small `BEFORE INSERT` trigger raising when `NEW.sequence <= (SELECT max(sequence) FROM control_checkpoints WHERE attempt_id = NEW.attempt_id)` (accepting the write-in-order contract), or an explicit documented transactional guarantee in the repository plus a regression test proving out-of-order inserts are rejected at that layer.

**Enforcement:** Trigger (quasi-declarative) or strictly transactional — state your choice; today it is neither.

### M-3 · Transition history: append-only is trigger-deep only; fabricated history and TRUNCATE pass through

**File/table:** `control_transition_events` L224–242, append-only trigger L339–342.

**Invariant:** CR-3: "append-only event, command, outcome, and audit records"; CR-4A universal rules 1–7 (expected version + state, edge membership, single increment, receipt, reject-unrecognized).

**Gaps:**

1. The append-only trigger blocks `UPDATE`/`DELETE` but not `TRUNCATE` (row-level `BEFORE` triggers do not fire for `TRUNCATE`) and not privileged drops of the trigger itself. One statement erases the audit spine.
2. `from_state`/`to_state` are free text with no relationship to the live entity row: an inserted event claiming `succeeded → ready` on a job that never left `proposed` is stored faithfully forever. Legality of transitions is enforced only inside `transitionWith()` within the caller's transaction.
3. There is no FK to the entity (impossible generically across 13 kinds) — accepted, but it means history↔entity consistency is unverifiable by schema alone.

**Explicit transactional statement:** State-machine legality and history fidelity **must remain transactional rather than declarative** — a CHECK/trigger cannot see the concurrent entity row safely, and CR-4A deliberately keeps the executable transition table in TypeScript. What the schema *can* add: `REVOKE TRUNCATE ON control_transition_events FROM application roles` (roles land in CR-4C — record this as a gate), plus a periodic reconciliation query asserting the latest event per entity matches the entity's `state`/`version`.

**Failure scenario:** A future maintenance script runs `TRUNCATE control_transition_events` to "clean up"; idempotency keys vanish, so replays of old mutations re-execute instead of returning receipts.

**Recommended test:** Reconciliation query returns zero rows after a normal workload; `TRUNCATE` as the application role fails once roles exist.

### M-4 · Payload-mirror trigger: narrow coverage and a brittle cast

**File/table:** `validate_control_payload_mirror()` L297–310; triggers L312–337.

**Gaps:**

1. It compares only `id`, `tenantId`, `state`, `version`. Every table mirrors more indexed columns in the payload (job: `workflow_id`, `priority`, `required_capability`, `authority_digest`; attempt: `job_id`, `attempt_number`, `lease_epoch`; lease: `epoch`, `expires_at`; effect intent: `operation_digest`, `destination`, `idempotency_key`). Payload/extras drift on those fields is invisible — e.g. a direct-SQL writer can bump the indexed `epoch` while the payload still records the old one, and lease-lineage checks reading the payload (as `renewLease` does) act on stale facts.
2. `(NEW.payload->>'version')::integer` on a non-numeric JSON value raises an unhandled `22P02` invalid-text-representation error instead of a diagnosable mirror-mismatch exception — same outcome (write rejected) but poor operability during incident triage.

**Failure scenario:** Operator debug-writes a corrected `attempt_number` into the indexed column only; mirror passes; downstream `max(attempt_number)+1` allocation now disagrees with the attempt payloads it reads.

**Recommended change/test:** Extend the function per-kind (or compare a fixed superset: any column mirrored in payload) and wrap the cast in an exception block that re-raises the mirror-mismatch message. Tests exist for the happy path; add mismatch cases for the extended columns.

**Enforcement:** Declarative (trigger hardening).

### M-5 · Invariants that must remain transactional — enumerate and test them as such

The following CR-4A cross-record guarantees are correctly *absent* from 0003 and should stay absent, but the repo nowhere says so, which invites someone to "fix" them with a bogus trigger later. Each needs an explicit transactional home and a named test:

1. **At most one active lease per job, with monotonic epoch, allocated atomically** — sound today only because `claimReadyJob` locks the job row (`SELECT … FOR UPDATE`) before computing `max(attempt_number)+1` / `max(epoch)+1` (canonical-store.ts L194, L207–212). The `max()+1` pattern is safe *exclusively* under that lock; the partial unique index is the backstop. Covered by the concurrency test — keep it pinned.
2. **Acyclic dependency graph** (edge guard `proposed → ready`) — a DAG is not expressible as a PostgreSQL constraint; the runtime check counts unsucceeded dependencies (canonical-store.ts L416–425) but cycle detection happens only at compile time. A cycle written by direct SQL simply never readies. Requires a compile-time test plus a documented "dependencies must pre-exist" rule (already in CR-4B doc).
3. **Old-epoch lifecycle events cannot complete a job** — expiry/renewal compare `lease.epoch === input.epoch` inside the transaction (L281, L333). Declaratively inexpressible; needs a stale-epoch rejection test (partially present: `/stale state, epoch, or version/`).
4. **Effect-intent approval gating** — "an intent requiring approval carries an unexpired approval whose `operation_digest` matches" spans three tables plus wall-clock time; must be transactional in CR-4C's authorization path. Today nothing even documents it (see H-1).
5. **Renewal must extend expiry** — compares against the prior row value; necessarily procedural. Already implemented and tested (L337).

**Recommendation:** Add a short "transactional-by-design invariants" subsection to `docs/MIGRATIONS.md` listing these five, each with its owning repository method and test name. Documentation-only follow-up.

### M-6 · Authority containment is validated, but the DB stores only the child's self-declared digest

**File/table:** `control_jobs.authority_digest` (L51), payload `authority.parentDigest` (validators.ts L62).

**Invariant:** CR-4A: "Child authority must be a strict subset of or equal to its parent and must cite the parent digest"; "The child cites the exact parent digest so comparison cannot silently use a newer envelope."

**Gap/status:** Subset comparison lives in `src/domain/v1/authority.ts` (in-process, correct per CR-4A boundary), and 0003 rightly does not attempt it in SQL. However, nothing persists the *parent* envelope alongside the child — if the parent job's authority is later mutated through its own legitimate transition, the historical containment proof becomes unreproducible from the database alone. CR-3 requires audit/decision history to survive restore-and-verify.

**Recommended change/test:** Ensure the transition event's `safe_metadata` (or the authority-bearing payload itself) captures the parent digest at bind time — appears partially true via payload immutability-per-version, but verify with a test that a parent-authority change leaves the child's cited digest verifiable against stored history.

**Enforcement:** Transactional/persistence-design; explicitly not declarative.

### L-1 · `project_id` columns are unconstrained free text while a `projects` table exists

**File/table:** `control_requests.project_id` (L16, nullable), `control_workflows` (L31), `control_jobs` (L46), `control_services` (L167), `control_schedules` (L179), `control_artifact_manifests` (L207), `control_incidents.project_id` (L192, nullable).

**Observation:** Migration 0001 ships a concrete `projects` table, yet no 0003 canonical record references it — not even the NOT NULL cases. Artifact lineage (CR-4A: "Artifact lineage must resolve to its producing project/job/attempt") resolves strongly to job/attempt via composite FKs but only lexically to project. This may be a deliberate decoupling (adapter-projected projects vs. native canonical projects with different id spaces) — if so it is undocumented.

**Failure scenario:** A typo'd `project_id` fragments lineage queries; dashboards silently filter artifacts out of a project view.

**Recommended change/test:** Either document the id-space decision in `docs/MIGRATIONS.md`, or add `FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id)` where the spaces genuinely coincide (requires adding `UNIQUE (tenant_id, id)` to `projects` — it currently has only `UNIQUE (adapter_id, source_record_id)` and a bare PK).

**Enforcement:** Declarative if id spaces coincide; otherwise documentation.

### L-2 · No declarative timestamp sanity on 0003 tables

**File/table:** all 0003 entities (`created_at`/`updated_at` L8–9 et al.).

**Observation:** Domain validators enforce `updatedAt >= createdAt`; the database enforces nothing. Most 0003 tables also omit `DEFAULT now()`, unlike the inbox/outbox/idempotency tables — two conventions in one migration.

**Recommended change/test:** `CHECK (updated_at >= created_at)` everywhere; align DEFAULT policy (explicit values from the repository are fine — pick one rule and write it down).

**Enforcement:** Declarative.

### L-3 · Delivery tables have no bounded-retention story

**File/table:** `control_outbox` (delivered rows retained forever), `control_idempotency` (`result jsonb` retained forever), `control_inbox` (processed rows retained forever).

**Observation:** CR-3 promises "bounded" evidence journals for nodes and careful storage economics, and CR-4B correctly keeps `dead_letter` from auto-reclaiming — but nothing plans pruning for the successfully-delivered/terminal majority. At orchestration volumes (every mutation writes a transition event *and* an outbox row) these tables dominate growth.

**Failure scenario:** Twelve months in, the outbox is hundreds of millions of rows; vacuum/backup windows balloon; the first prune attempt is written under pressure without tests.

**Recommended change/test:** Document a retention rule (e.g., delete `delivered` after N days via batched delete; tombstone idempotency keys for a longer window) in `docs/MIGRATIONS.md`, and schedule its migration/test before production deployment.

**Enforcement:** Operational/documentation.

### L-4 · Re-runnable DDL races under concurrent verification

**File/table:** `CREATE OR REPLACE FUNCTION` L297, `DROP TRIGGER IF EXISTS … CREATE TRIGGER` pairs throughout.

**Observation:** The pattern makes the migration re-runnable (nice for PGlite verification) but two concurrent `db:verify` runs can interleave drop/create and fail spuriously. Development-only concern; production migrations run once under a single migration role (CR-3).

**Recommended change/test:** None required now; note single-runner expectation in `docs/MIGRATIONS.md`.

**Enforcement:** Documentation.

---

## PGlite ↔ PostgreSQL compatibility

**Verdict: compatible, with rehearsal still mandatory (agreeing with `docs/MIGRATIONS.md`).**

Verified by execution, not inspection alone: `pnpm db:verify` applied all three migrations to isolated PGlite and confirmed the expected 40-table set; the 27-test suite (including concurrent-claim, replay, and outbox claim/recovery cases) passes against it. Features relied upon — partial unique indexes, composite FKs, plpgsql triggers, `jsonb`, `timestamptz`, CTE-UPDATE with `FOR UPDATE SKIP LOCKED` — are common-subset PostgreSQL. No extensions are used. Known divergences to watch at CR-5 rehearsal: concurrent-write behavior under real `max_connections` pressure, trigger-error surfacing (M-4's `22P02`), and lock-timeout tuning, none observable on single-connection PGlite.

---

## Coverage matrix (issue acceptance checks)

| Required topic | Verdict | Where |
|---|---|---|
| Tenant scoping | Sound overall; scoping exceptions found | H-2, L-1 |
| Foreign keys | Comprehensive composite lineage; project_id lexical only | L-1 |
| Uniqueness | Idempotency uniques match contract; lease epoch mis-scoped | H-2, M-1 |
| Active-lease exclusion | Correct partial index; tenant-prefix gap noted | H-2, M-5.1 |
| Monotonic attempts and epochs | Enforced jointly by unique constraints + transactional allocation; correct, lock-discipline-dependent | M-5.1 |
| Checkpoint ordering | Unique but not monotonic | M-2 |
| Effect idempotency | Unique key matches CR-4A; digest format unchecked | M-1 |
| Artifact lineage | Strong job/attempt FKs; content hash format unchecked; project lexical | M-1, L-1 |
| Append-only transition history | Present; TRUNCATE/fabrication gaps; reconciliation needed | M-3 |
| Inbox/outbox/idempotency records | Design matches CR-4B doc (verified against `delivery-store.ts`); retention unbounded | L-3 |
| Terminal-state limitations | Not declaratively enforceable — FSM legality is transactional by design; stated explicitly | M-3, M-5 |
| PGlite vs PostgreSQL compatibility | Compatible; verified by `db:verify` + full test run | Compatibility section |

Every finding above includes severity, exact location, failure scenario, and a recommended test or change; transactional-versus-declarative classification is stated per finding.

---

## Checked and found sound (no action)

- Composite tenant-bound FKs on requests/workflows/jobs/attempts/leases/checkpoints/effect intents/artifact manifests — matches CR-4B doc claim.
- `CHECK (to_version = from_version + 1)` and `CHECK (from_state <> to_state)` on transition events; `entity_kind` whitelist.
- Optimistic-concurrency shape: every transition update predicates on `version AND state`, failing closed (`RETURNING` count check).
- Outbox claim token + `SKIP LOCKED` + `dead_letter` floor + stale-claim recovery — coherent with CR-3's "outbox resumes without duplicate consequential delivery."
- Inbox replay semantics: same-digest replay short-circuits, differing digest under a reused message id hard-fails — exactly CR-4B §Inbox.
- Attempt numbers increase monotonically per job under the documented claim transaction (concurrency test green).
- All 0003 tenant FKs `ON DELETE RESTRICT` — no accidental cascade across tenants.

Adjacent observation outside this packet's allowed scope (recorded for the maintainers, no file touched): in `0001_control_room_core.sql`, `worker_runtimes.machine_id REFERENCES machine_nodes(id)` is not tenant-composite, permitting cross-tenant machine citation — same class as H-2.

---

## Reviewer disposition

Codex/Sol semantic review required before merge, per work packet. This report changes no behavior; the only disposition options are Accepted / Accepted with follow-up (findings feeding CR-4C planning) / Changes requested (report defects).
