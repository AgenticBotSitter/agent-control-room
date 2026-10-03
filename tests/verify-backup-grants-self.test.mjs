// R5B-08: A BACKUP THAT PREDATES A ROLE FILE STILL VERIFIES.
//
// MEASURED FAILURE THIS LANE REPRODUCES.
// `scripts/ops/verify-database-backup.mjs` compared the RESTORED database's grant
// catalogue with `readDesiredMacGrantsV1()` — TODAY's checkout's list — and
// threw `database_backup_mac_grants_refused` on any difference. So a database
// provisioned without the newest role file (`agent_reviewer_roles.sql`, added
// since `main`) backed up perfectly and verification reported FAIL, listing three
// grants "missing" that the restored copy had and the SOURCE also had, exactly.
// `docs/BACKUP_AND_RESTORE.md` tells the owner to treat FAIL as a recovery
// incident, so adding one role file made every earlier backup look like a loss.
//
// WHAT IS ALREADY PROVEN, and why this lane does not re-prove it. By the time the
// grant comparison runs, the restore has been verified field by field against the
// backup's own recorded identity — `ownersDigest` is `digestOf(evidence.grants)`,
// the SOURCE's grant rows from the backup's own SERIALIZABLE snapshot, recomputed
// from the restored catalogue and compared by `verifyRestoredIdentity`. So
// "does this backup restore to what it recorded" is answered against itself. That
// is the comparison R5B-08 asks for.
//
// WHAT THIS LANE PINS. The remaining comparison against today's list becomes a
// NAMED, NON-FAILING note; the strict form stays callable; and neither of those
// is allowed to become "always true", which would be the opposite defect.
import assert from "node:assert/strict";
import test from "node:test";
import {
  judgeRestoredMacGrantsV1, macGrantsMatchCurrentReleaseV1,
} from "../scripts/ops/verify-database-backup.mjs";
import { diffMacGrantsV1, readDesiredMacGrantsV1 } from "../scripts/mac-local/database-upgrade-grants.mjs";

const COORDINATOR = "control_room_task_coordinator";
const QUEUE = "control_room_queue";
const QUEUE_SELECT = `${COORDINATOR}|table|${QUEUE}.queue||SELECT|plain`;
const QUEUE_USAGE = `${COORDINATOR}|schema|${QUEUE}||USAGE|plain`;
const REVIEWER_USAGE = "control_room_agent_reviewer|schema|public||USAGE|plain";

test("a backup whose grants match the current release verifies with no note", () => {
  const restored = new Set([QUEUE_SELECT, QUEUE_USAGE]);
  assert.deepEqual(judgeRestoredMacGrantsV1({ restored, current: new Set([QUEUE_SELECT, QUEUE_USAGE]) }),
    { verified: true, notes: [] },
    "the ordinary case must stay silent: a note on every verification is a note nobody reads");
});

test("a backup that PREDATES a role file verifies, and says so by name", () => {
  // The R5B-08 shape: the restored copy holds a grant today's list does not name,
  // because the install predates `agent_reviewer_roles.sql`.
  const restored = new Set([QUEUE_SELECT, QUEUE_USAGE, REVIEWER_USAGE]);
  const current = new Set([QUEUE_SELECT, QUEUE_USAGE]);
  const verdict = judgeRestoredMacGrantsV1({ restored, current });
  // THE REGRESSION. The old code threw `database_backup_mac_grants_refused` here.
  assert.equal(verdict.verified, true, "a backup from an older install is a backup that verifies");
  assert.equal(verdict.notes[0], "backup_predates_current_permissions",
    "and the difference is reported as a named, non-failing note");
  assert.match(verdict.notes[1] ?? "", /^grants_differ_from_current_release:extra=1:missing=0$/u,
    "the note says HOW MUCH differs, in both directions, without naming any object");
});

test("the strict comparison still exists, still answers, and still reports both directions", () => {
  const current = new Set([QUEUE_SELECT, QUEUE_USAGE]);
  assert.deepEqual(macGrantsMatchCurrentReleaseV1({ restored: new Set([QUEUE_SELECT, QUEUE_USAGE]), current }),
    { matches: true, extra: [], missing: [] });
  const stale = macGrantsMatchCurrentReleaseV1({ restored: new Set([QUEUE_SELECT]), current });
  assert.equal(stale.matches, false, "the strict form must still refuse a mismatch — R5B-08 removed it from the PATH, not from existence");
  assert.deepEqual(stale.missing, [QUEUE_USAGE]);
  assert.deepEqual(stale.extra, []);
  const widened = macGrantsMatchCurrentReleaseV1({ restored: new Set([QUEUE_SELECT, QUEUE_USAGE, REVIEWER_USAGE]), current });
  assert.deepEqual(widened.extra, [REVIEWER_USAGE]);
});

test("a grant difference in EITHER direction is still surfaced, never swallowed", () => {
  const current = new Set([QUEUE_SELECT, QUEUE_USAGE]);
  // Both directions at once: the restored copy is missing one grant the current
  // list names (QUEUE_SELECT) AND holds one it does not name (REVIEWER_USAGE),
  // so the note's counts are extra=1:missing=1.
  const verdict = judgeRestoredMacGrantsV1({ restored: new Set([REVIEWER_USAGE, QUEUE_USAGE]), current });
  assert.equal(verdict.verified, true, "still verified — the backup is the backup's own business");
  assert.match(verdict.notes[1] ?? "", /extra=1:missing=1$/u,
    "and the note counts both directions, so a genuinely odd backup is still visible");
});

test("an absent current grant list yields no invented note", () => {
  assert.deepEqual(judgeRestoredMacGrantsV1({ restored: new Set([QUEUE_SELECT]), current: new Set() }),
    { verified: true, notes: [] },
    "with nothing to compare against there is no difference to report, and a fabricated note would be a lie");
});

test("the comparison is the repository's own diff over the same tuple encoding", async () => {
  const desired = await readDesiredMacGrantsV1();
  assert.ok(desired.size > 150, `the shipped desired set is suspiciously small: ${desired.size}`);
  // A current backup's own catalogue against today's list is exactly equal, and
  // both functions agree with `diffMacGrantsV1` directly.
  assert.equal(macGrantsMatchCurrentReleaseV1({ restored: desired, current: desired }).matches, true);
  assert.deepEqual(diffMacGrantsV1(desired, desired), { extra: [], missing: [] });
  // A non-Set argument is refused rather than silently treated as empty.
  assert.throws(() => judgeRestoredMacGrantsV1({ restored: [], current: desired }),
    /database_backup_grant_set_refused/u);
  assert.throws(() => macGrantsMatchCurrentReleaseV1({ restored: desired, current: null }),
    /database_backup_grant_set_refused/u);
});