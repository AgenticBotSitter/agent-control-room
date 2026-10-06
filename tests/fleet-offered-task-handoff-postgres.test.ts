// Real-PostgreSQL proof of what an OFFERED task actually carries to a bot, and
// of what the owner can actually do to it, on the route the installed Mac uses.
//
// Since da1fc5f6a the installed Mac is connector-only: work reaches bots through
// the fleet gateway's "Offer to other machines", NOT through the in-process
// prepare/assign path. QA's round-5 handoff suspicions (R5O-03/04/05) were all
// reproduced against the in-process path. These tests ask the question that
// matters to the owner: does the SAME fault exist on the connector route?
//
// Findings addressed:
//   MR5O-A (R5O-03): a pipeline stage's own description must reach the bot that
//     claims that stage's offered task. Not just the shared run description.
//   MR5O-B (R5O-04): approved acceptance criteria/tests must reach the bot.
//   MR5O-C (R5O-05): the owner's stop on an offered/claimed task.
//
// Every operation under test runs AS the production login that executes it in a
// real installation: the private web login authors the task text, the fleet
// gateway login delivers it, and the fleet owner login makes the offer. The
// schema-owner pool is fixture surgery only (tenant and identity seeding).
//
// The attack kit provisions a disposable socket-only cluster on this file's
// reserved port lane and destroys it afterwards. No real bot CLI is run.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { createFleetGatewayHandlerV1, FleetOwnerServiceV1, FleetWaitRegistryV1 } from "../src/fleet/v1";
import type { FleetGatewayStoreV1 } from "../src/fleet/v1";
import { createFleetGatewayStoreFromConfigurationV1 } from "../scripts/run-fleet-gateway";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, seedFleetTenant } from "./support/fleet-fixture";
import { buildSignedFleetConnectorReleaseForTestV1 } from "./support/fleet-release";
import { LinearPipelineServiceV1 } from "../src/pipelines/v1/service";
import { WebTaskService } from "../src/web/v1/task-service";
import { WebProjectService } from "../src/web/v1/project-service";
import { WorkBatchOwnerServiceV1, WorkBatchStoreV1, workBatchProposalDigestV1 } from "../src/work-intake/v1";
import { sha256Digest } from "../src/security";
import * as connector from "../scripts/fleet/connector.mjs";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59626);
const PG = requiresRealPostgres();
const PIPELINE_KEY = new Uint8Array(32).fill(11);

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, config, close: () => bound.close() };
}

/** Fixture surgery only: schema-owner seeding, never an operation under test. */
function surgeonPool(postgres: RealPostgres) {
  const login = postgres.admin({ database: postgres.database });
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}

/** One pipeline stage's own authenticated description, per stageKind. */
const STAGE_MARKERS = { build: "MR5O_BUILD_MARKER", check: "MR5O_CHECK_MARKER", signoff: "MR5O_SIGNOFF_MARKER" } as const;
const stageKinds = ["build", "check", "signoff"] as const;

/** A three-stage template whose stages each carry a DISTINCT description, built
 * exactly as the product's own template schema requires. */
function markedTemplate() {
  const stage = (ordinal: number, stageKind: "build" | "check" | "signoff",
    role: "builder" | "checker" | "validator", description: string) => ({
    ordinal, stageKind, role, description, requiredCapability: `cap:mr5o-${stageKind}`,
    workerId: `worker:mr5o-${stageKind}`, workerKind: "codex" as const, nodeId: "node:mr5o",
    selectionKey: `sel:${stageKind}`, model: "mr5o-model", effort: "medium" as const,
    provider: null, profile: null, maxLoops: 0,
    ...(stageKind === "build" ? { allowedPaths: ["src/**"], maximumChangedFiles: 10, maximumChangedBytes: 4096 } : {}),
  });
  return {
    name: "MR5O marked template",
    description: "Complete one bounded change.",
    stages: [
      stage(0, "build", "builder", `${STAGE_MARKERS.build} implement it.`),
      stage(1, "check", "checker", `${STAGE_MARKERS.check} review it.`),
      stage(2, "signoff", "validator", `${STAGE_MARKERS.signoff} approve it.`),
    ],
    maxTotalLoops: 6, maxDurationSeconds: 7200,
  };
}

