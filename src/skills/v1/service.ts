import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { assertPortableGuardedTextV1 } from "../../security/inert-portable-input";
import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebAccessError } from "../../web/v1/access-verifier";
import { WebSessionAuthority } from "../../web/v1/session-authority";
import { assertWorkspaceProjectInSessionV1 } from "../../web/v1/project-workspace-lookup";
import { reusableSkillReferencesSchemaV1, type ReusableSkillReferenceV1 } from "./schemas";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const text = z.string().min(1).max(12_000);
/** Skills returned per page. Small enough to be a panel, large enough that
 * the ordinary project never needs a second page; the point is that a page
 * that is full says so with `nextCursor` instead of quietly dropping the rest. */
export const REUSABLE_SKILL_PAGE_SIZE_V1 = 100;
const createSchema = z.object({ name: z.string().min(1).max(120), instructions: text }).strict();
const updateSchema = createSchema.pick({ instructions: true }).extend({ expectedVersion: z.number().int().positive() }).strict();

/** A stored create receipt, re-parsed on every replay. A receipt is read back
 * from the database, so it is treated as untrusted input like any other: a row
 * that does not describe exactly the skill this action created is refused
 * rather than handed to the browser as if it were the answer. */
const createResultSchema = z.object({
  skillId: z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  projectId: z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  name: z.string().min(1).max(120), version: z.number().int().positive(),
  instructions: text, contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  createdAt: z.string().datetime(), startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();

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
  // A reference list that is invalid - including one naming the same skill at
  // two versions - is a bad request, not a server fault. Left as a raw Zod
  // throw it would surface as a 500 with a schema dump, and the duplicate-key
  // collision it exists to prevent would still be reachable by any other
  // caller that skipped this parser.
  const parsed = reusableSkillReferencesSchemaV1.safeParse(references);
  if (!parsed.success) throw new WebAccessError("invalid_request");
  const resolved: ResolvedReusableSkillV1[] = [];
  for (const reference of parsed.data) {
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

  /** Save a new skill.
   *
   * `actionKey` is the browser's stable id for ONE owner action ("save this
   * skill"). It is what makes a retry safe: without it a lost reply left the
   * owner with no way to distinguish "my save is missing" from "my save
   * happened and I did not see it", and the only available recovery - press
   * Save again - created a second indistinguishable skill. Replaying the same
   * key returns the original receipt, so the recovery is exact.
   *
   * A key reused with DIFFERENT content is a conflict, not a replay: the
   * action produced a skill the caller is no longer asking for, and answering
   * with it would hand back a skill the owner never wrote. */
  async create(identity: VerifiedWebIdentity, projectId: string, value: unknown, actionKey: string) {
    const parsed = createSchema.safeParse(value);
    if (!parsed.success || !id.safeParse(actionKey).success) throw new WebAccessError("invalid_request");
    guardText(parsed.data.name, parsed.data.instructions);
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.propose", projectId);
      // The shared workspace-fenced project lookup. A skill row is private to
      // its workspace, and a wildcard owner grant spans the whole tenant, so
      // the grant alone would let this catalog list another workspace's
      // instructions.
      await assertWorkspaceProjectInSessionV1(tx, this.scope, projectId);
      // The share lock keeps the project row from changing under the create; the
      // fence above has already refused a sibling workspace's project.
      const project = await tx.query("SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR SHARE",
        [this.scope.tenantId, this.scope.workspaceId, projectId]);
      if (!project.rows.length) throw new WebAccessError("not_found");
      // The digest covers the authenticated project and identity as well as the
      // content, so a key cannot be steered at another project's skill by
      // replaying it under a different scope.
      const requestDigest = sha256Digest({ schema: "control-room.reusable-skill-create/v1", tenantId: this.scope.tenantId,
        workspaceId: this.scope.workspaceId, projectId, identityId: actor.id,
        name: parsed.data.name, instructions: parsed.data.instructions });
      const prior = (await tx.query<{ request_digest: string; result: unknown }>(
        `SELECT request_digest,result FROM control_skill_create_actions
          WHERE tenant_id=$1 AND project_id=$2 AND identity_id=$3 AND action_key=$4`,
        [this.scope.tenantId, projectId, actor.id, actionKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new WebAccessError("conflict");
        return Object.freeze({ ...(createResultSchema.parse(prior.result)), replayed: true as const });
      }
      const skillId = `skill:${randomUUID()}`, version = 1;
      const contentDigest = digest(skillId, version, parsed.data.name, parsed.data.instructions);
      await tx.query(`INSERT INTO control_skills(tenant_id,project_id,skill_id,name,current_version,state,created_by_identity_id,
        created_at,updated_at) VALUES($1,$2,$3,$4,1,'active',$5,$6,$6)`,
      [this.scope.tenantId, projectId, skillId, parsed.data.name, actor.id, actor.now]);
      await tx.query(`INSERT INTO control_skill_versions(tenant_id,project_id,skill_id,version,name,instructions,
        content_digest,created_by_identity_id,created_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)`,
      [this.scope.tenantId, projectId, skillId, parsed.data.name, parsed.data.instructions, contentDigest, actor.id, actor.now]);
      const result = Object.freeze({ skillId, projectId, name: parsed.data.name, version, instructions: parsed.data.instructions,
        contentDigest, createdAt: actor.now, startsWork: false as const, grantsExecutionAuthority: false as const });
      // The receipt is recorded in the SAME transaction as the skill. A lost
      // reply can then never leave a skill that no action key explains: either
      // both are durable, or neither is.
      await tx.query(`INSERT INTO control_skill_create_actions(tenant_id,project_id,identity_id,action_key,
        request_digest,skill_id,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [this.scope.tenantId, projectId, actor.id, actionKey, requestDigest, skillId, JSON.stringify(result), actor.now]);
      return Object.freeze({ ...result, replayed: false as const });
    });
  }

  async update(identity: VerifiedWebIdentity, projectId: string, skillId: string, value: unknown) {
    const parsed = updateSchema.safeParse(value);
    if (!parsed.success || !id.safeParse(skillId).success) throw new WebAccessError("invalid_request");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId); actor.require("tasks.propose", projectId);
      // Existing-item mutation: the same workspace fence the catalog read and
      // the create take. Without it a wildcard owner grant could rewrite a
      // sibling workspace's skill instructions in place.
      await assertWorkspaceProjectInSessionV1(tx, this.scope, projectId);
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

  /** One page of the project's skills, oldest-name first, plus the cursor for
   * the next page. A caller that ignores `nextCursor` sees a prefix, never a
   * silently truncated one: a skill saved beyond the first page is reachable,
   * which is what the old unbounded `LIMIT 100` did not guarantee. */
  async list(identity: VerifiedWebIdentity, projectId: string, after?: string) {
    if (after !== undefined && !id.safeParse(after).success) throw new WebAccessError("invalid_request");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId);
      // The workspace fence, before the catalog query. `control_skills` has
      // no workspace column of its own, so tenant+project was the whole
      // predicate, and a sibling workspace's skill instructions were served
      // with 200 under an ordinary wildcard owner grant.
      await assertWorkspaceProjectInSessionV1(tx, this.scope, projectId);
      // Keyset pagination on the SAME (name, skill_id) order the page is
      // returned in, so a following page can never repeat or skip a row even
      // when two skills share a name. The cursor is a bare skill id: its name
      // is looked up here, inside the same tenant and project, rather than
      // being carried by the caller (a name the caller chose would let a
      // crafted cursor skip rows). An unknown or foreign cursor matches no row
      // and therefore yields an empty final page instead of a forged one.
      const rows = (await tx.query<SkillRow>(`SELECT s.skill_id,s.name,s.current_version,s.state,v.instructions,v.content_digest,
          s.created_at,s.updated_at FROM control_skills s JOIN control_skill_versions v ON v.tenant_id=s.tenant_id
          AND v.project_id=s.project_id AND v.skill_id=s.skill_id AND v.version=s.current_version
        WHERE s.tenant_id=$1 AND s.project_id=$2
          AND ($3::text IS NULL OR (s.name,s.skill_id) > (
            SELECT c.name,c.skill_id FROM control_skills c
            WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.skill_id=$3))
        ORDER BY s.name,s.skill_id LIMIT ${REUSABLE_SKILL_PAGE_SIZE_V1 + 1}`,
      [this.scope.tenantId, projectId, after ?? null])).rows;
      const page = rows.slice(0, REUSABLE_SKILL_PAGE_SIZE_V1);
      const last = page.at(-1);
      const nextCursor = rows.length > REUSABLE_SKILL_PAGE_SIZE_V1 && last ? last.skill_id : null;
      return Object.freeze({ projectId, skills: Object.freeze(page.map(row => Object.freeze({ skillId: row.skill_id,
        name: row.name, currentVersion: Number(row.current_version), state: row.state,
        instructions: row.instructions!, contentDigest: row.content_digest!,
        createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }))), nextCursor, startsWork: false as const,
        grantsExecutionAuthority: false as const });
    });
  }
}
