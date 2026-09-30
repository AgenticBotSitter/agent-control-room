import type { DatabaseClient } from "../../persistence/database";
import { calculateScheduleOccurrencesV1 } from "../../services/v1/recurrence";
import { supervisorRunModeDecisionV1, type SupervisorRunModePortV1 } from "../../supervisor/v1/operations-mode";
import type { WorkBatchProposalV1, WorkBatchReceiptV1 } from "../../work-intake/v1";
import { workBatchProposalDigestV1, type WorkBatchServiceV1 } from "../../work-intake/v1";
import type { AuthenticatedPrincipal } from "../../security";
import { reusableSkillReferencesSchemaV1 } from "../../skills/v1";
import { recurringRuleDefinitionDigestV1, type RecurringRuleRowV1 } from "./service";

export const RECURRING_S7B_CAPS_V1 = Object.freeze({ maxProposalsPerCycle: 3, maxConcurrentProposals: 1,
  maxTasksPerProposal: 1, maxCostMicroUsd: 0 });

type TaskTemplate = { title: string; instructions: string; requiredCapability: string;
  acceptanceCriteria: string; acceptanceTests: string; skillRefs: unknown };

export type RecurringProposalPortV1 = Readonly<{ propose(input: Readonly<{ ruleId: string; projectId: string;
  occurrenceKey: string; scheduledFor: string; definitionDigest: string; task: TaskTemplate;
  idempotencyKey: string }>): Promise<WorkBatchReceiptV1> }>;

export function recurringWorkBatchProposalPortV1(service: WorkBatchServiceV1, principal: AuthenticatedPrincipal,
  clock: () => number = Date.now): RecurringProposalPortV1 {
  return Object.freeze({ async propose(input) {
    const task = input.task;
    const proposal: WorkBatchProposalV1 = { schema: "control-room.work-batch-proposal/v1", projectId: input.projectId,
      tasks: [{ localId: "recurring", title: task.title, instructions: task.instructions,
        requiredCapability: task.requiredCapability, role: "builder", acceptanceCriteria: task.acceptanceCriteria,
        acceptanceTests: task.acceptanceTests, skillRefs: reusableSkillReferencesSchemaV1.parse(task.skillRefs) }], edges: [] };
    const result = await service.submit({ principal, projectId: input.projectId, rawProposal: JSON.stringify(proposal),
      idempotencyKey: input.idempotencyKey, now: new Date(clock()).toISOString() });
    if (!("batchId" in result) || result.startsWork !== false || result.grantsExecutionAuthority !== false)
      throw new Error("recurring_proposal_refused");
    return result;
  } });
}

type ProposalRow = { state: "pending" | "proposed" | "failed"; batch_id: string | null;
  definition_digest: string; idempotency_key: string };
const iso = (value: string | Date) => new Date(value).toISOString();

export class RecurringRuleSchedulerV1 {
  constructor(private readonly db: DatabaseClient, private readonly tenantId: string,
    private readonly operations: SupervisorRunModePortV1, private readonly proposals: RecurringProposalPortV1,
    private readonly clock: () => number = Date.now) {}

