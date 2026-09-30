import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { assertPortableGuardedTextV1 } from "../../security/inert-portable-input";
import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebAccessError } from "../../web/v1/access-verifier";
import { WebSessionAuthority } from "../../web/v1/session-authority";
import { reusableSkillReferencesSchemaV1, type ReusableSkillReferenceV1 } from "./schemas";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const text = z.string().min(1).max(12_000);
const createSchema = z.object({ name: z.string().min(1).max(120), instructions: text }).strict();
const updateSchema = createSchema.pick({ instructions: true }).extend({ expectedVersion: z.number().int().positive() }).strict();

export type ResolvedReusableSkillV1 = Readonly<ReusableSkillReferenceV1 & {
  name: string;
  instructions: string;
  contentDigest: string;
}>;

function guardText(name: string, instructions: string): void {
  assertPortableGuardedTextV1("reusable_skill", "name", name);
  assertPortableGuardedTextV1("reusable_skill", "instructions", instructions);
  assertNoSecretMaterial({ name, instructions }, "reusable skill");
}

function digest(skillId: string, version: number, name: string, instructions: string): string {
  return sha256Digest({ schema: "control-room.reusable-skill/v1", skillId, version, name, instructions });
}

type SkillRow = { skill_id: string; name: string; current_version: number | string; state: "active" | "retired";
  instructions?: string; content_digest?: string; created_at: string | Date; updated_at: string | Date };
type VersionRow = { skill_id: string; version: number | string; name: string; instructions: string;
  content_digest: string; created_at: string | Date };
type BoundVersionRow = VersionRow & { version_digest: string };

const iso = (value: string | Date) => new Date(value).toISOString();

export async function resolveReusableSkillsInSessionV1(tx: DatabaseSession, scope: { tenantId: string; projectId: string },
  references: readonly ReusableSkillReferenceV1[]): Promise<readonly ResolvedReusableSkillV1[]> {
  const parsed = reusableSkillReferencesSchemaV1.parse(references);
  const resolved: ResolvedReusableSkillV1[] = [];
  for (const reference of parsed) {
    const row = (await tx.query<VersionRow>(`SELECT v.skill_id,v.version,v.name,v.instructions,v.content_digest,v.created_at
      FROM control_skill_versions v JOIN control_skills s
        ON s.tenant_id=v.tenant_id AND s.project_id=v.project_id AND s.skill_id=v.skill_id
      WHERE v.tenant_id=$1 AND v.project_id=$2 AND v.skill_id=$3 AND v.version=$4 AND s.state='active'`,
    [scope.tenantId, scope.projectId, reference.skillId, reference.version])).rows[0];
    if (!row || digest(row.skill_id, Number(row.version), row.name, row.instructions) !== row.content_digest)
      throw new WebAccessError("conflict");
    resolved.push(Object.freeze({ ...reference, name: row.name, instructions: row.instructions,
      contentDigest: row.content_digest }));
  }
  return Object.freeze(resolved);
}

