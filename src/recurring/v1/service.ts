import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { reusableSkillReferencesSchemaV1 } from "../../skills/v1";
import { composeReusableSkillInstructionsV1, resolveReusableSkillsInSessionV1 } from "../../skills/v1/service";
import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebAccessError } from "../../web/v1/access-verifier";
import { WebSessionAuthority } from "../../web/v1/session-authority";
import { parsePlainRecurringScheduleV1 } from "./plain-schedule";

const safeText = (maximum: number) => z.string().min(1).max(maximum);
const inputSchema = z.object({
  schedule: safeText(120), timezone: safeText(80), title: safeText(180), instructions: safeText(3_000),
  requiredCapability: z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u).default("task.proposal.review"),
  acceptanceCriteria: safeText(1_000).default("The requested recurring check is complete and evidence is attached."),
  acceptanceTests: safeText(1_000).default("Review the result against the instructions before accepting it."),
  skillRefs: reusableSkillReferencesSchemaV1.default([]),
}).strict();
const updateSchema = inputSchema.extend({ expectedVersion: z.number().int().positive() }).strict();

type RuleRow = { rule_id: string; project_id: string; state: "active" | "paused"; plain_schedule: string;
  cron_expression: string; timezone: string; task_template: unknown; version: number | string;
  created_at: string | Date; updated_at: string | Date; last_evaluated_at: string | Date };

const iso = (value: string | Date) => new Date(value).toISOString();

function timezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0); return true; }
  catch { return false; }
}

function view(row: RuleRow) {
  const task = inputSchema.omit({ schedule: true, timezone: true }).parse(row.task_template);
  return Object.freeze({ ruleId: row.rule_id, projectId: row.project_id, state: row.state,
    schedule: row.plain_schedule, cronExpression: row.cron_expression, timezone: row.timezone, task,
    version: Number(row.version), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    lastEvaluatedAt: iso(row.last_evaluated_at), startsWork: false as const, grantsExecutionAuthority: false as const });
}