  async tick(): Promise<Readonly<{ proposed: readonly string[]; failed: readonly string[];
    halted: "paused" | "draining" | "stopped" | null; startsWork: false }>> {
    const decision = supervisorRunModeDecisionV1(await this.operations.read());
    if (decision !== "start") return Object.freeze({ proposed: [], failed: [],
      halted: decision === "pause" ? "paused" : decision === "drain" ? "draining" : "stopped", startsWork: false });
    const nowMs = this.clock(), now = new Date(nowMs).toISOString();
    const rules = (await this.db.query<RecurringRuleRowV1>(`SELECT * FROM control_recurring_rules
      WHERE tenant_id=$1 AND state='active' ORDER BY rule_id LIMIT 100`, [this.tenantId])).rows;
    const proposed: string[] = [], failed: string[] = []; let attempted = 0;
    for (const rule of rules) {
      if (attempted >= RECURRING_S7B_CAPS_V1.maxProposalsPerCycle) break;
      // The shared recurrence calculator refuses windows over 31 days. A
      // 30-day catch-up horizon leaves room for the inclusive end instant and
      // still collapses every missed occurrence to the newest one below.
      const startMs = Math.max(Date.parse(iso(rule.last_evaluated_at)), nowMs - 30 * 86_400_000);
      const calculation = calculateScheduleOccurrencesV1({ id: rule.rule_id, kind: "cron", state: "active",
        expression: rule.cron_expression, timezone: rule.timezone },
      { startsAt: new Date(startMs).toISOString(), endsAt: new Date(nowMs + 1).toISOString() });
      if (calculation.safeReason) { failed.push(rule.rule_id); continue; }
      const occurrence = calculation.occurrences.at(-1);
      if (!occurrence) {
        await this.db.query(`UPDATE control_recurring_rules SET last_evaluated_at=$1
          WHERE tenant_id=$2 AND rule_id=$3 AND state='active' AND last_evaluated_at<$1`,
        [now, this.tenantId, rule.rule_id]);
        continue;
      }
      const definitionDigest = recurringRuleDefinitionDigestV1(rule);
      const idempotencyKey = `recurring:${definitionDigest.slice(7, 39)}:${occurrence.localTime.replace(/[^0-9]/g, "")}`;
      await this.db.query(`INSERT INTO control_recurring_proposals
        (tenant_id,project_id,rule_id,occurrence_key,scheduled_for,definition_digest,idempotency_key,state,attempt_count,
          created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',1,$8,$8)
        ON CONFLICT(tenant_id,rule_id,occurrence_key) DO UPDATE SET attempt_count=control_recurring_proposals.attempt_count+1,
          state=CASE WHEN control_recurring_proposals.state='proposed' THEN 'proposed' ELSE 'pending' END,
          safe_reason_code=CASE WHEN control_recurring_proposals.state='proposed'
            THEN control_recurring_proposals.safe_reason_code ELSE NULL END,updated_at=EXCLUDED.updated_at
        WHERE control_recurring_proposals.state<>'proposed'
          AND control_recurring_proposals.definition_digest=EXCLUDED.definition_digest`,
      [this.tenantId, rule.project_id, rule.rule_id, occurrence.occurrenceKey, occurrence.scheduledFor,
        definitionDigest, idempotencyKey, now]);
      const prior = (await this.db.query<ProposalRow>(`SELECT state,batch_id,definition_digest,idempotency_key FROM control_recurring_proposals
        WHERE tenant_id=$1 AND rule_id=$2 AND occurrence_key=$3`,
      [this.tenantId, rule.rule_id, occurrence.occurrenceKey])).rows[0];
      if (prior?.state === "proposed") continue;
      // An occurrence is immutable. If the owner edited the rule after a
      // failed call, wait for the next scheduled occurrence instead of
      // retargeting this ledger row or spending a different S1 idempotency key.
      if (!prior || prior.definition_digest !== definitionDigest || prior.idempotency_key !== idempotencyKey) {
        await this.db.query(`UPDATE control_recurring_rules SET last_evaluated_at=$1
          WHERE tenant_id=$2 AND rule_id=$3 AND last_evaluated_at<$1`, [now, this.tenantId, rule.rule_id]);
        failed.push(rule.rule_id);
        continue;
      }
      const immediateDecision = supervisorRunModeDecisionV1(await this.operations.read());
      if (immediateDecision !== "start") {
        await this.db.query(`UPDATE control_recurring_proposals SET state='failed',safe_reason_code='operations_mode',updated_at=$1
          WHERE tenant_id=$2 AND rule_id=$3 AND occurrence_key=$4 AND state='pending'`,
        [now, this.tenantId, rule.rule_id, occurrence.occurrenceKey]);
        return Object.freeze({ proposed, failed,
          halted: immediateDecision === "pause" ? "paused" : immediateDecision === "drain" ? "draining" : "stopped",
          startsWork: false });
      }
      attempted += 1;
      try {
        const task = rule.task_template as TaskTemplate;
        const receipt = await this.proposals.propose({ ruleId: rule.rule_id, projectId: rule.project_id,
          occurrenceKey: occurrence.occurrenceKey, scheduledFor: occurrence.scheduledFor, definitionDigest,
          task, idempotencyKey });
        if (receipt.startsWork !== false || receipt.grantsExecutionAuthority !== false || receipt.projectId !== rule.project_id)
          throw new Error("recurring_proposal_authority_invalid");
        await this.db.transaction(async tx => {
          await tx.query(`UPDATE control_recurring_proposals SET state='proposed',batch_id=$1,safe_reason_code=NULL,updated_at=$2
            WHERE tenant_id=$3 AND rule_id=$4 AND occurrence_key=$5`,
          [receipt.batchId, now, this.tenantId, rule.rule_id, occurrence.occurrenceKey]);
          await tx.query(`UPDATE control_recurring_rules SET last_evaluated_at=$1
            WHERE tenant_id=$2 AND rule_id=$3 AND last_evaluated_at<$1`, [now, this.tenantId, rule.rule_id]);
        });
        proposed.push(receipt.batchId);
      } catch {
        await this.db.query(`UPDATE control_recurring_proposals SET state='failed',safe_reason_code='proposal_failed',updated_at=$1
          WHERE tenant_id=$2 AND rule_id=$3 AND occurrence_key=$4 AND state='pending'`,
        [now, this.tenantId, rule.rule_id, occurrence.occurrenceKey]);
        failed.push(rule.rule_id);
      }
    }
    return Object.freeze({ proposed: Object.freeze(proposed), failed: Object.freeze(failed), halted: null, startsWork: false });
  }
}
