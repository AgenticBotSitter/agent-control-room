import assert from "node:assert/strict";
import { SupervisorReconcilerV1 } from "../../src/supervisor/v1/reconciler";
const now = "2026-10-02T12:00:00.000Z";
export async function supervisorItem(n = 0) {
  let item: any;
  const row = { project_id: 'project:fixture', job_id: `job:${String(n).padStart(4, '0')}`, job_state: 'running', job_version: 1,
    job_payload: { id: `job:${String(n).padStart(4, '0')}`, state: 'running', version: 1 }, attempt_id: `attempt:${n}`,
    attempt_state: 'running', attempt_version: 1, attempt_payload: { state: 'running', version: 1 },
    worker_id: 'worker:fixture', node_id: 'node:fixture', lease_id: `lease:${n}`, lease_state: 'active',
    lease_version: 1, lease_payload: { state: 'active', version: 1 }, outcome_uncertain: true };
  const db: any = { async query(sql: string, params: any[] = []) {
    if (sql.startsWith('SELECT a.id AS attempt_id')) return { rows: [{ attempt_id: row.attempt_id }] };
    if (sql.includes('SELECT job_id,attempt_id,disposition')) return { rows: [] };
    if (sql.includes('SELECT j.project_id,j.id AS job_id')) return { rows: [row] };
    if (sql.includes('SELECT lapse_count')) return { rows: [{ lapse_count: 0 }] };
    if (sql.startsWith('INSERT INTO control_action_inbox')) item = JSON.parse(params[5]);
    else if (!/^(UPDATE control_|DELETE FROM control_|INSERT INTO control_)/.test(sql)) throw new Error('unhandled_fake_query');
    return { rows: [] };
  }, async transaction(work: any) { return work(db); } };
  const outcome = await new SupervisorReconcilerV1(db, 'tenant:fixture', () => Date.parse(now)).reconcileStalled();
  assert.equal(outcome[0].disposition, 'uncertain');
  assert.ok(item);
  return item;
}