export class RecurringRuleServiceV1 {
  readonly #authority: WebSessionAuthority;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    clock: () => number = Date.now) {
    this.#authority = new WebSessionAuthority(db, scope, clock, "recurring_rule");
  }

  async create(identity: VerifiedWebIdentity, projectId: string, value: unknown) {
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success || !timezone(parsed.data.timezone)) throw new WebAccessError("invalid_request");
    const schedule = parsePlainRecurringScheduleV1(parsed.data.schedule);
    if (!schedule) throw new WebAccessError("invalid_request");
    try { assertNoSecretMaterial(parsed.data, "recurring rule"); } catch { throw new WebAccessError("invalid_request"); }
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.propose", projectId);
      const project = await tx.query("SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR SHARE",
        [this.scope.tenantId, this.scope.workspaceId, projectId]);
      if (!project.rows.length) throw new WebAccessError("not_found");
      const skills = await resolveReusableSkillsInSessionV1(tx,
        { tenantId: this.scope.tenantId, projectId }, parsed.data.skillRefs);
      composeReusableSkillInstructionsV1(parsed.data.instructions, skills);
      const ruleId = `recurring-rule:${randomUUID()}`;
      const task = { title: parsed.data.title, instructions: parsed.data.instructions,
        requiredCapability: parsed.data.requiredCapability, acceptanceCriteria: parsed.data.acceptanceCriteria,
        acceptanceTests: parsed.data.acceptanceTests, skillRefs: parsed.data.skillRefs };
      const inserted = (await tx.query<RuleRow>(`INSERT INTO control_recurring_rules
        (tenant_id,project_id,rule_id,state,plain_schedule,cron_expression,timezone,task_template,version,
          created_by_identity_id,updated_by_identity_id,created_at,updated_at,last_evaluated_at)
        VALUES($1,$2,$3,'active',$4,$5,$6,$7::jsonb,1,$8,$8,$9,$9,$9) RETURNING *`,
      [this.scope.tenantId, projectId, ruleId, schedule.normalized, schedule.expression, parsed.data.timezone,
        JSON.stringify(task), actor.id, actor.now])).rows[0]!;
      return view(inserted);
    });
  }

  async update(identity: VerifiedWebIdentity, projectId: string, ruleId: string, value: unknown) {
    const parsed = updateSchema.safeParse(value), schedule = parsed.success
      ? parsePlainRecurringScheduleV1(parsed.data.schedule) : undefined;
    if (!parsed.success || !schedule || !timezone(parsed.data.timezone)) throw new WebAccessError("invalid_request");
    try { assertNoSecretMaterial(parsed.data, "recurring rule"); } catch { throw new WebAccessError("invalid_request"); }
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.propose", projectId);
      const skills = await resolveReusableSkillsInSessionV1(tx,
        { tenantId: this.scope.tenantId, projectId }, parsed.data.skillRefs);
      composeReusableSkillInstructionsV1(parsed.data.instructions, skills);
      const task = { title: parsed.data.title, instructions: parsed.data.instructions,
        requiredCapability: parsed.data.requiredCapability, acceptanceCriteria: parsed.data.acceptanceCriteria,
        acceptanceTests: parsed.data.acceptanceTests, skillRefs: parsed.data.skillRefs };
      const row = (await tx.query<RuleRow>(`UPDATE control_recurring_rules SET plain_schedule=$1,cron_expression=$2,
        timezone=$3,task_template=$4::jsonb,version=version+1,updated_by_identity_id=$5,updated_at=$6
        WHERE tenant_id=$7 AND project_id=$8 AND rule_id=$9 AND version=$10 RETURNING *`,
      [schedule.normalized, schedule.expression, parsed.data.timezone, JSON.stringify(task), actor.id, actor.now,
        this.scope.tenantId, projectId, ruleId, parsed.data.expectedVersion])).rows[0];
      if (!row) throw new WebAccessError("conflict");
      return view(row);
    });
  }

  async setPaused(identity: VerifiedWebIdentity, projectId: string, ruleId: string,
    value: { paused: boolean; expectedVersion: number }) {
    if (typeof value?.paused !== "boolean" || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1)
      throw new WebAccessError("invalid_request");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.propose", projectId);
      const row = (await tx.query<RuleRow>(`UPDATE control_recurring_rules SET state=$1,version=version+1,
        updated_by_identity_id=$2,updated_at=$3 WHERE tenant_id=$4 AND project_id=$5 AND rule_id=$6 AND version=$7 RETURNING *`,
      [value.paused ? "paused" : "active", actor.id, actor.now, this.scope.tenantId, projectId, ruleId,
        value.expectedVersion])).rows[0];
      if (!row) throw new WebAccessError("conflict");
      return view(row);
    });
  }

  async list(identity: VerifiedWebIdentity, projectId: string) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const rows = (await tx.query<RuleRow>(`SELECT * FROM control_recurring_rules
        WHERE tenant_id=$1 AND project_id=$2 ORDER BY created_at,rule_id LIMIT 100`,
      [this.scope.tenantId, projectId])).rows;
      return Object.freeze({ projectId, rules: Object.freeze(rows.map(view)), startsWork: false as const,
        grantsExecutionAuthority: false as const });
    });
  }
}

export function recurringRuleDefinitionDigestV1(row: Pick<RuleRow, "rule_id" | "project_id" | "plain_schedule" |
  "cron_expression" | "timezone" | "task_template" | "version">): string {
  return sha256Digest({ schema: "control-room.recurring-rule-definition/v1", ruleId: row.rule_id,
    projectId: row.project_id, schedule: row.plain_schedule, cronExpression: row.cron_expression,
    timezone: row.timezone, task: row.task_template, version: Number(row.version) });
}

export type { RuleRow as RecurringRuleRowV1 };