test("an offered task carries what the bot needs, and the owner's stop tells the truth, on real PostgreSQL",
  async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    await withRealPostgres(async postgres => {
      const surgeon = surgeonPool(postgres), web = pool(postgres, "web"), fleet = pool(postgres, "fleet"),
        fleetOwner = pool(postgres, "fleetOwner"), intake = pool(postgres, "control_room_work_intake_agent");
      const dir = await mkdtemp(join(tmpdir(), "mr5o-offered-"));
      let gateway: FleetGatewayStoreV1 | undefined, server: ReturnType<typeof createServer> | undefined;
      try {
        await seedFleetTenant((sql, params) => surgeon.client.query(sql, params));
        const release = await buildSignedFleetConnectorReleaseForTestV1({ root: resolve(dir, "fleet"),
          builtFrom: "0".repeat(40) });
        gateway = createFleetGatewayStoreFromConfigurationV1(fleet.client, { tenantId: FLEET_TENANT,
          workIntake: { database: {} as never, integrityKey: Buffer.alloc(32, 3).toString("base64url") } });
        const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
          afterDecision: () => gateway!.reconcile() });
        const handler = createFleetGatewayHandlerV1({ store: gateway,
          releaseTrust: release.releaseTrust, connectorRelease: release.connectorRelease,
          waitRegistry: new FleetWaitRegistryV1({ waitMs: 60, pollMs: 10 }),
          onUnexpectedError: error => { throw error; } });
        server = createServer((request, response) => { void handler.handle(request, response); });
        await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
        const origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

        // A project created through the product's own project service, so the
        // ordinary propose path below runs against a real catalog row rather
        // than a fixture's.
        const projects = new WebProjectService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
        const madeProject = await projects.create(ownerIdentity(),
          { title: "MR5O ordinary project", summary: "Ordinary proposed tasks." },
          "mr5o-project-create-key-00000000");
        const projectId = madeProject.project.projectId;

        // A real connector client, so the assertions see the bytes a bot sees.
        const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "MR5O worker",
          // A pipeline stage binds workerKind "codex", and the fleet claim path
          // enforces that binding, so the proving worker is a codex one. A
          // mismatch here is the product correctly refusing an ineligible
          // worker, not a fixture shortcut.
          workerKind: "codex", projectIds: [PROJECT_A, projectId],
          capabilities: ["writing", "code.change", "code.review"], maxConcurrent: 8 });
        const configPath = join(dir, "worker.json");
        await connector.join({ server: origin, code: code.code, workerKind: "codex", configPath });
        const client = connector.createClient(await connector.loadConfig(configPath));

        // --- MR5O-A: a pipeline stage's own description must reach the bot.
        // Authored through the product's own pipeline service on the private web
        // login, exactly as the owner's Pipelines page does.
        // The selection authority is what a real installation's registered
        // worker catalogue supplies: it is the check that a template's worker
        // and model are ones this installation actually has. Asserting every
        // stage's real selection rather than stubbing it is the point -- a stub
        // would let any worker through and the handoff proof would be weaker.
        const asserted: string[] = [];
        const pipelines = new LinearPipelineServiceV1(web.client,
          { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE }, PIPELINE_KEY,
          { assertCurrent: async (selected: { workerId: string }) => {
            asserted.push(selected.workerId);
            return selected.workerId.startsWith("worker:mr5o-");
          }, isAcceptedResultCurrent: () => false });
        const template = await pipelines.createTemplate(ownerIdentity(), PROJECT_A, markedTemplate());
        const run = await pipelines.instantiate(ownerIdentity(), PROJECT_A,
          { templateId: template.templateId, title: "MR5O marked run" }, "mr5o-pipeline-run-key-0001");
        assert.equal(run.jobIds.length, 3, "the marked template produced three stage jobs");
        // Checked on create AND on instantiate: the same three registered
        // selections, in stage order, both times.
        assert.deepEqual([...new Set(asserted)], ["worker:mr5o-build", "worker:mr5o-check", "worker:mr5o-signoff"],
          "each stage's registered worker selection was checked before the template was accepted");
        assert.equal(asserted.length, 6, "the selection check ran for both template creation and instantiation");

        const seenByStage = new Map<string, string>();
        // In stage order, because each stage genuinely depends on its
        // predecessor: offering the CHECK stage before BUILD completes is
        // refused by the canonical dependency guard, which is the product
        // behaving correctly and is itself worth exercising.
        for (const [index, stageKind] of stageKinds.entries()) {
          const jobId = run.jobIds[index]!;
          const offered = await owner.offerTask(ownerIdentity(), { projectId: PROJECT_A, jobId, capability: "writing" });
          assert.equal(offered.replayed, false, `stage ${stageKind} offer was created`);
          // The pre-claim listing shows what the claim will hand over.
          const listed = await client.work() as readonly { offerId: string; objective: string }[];
          assert.ok(listed.some((entry: { offerId: string; objective: string }) => entry.offerId === offered.offerId
            && entry.objective.includes(STAGE_MARKERS[stageKind])),
          `the offered stage ${stageKind} listing must show its own instructions`);
          const claim = await client.claim(offered.offerId, `mr5o-key-${stageKind}`);
          seenByStage.set(stageKind, claim.instructions);
          assert.ok(claim.instructions.includes(STAGE_MARKERS[stageKind]),
            `stage ${stageKind} must reach the bot carrying ${STAGE_MARKERS[stageKind]}; got ${JSON.stringify(claim.instructions)}`);
          for (const other of stageKinds.filter(value => value !== stageKind))
            assert.ok(!claim.instructions.includes(STAGE_MARKERS[other]),
              `stage ${stageKind} must not carry sibling ${STAGE_MARKERS[other]}; got ${JSON.stringify(claim.instructions)}`);
          // A blocker note is a worker report, not a result; it hands the task
          // back without marking anything done. The gateway only accepts one
          // from an attempt that has actually started, so the worker posts its
          // start first -- the same order a real bot does.
          // The bot finishes the stage for real: a result closes the attempt and
          // moves the task to waiting_review, so nothing is left leased.
          // Completing the stage is what satisfies the NEXT stage's dependency.
          // The gateway's reconcile is the owner's result review reaching the
          // canonical task, so it is called here exactly as the owner's accept
          // would.
          await client.progress(claim.claimId, `mr5o started ${stageKind}`, `mr5o-progress-${stageKind}`);
          const results = await client.claims();
          void results;
          await client.result(claim.claimId, `mr5o finished ${stageKind}`, [], `mr5o-result-${stageKind}`);
          // The owner accepts, through the production owner login.
          const board = await owner.listResults(ownerIdentity(), { awaitingOnly: true });
          const forStage = board.find(row => row.jobId === jobId);
          assert.ok(forStage, `stage ${stageKind} produced an owner-reviewable result`);
          await owner.review(ownerIdentity(), { resultId: forStage.resultId, decision: "accepted" });
        }
        assert.equal(new Set(seenByStage.values()).size, 3,
          `each stage must have its own instructions; got ${JSON.stringify([...seenByStage])}`);

        // --- MR5O-B: approved acceptance criteria/tests must reach the bot.
        // Driven through the product's OWN work-batch approval path on the
        // private web login: the intake agent proposes, the owner approves, and
        // the approval materialises the job and writes the acceptance
        // requirements the bot must be given. No part of the hand-off row is
        // written by this test.
        const tasks = new WebTaskService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
        const issuedAt = new Date(Date.now() - 60_000).toISOString();
        const PROPOSER = "identity:mr5o-intake-agent";
        await surgeon.client.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,
          auth_provider,auth_subject_digest,state,created_at,updated_at)
          VALUES($1,$2,'agent','MR5O proposer','work-intake',$3,'active',$4,$4)`,
        [PROPOSER, FLEET_TENANT, sha256Digest("mr5o-intake-agent"), issuedAt]);
        await surgeon.client.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,
          allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
          VALUES('grant:mr5o-intake',$1,$2,'work_batch_proposer','["work_batches.propose"]',$3::jsonb,
          'low',false,false,$4,$4)`, [FLEET_TENANT, PROPOSER, JSON.stringify([projectId]), issuedAt]);
        const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
        const proposal = { schema: "control-room.work-batch-proposal/v1", projectId, tasks: [
          { localId: "build", title: "MR5O criteria task", instructions: "Return a short answer.",
            requiredCapability: "writing", role: "builder",
            acceptanceCriteria: "MR5O_CRITERIA_MARKER", acceptanceTests: "MR5O_TESTS_MARKER" }], edges: [] };
        const principal = { tenantId: FLEET_TENANT, identityId: PROPOSER, actorType: "agent" as const,
          authenticatedAt: issuedAt, expiresAt };
        // The proposal is the intake agent's OWN write, so it runs on the
        // provisioned work-intake login rather than the web one.
        const batch = await new WorkBatchStoreV1(intake.client, new Uint8Array(32).fill(9)).create(
          { principal, proposal: proposal as never, proposalDigest: workBatchProposalDigestV1(proposal as never),
            idempotencyKey: "mr5o-batch-proposal-key-0001", now: issuedAt, queueDepthLimit: 5 });
        const batchOwner = new WorkBatchOwnerServiceV1(web.client, tasks,
          { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE }, new Uint8Array(32).fill(9));
        // The intake gate flagged the terse instruction; the owner reviews and
        // dismisses it through the ordinary command, exactly as the owner does
        // on the Pipelines page. Approving with the flag open is refused.
        const flaggedView = await batchOwner.view(ownerIdentity(), projectId, batch.batchId);
        const openFlag = flaggedView.flagsByLocalId.build?.find(flag => !flag.dismissed);
        assert.ok(openFlag, "the intake gate flagged the terse instruction for owner review");
        await assert.rejects(batchOwner.command(ownerIdentity(), projectId,
          { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
            items: [{ localId: "build", decision: "approve" }] }, "mr5o-batch-decide-too-early"),
        /flagged_items_unresolved/u);
        await batchOwner.command(ownerIdentity(), projectId, { operation: "dismiss_flag",
          batchId: batch.batchId, expectedRevision: 1, localId: "build",
          flagKind: openFlag.kind, reasonCode: "owner_dismissed" }, "mr5o-batch-dismiss-key-0001");
        const batchReceipt = await batchOwner.command(ownerIdentity(), projectId,
          { operation: "decide", batchId: batch.batchId, expectedRevision: 1,
            items: [{ localId: "build", decision: "approve" }] }, "mr5o-batch-decide-key-0001");
        assert.equal(batchReceipt.jobIds.length, 1, "the owner approval materialised exactly one job");
        const criteriaJobId = batchReceipt.jobIds[0]!;

        const criteriaOffer = await owner.offerTask(ownerIdentity(), { projectId, jobId: criteriaJobId,
          capability: "writing" });
        const criteriaClaim = await client.claim(criteriaOffer.offerId, "mr5o-key-criteria");
        assert.ok(criteriaClaim.instructions.includes("MR5O_CRITERIA_MARKER"),
          `approved acceptance criteria must reach the bot; got ${JSON.stringify(criteriaClaim.instructions)}`);
        assert.ok(criteriaClaim.instructions.includes("MR5O_TESTS_MARKER"),
          `approved acceptance tests must reach the bot; got ${JSON.stringify(criteriaClaim.instructions)}`);
        assert.ok(criteriaClaim.instructions.includes("Return a short answer."),
          `the task instruction itself must still reach the bot; got ${JSON.stringify(criteriaClaim.instructions)}`);
        await client.progress(criteriaClaim.claimId, "mr5o started criteria", "mr5o-progress-criteria");
        await client.result(criteriaClaim.claimId, "mr5o finished criteria", [], "mr5o-result-criteria");

        // --- MR5O-B2: a hand-off row that fails its own digest is NOT delivered.
        // The guard that makes an unauthorised row unusable rather than
        // trusted. Tampered with the schema owner's connection, because no
        // application login can do this -- which is the point: the refusal is
        // proven at the reader, not only at the write path.
        const tampered = await tasks.propose(ownerIdentity(), projectId,
          { title: "MR5O tampered task", instructions: "Original instruction." },
          "mr5o-tamper-propose-key-0000000000");
        // The write-once trigger refuses this outright, even for the schema
        // owner; that refusal is asserted separately below. Here the trigger is
        // disabled for one statement, which is the "trusted operator with
        // database access" case the reader's own digest check exists to
        // survive. A reader that trusted the text would send it.
        await surgeon.client.query("ALTER TABLE control_task_handoffs DISABLE TRIGGER control_task_handoffs_immutable");
        try {
          await surgeon.client.query(`UPDATE control_task_handoffs SET instructions='MR5O_TAMPERED_TEXT'
            WHERE tenant_id=$1 AND job_id=$2`, [FLEET_TENANT, tampered.receipt.jobId]);
        } finally {
          await surgeon.client.query("ALTER TABLE control_task_handoffs ENABLE TRIGGER control_task_handoffs_immutable");
        }
        // The private driver deliberately discards the server's message text, so
        // the refusal is matched on its SQLSTATE: P0001 is the raised-exception
        // state, which is what the write-once trigger raises and what no
        // successful statement can produce here.
        const raisedException = { code: "P0001", sqlState: "P0001" };
        for (const [statement, params, why] of [
          [`UPDATE control_task_handoffs SET instructions='MR5O_SECOND_TAMPER'
            WHERE tenant_id=$1 AND job_id=$2`, [FLEET_TENANT, tampered.receipt.jobId],
          "the hand-off row must be write-once for every login, including the schema owner"],
          [`DELETE FROM control_task_handoffs WHERE tenant_id=$1 AND job_id=$2`,
            [FLEET_TENANT, tampered.receipt.jobId], "a hand-off row may never be deleted"],
        ] as ReadonlyArray<readonly [string, unknown[], string]>) {
          await assert.rejects(surgeon.client.query(statement, [...params]), (error: unknown) => {
            assert.equal((error as { sqlState?: string }).sqlState, raisedException.sqlState,
              `${why} (refused with ${String((error as { sqlState?: string }).sqlState)})`);
            return true;
          });
        }

        const tamperedOffer = await owner.offerTask(ownerIdentity(), { projectId,
          jobId: tampered.receipt.jobId, capability: "writing" });
        const tamperedClaim = await client.claim(tamperedOffer.offerId, "mr5o-key-tampered");
        assert.ok(!tamperedClaim.instructions.includes("MR5O_TAMPERED_TEXT"),
          `a row that fails its stored digest must not be delivered; got ${JSON.stringify(tamperedClaim.instructions)}`);
        assert.equal(tamperedClaim.instructions, "Original instruction.",
          "an unverifiable row falls back to the request objective rather than being taken on trust");
        await client.progress(tamperedClaim.claimId, "mr5o started tampered", "mr5o-progress-tampered");
        await client.result(tamperedClaim.claimId, "mr5o finished tampered", [], "mr5o-result-tampered");

        // --- MR5O-C: the owner's stop on a claimed task.
        const cancelTask = await tasks.propose(ownerIdentity(), projectId,
          { title: "MR5O cancel task", instructions: "Do the cancellable thing." },
          "mr5o-cancel-propose-key-000000000000");
        const cancelOffer = await owner.offerTask(ownerIdentity(), { projectId,
          jobId: cancelTask.receipt.jobId, capability: "writing" });
        const cancelClaim = await client.claim(cancelOffer.offerId, "mr5o-key-cancel");
        // A progress note is the worker's own start evidence; it moves the
        // canonical attempt to running.
        await client.progress(cancelClaim.claimId, "mr5o started", "mr5o-progress-cancel");
        const claimRow = (await surgeon.client.query<{ attempt_id: string }>(
          "SELECT attempt_id FROM fleet_claims WHERE claim_id=$1", [cancelClaim.claimId])).rows[0]!;
        const started = (await surgeon.client.query<{ state: string }>("SELECT state FROM control_attempts WHERE id=$1",
          [claimRow.attempt_id])).rows[0]!;
        assert.equal(started.state, "running", "a progress note starts the canonical attempt");

        // The only owner stop the connector route offers is withdrawing the
        // offer. A live claim must REFUSE it, because the bot is working: the
        // owner's own words must not claim the task stopped.
        await assert.rejects(() => owner.withdrawOffer(ownerIdentity(), cancelOffer.offerId),
          /conflict/u, "withdrawing an offer with a live claim must refuse, not silently strand a running bot");
        const stillRunning = (await surgeon.client.query<{ state: string }>(
          "SELECT state FROM control_jobs WHERE id=$1", [cancelTask.receipt.jobId])).rows[0]!;
        assert.equal(stillRunning.state, "running", "a refused withdrawal leaves the running task untouched");

        // The bot keeps going and finishes; the owner reviews the result.
        await client.result(cancelClaim.claimId, "mr5o finished anyway", [], "mr5o-result-cancel");
        const finished = (await surgeon.client.query<{ state: string }>("SELECT state FROM control_jobs WHERE id=$1",
          [cancelTask.receipt.jobId])).rows[0]!;
        assert.equal(finished.state, "waiting_approval",
          "the finished bot's result waits for the owner rather than marking itself done");
        // And the owner's decision is the only thing that closes it.
        const cancelResults = await owner.listResults(ownerIdentity(), { awaitingOnly: true });
        const cancelResult = cancelResults.find(row => row.jobId === cancelTask.receipt.jobId);
        assert.ok(cancelResult, "the late result is waiting for the owner's review");
        assert.equal(cancelResult.taskState, "waiting_approval", "a result never marks the task done by itself");
        await owner.review(ownerIdentity(), { resultId: cancelResult.resultId, decision: "accepted" });
        const accepted = (await surgeon.client.query<{ state: string }>("SELECT state FROM control_jobs WHERE id=$1",
          [cancelTask.receipt.jobId])).rows[0]!;
        assert.equal(accepted.state, "succeeded", "only the owner's accept closes the task");
      } finally {
        await new Promise<void>(done => { server ? server.close(() => done()) : done(); });
        await Promise.allSettled([surgeon.close(), web.close(), fleet.close(), fleetOwner.close(), intake.close()]);
        await rm(dir, { recursive: true, force: true });
      }
    }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
  });