export async function bindReusableSkillsToTaskInSessionV1(tx: DatabaseSession,
  input: { tenantId: string; projectId: string; jobId: string; references: readonly ReusableSkillReferenceV1[]; boundAt: string }) {
  const skills = await resolveReusableSkillsInSessionV1(tx, input, input.references);
  for (const skill of skills) await tx.query(`INSERT INTO control_task_skill_bindings
    (tenant_id,project_id,job_id,skill_id,skill_version,content_digest,bound_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.tenantId, input.projectId, input.jobId, skill.skillId,
    skill.version, skill.contentDigest, input.boundAt]);
  return skills;
}

/** Resolves only immutable versions already bound to one canonical task. A
 * later head update or retirement cannot rewrite what this task uses. */
export async function readBoundReusableSkillsInSessionV1(tx: DatabaseSession,
  input: { tenantId: string; projectId: string; jobId: string }): Promise<readonly ResolvedReusableSkillV1[]> {
  const rows = (await tx.query<BoundVersionRow>(`SELECT b.skill_id,b.skill_version AS version,v.name,v.instructions,
      b.content_digest,v.content_digest AS version_digest,v.created_at
    FROM control_task_skill_bindings b JOIN control_skill_versions v ON v.tenant_id=b.tenant_id
      AND v.project_id=b.project_id AND v.skill_id=b.skill_id AND v.version=b.skill_version
    WHERE b.tenant_id=$1 AND b.project_id=$2 AND b.job_id=$3 ORDER BY b.skill_id`,
  [input.tenantId, input.projectId, input.jobId])).rows;
  const resolved = rows.map(row => {
    const version = Number(row.version), expected = digest(row.skill_id, version, row.name, row.instructions);
    if (expected !== row.content_digest || expected !== row.version_digest) throw new WebAccessError("conflict");
    return Object.freeze({ skillId: row.skill_id, version, name: row.name, instructions: row.instructions,
      contentDigest: row.content_digest });
  });
  return Object.freeze(resolved);
}

export function composeReusableSkillInstructionsV1(base: string, skills: readonly ResolvedReusableSkillV1[]): string {
  const blocks = skills.map(skill => `Reusable skill ${skill.name} (${skill.skillId}@${skill.version}):\n${skill.instructions}`);
  const composed = [base, ...blocks].join("\n\n");
  if (composed.length > 4_000) throw new WebAccessError("invalid_request");
  return composed;
}

export class ReusableSkillServiceV1 {
  readonly #authority: WebSessionAuthority;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    private readonly clock: () => number = Date.now) {
    this.#authority = new WebSessionAuthority(db, scope, clock, "reusable_skill");
  }

  async create(identity: VerifiedWebIdentity, projectId: string, value: unknown) {
    const parsed = createSchema.safeParse(value);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    guardText(parsed.data.name, parsed.data.instructions);
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.propose", projectId);
      const project = await tx.query("SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR SHARE",
        [this.scope.tenantId, this.scope.workspaceId, projectId]);
      if (!project.rows.length) throw new WebAccessError("not_found");
      const skillId = `skill:${randomUUID()}`, version = 1;
      const contentDigest = digest(skillId, version, parsed.data.name, parsed.data.instructions);
      await tx.query(`INSERT INTO control_skills(tenant_id,project_id,skill_id,name,current_version,state,created_by_identity_id,
        created_at,updated_at) VALUES($1,$2,$3,$4,1,'active',$5,$6,$6)`,
      [this.scope.tenantId, projectId, skillId, parsed.data.name, actor.id, actor.now]);
      await tx.query(`INSERT INTO control_skill_versions(tenant_id,project_id,skill_id,version,name,instructions,
        content_digest,created_by_identity_id,created_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)`,
      [this.scope.tenantId, projectId, skillId, parsed.data.name, parsed.data.instructions, contentDigest, actor.id, actor.now]);
      return Object.freeze({ skillId, projectId, name: parsed.data.name, version, instructions: parsed.data.instructions,
        contentDigest, createdAt: actor.now, startsWork: false as const, grantsExecutionAuthority: false as const });
    });
  }

  async update(identity: VerifiedWebIdentity, projectId: string, skillId: string, value: unknown) {
    const parsed = updateSchema.safeParse(value);
    if (!parsed.success || !id.safeParse(skillId).success) throw new WebAccessError("invalid_request");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.propose", projectId);
      const head = (await tx.query<SkillRow>(`SELECT skill_id,name,current_version,state,created_at,updated_at FROM control_skills
        WHERE tenant_id=$1 AND project_id=$2 AND skill_id=$3 FOR UPDATE`,
      [this.scope.tenantId, projectId, skillId])).rows[0];
      if (!head) throw new WebAccessError("not_found");
      if (head.state !== "active" || Number(head.current_version) !== parsed.data.expectedVersion)
        throw new WebAccessError("conflict");
      guardText(head.name, parsed.data.instructions);
      const version = Number(head.current_version) + 1;
      const contentDigest = digest(skillId, version, head.name, parsed.data.instructions);
      await tx.query(`INSERT INTO control_skill_versions(tenant_id,project_id,skill_id,version,name,instructions,
        content_digest,created_by_identity_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [this.scope.tenantId, projectId, skillId, version, head.name, parsed.data.instructions, contentDigest, actor.id, actor.now]);
      const changed = await tx.query(`UPDATE control_skills SET current_version=$1,updated_at=$2
        WHERE tenant_id=$3 AND project_id=$4 AND skill_id=$5 AND current_version=$6 RETURNING skill_id`,
      [version, actor.now, this.scope.tenantId, projectId, skillId, parsed.data.expectedVersion]);
      if (!changed.rows.length) throw new WebAccessError("conflict");
      return Object.freeze({ skillId, projectId, name: head.name, version, instructions: parsed.data.instructions,
        contentDigest, createdAt: actor.now, startsWork: false as const, grantsExecutionAuthority: false as const });
    });
  }

  async list(identity: VerifiedWebIdentity, projectId: string) {
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      const rows = (await tx.query<SkillRow>(`SELECT s.skill_id,s.name,s.current_version,s.state,v.instructions,v.content_digest,
          s.created_at,s.updated_at FROM control_skills s JOIN control_skill_versions v ON v.tenant_id=s.tenant_id
          AND v.project_id=s.project_id AND v.skill_id=s.skill_id AND v.version=s.current_version
        WHERE s.tenant_id=$1 AND s.project_id=$2 ORDER BY s.name,s.skill_id LIMIT 100`,
      [this.scope.tenantId, projectId])).rows;
      return Object.freeze({ projectId, skills: Object.freeze(rows.map(row => Object.freeze({ skillId: row.skill_id,
        name: row.name, currentVersion: Number(row.current_version), state: row.state,
        instructions: row.instructions!, contentDigest: row.content_digest!,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }))), startsWork: false as const,
        grantsExecutionAuthority: false as const });
    });
  }
}
