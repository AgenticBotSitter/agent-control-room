// Real PostgreSQL grant proof for retained-news -> ordinary-task provenance.
// The task is created through the restricted production web login; setup alone
// uses the disposable cluster's admin connection.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { PostgresNewsStoreV1 } from "../src/project-adapters/news/v1/postgres-store";
import { PostgresNewsTaskProposalLinksV1 } from "../src/project-adapters/news/v1/task-proposal-links";
import { buildNewsStoryV1 } from "../src/project-adapters/news/v1/story";
import { buildNewsWorkOrderProposalV1 } from "../src/project-adapters/news/v1/proposal";
import { WebTaskService } from "../src/web/v1/task-service";
import { sha256Digest } from "../src/security";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";

// Reserved disposable-cluster lane for the news module: 58420-58429, or the
// test runner's assigned port block, so concurrent runs never collide.
const PORT = Number(process.env.NEWS_TASK_LINK_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 58420);
const PG = requiresRealPostgres();
const NOW = "2026-09-29T15:00:00.000Z";
const LATER = "2026-09-29T16:00:00.000Z";
const KEY = new Uint8Array(32).fill(29);
const scope = { tenantId: "tenant:news-pg", workspaceId: "workspace:news-pg", projectId: "project:news-pg" };
const identity: VerifiedWebIdentity = { provider: "test", subject: "news-owner", tokenDigest: sha256Digest("news-web-session"),
  issuedAt: NOW, expiresAt: LATER, verificationExpiresAt: LATER };

function database(client: Client): DatabaseClient {
  const session: DatabaseSession = { query: async <T>(sql: string, values?: unknown[]) => {
    const result = await client.query(sql, values as never[]); return { rows: result.rows as T[] };
  } };
  return {
    query: session.query,
    transaction: async work => {
      await client.query("BEGIN");
      try { const value = await work(session); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    },
    transactionWithPreCommitCheck: async (work, check) => {
      await client.query("BEGIN");
      try { const value = await work(session); await check(); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    },
  };
}

async function seed(admin: Client) {
  const adapter = `adapter:manual:${sha256Digest({ tenantId: scope.tenantId, workspaceId: scope.workspaceId }).slice(7, 39)}`;
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [scope.tenantId]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [scope.workspaceId, scope.tenantId]);
  await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [adapter, scope.tenantId]);
  await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
    health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1','News project','planned','manual_project_active','healthy','control_room_native',$5,'{}',$5)`,
  [scope.projectId, scope.tenantId, scope.workspaceId, adapter, NOW]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,$3,$3)`, [scope.tenantId, scope.projectId, NOW]);
  await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:news-pg',$1,'human','Owner','test',$2,'active',$3,$3)`,
  [scope.tenantId, sha256Digest({ provider: "test", subject: identity.subject }), NOW]);
  await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:news-pg',$1,'identity:news-pg','owner','["*"]','["*"]','critical',true,false,$2,$2)`, [scope.tenantId, NOW]);
  await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,'identity:news-pg',$3,$4)`, [scope.tenantId, identity.tokenDigest, NOW, LATER]);
}

test("the production web login persists an immutable retained-news link beside a proposed task", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await seed(admin);
      const story = buildNewsStoryV1({ ...scope, storyId: "story:news-pg", clusterId: "cluster:news-pg", queue: "important_now",
        title: "Retained source", summary: "A source that still needs verification.", canonicalUrl: "https://example.invalid/news-pg",
        sourceLabel: "Fixture source", publishedAt: NOW, discoveredAt: NOW, lastVerifiedAt: NOW, verificationState: "review_only",
        priorityScore: 70, coverageCount: 1, contentDigest: sha256Digest("news-pg-content"),
        sourceEvidence: [{ evidenceId: "evidence:news-pg", sourceId: "source:news-pg", sourceKind: "rss", sourceLabel: "Fixture source",
          canonicalUrl: "https://example.invalid/news-pg", observedAt: NOW, evidenceDigest: sha256Digest("news-pg-evidence"),
          containsRawNewsletterBody: false, grantsNetworkAuthority: false }] });
      await new PostgresNewsStoreV1(database(admin), scope, KEY, () => new Date(NOW)).saveStory(story);
      const proposal = buildNewsWorkOrderProposalV1({ ...scope, proposalId: "proposal:news-pg", story, actionId: "research_brief",
        requestedTitle: story.title, goal: "Verify this retained source against primary evidence.", requestedPlatform: "any",
        requestedByActorDigest: sha256Digest("news-pg-owner"), requestedAt: NOW });
      const webClient = new Client(postgres.connection("web")); await webClient.connect();
      try {
        const web = database(webClient);
        const receipt = await new WebTaskService(web, { tenantId: scope.tenantId, workspaceId: scope.workspaceId }, () => Date.parse(NOW),
          { newsIntegrityKey: KEY }).proposeNewsResearch(identity, scope.projectId, proposal, "news-pg-proposal-0001");
        assert.equal(receipt.receipt.submission, "proposed");
        assert.equal(receipt.receipt.startsWork, false);
        const link = await new PostgresNewsTaskProposalLinksV1(web, scope, KEY).get(receipt.receipt.jobId);
        assert.equal(link?.proposal.proposalDigest, proposal.proposalDigest);
        assert.equal(link?.proposal.verificationFirst, true);
        assert.equal((await web.query<{ count: string }>("SELECT count(*)::text AS count FROM control_attempts WHERE tenant_id=$1", [scope.tenantId])).rows[0]?.count, "0");
        await assert.rejects(web.query("UPDATE control_news_task_proposal_links SET auth_tag=auth_tag"));
      } finally { await webClient.end(); }
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 120_000 });
});
