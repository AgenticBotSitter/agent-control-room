// Every field at its own maximum still creates the task, on real PostgreSQL 17.
//
// rv-mr5o Finding 2: `composeWorkerInstructionsV1` bounded the composition at
// 16,000 characters while the column it writes into --
// `control_task_handoffs.instructions`, `CHECK (length(instructions) BETWEEN 1
// AND 4000)` -- accepts 4,000. The composition is written in the SAME
// transaction that creates the job, so an ordinary owner approval whose
// instructions plus acceptance criteria plus acceptance tests were merely
// DETAILED aborted the whole task creation with a raw constraint violation
// instead of either succeeding or failing cleanly. The review's own repro used
// 1,000 + 2,000 + 2,000 characters and produced 5,081.
//
// This test is the ceiling the review asked for: every field at its own schema
// maximum, authored through the product's own services as the production login,
// and the job must EXIST afterwards. Not "the composition function returns
// something short" -- the row in the table, because the CHECK is the contract
// and only the database can refuse it. The stored text is read back and its
// length asserted against the column's own bound, read out of pg_constraint
// rather than restated here, so this test fails if the bound and the code ever
// disagree again.
//
// Two paths, because two different ceilings reach this column:
//   1. The ordinary proposal path (taskDraftSchema): instructions 4,000,
//      criteria 2,000, tests 2,000 -> 8,000 characters before truncation.
//   2. The owner-approved batch path (workBatchProposalTaskSchemaV1): all
//      three at 4,000 -> 12,000 characters before truncation. This is the
//      route Finding 2 was reported on and the one whose per-field limits are
//      all 4,000.
//
// Both must succeed with a visible truncation marker, because a worker handed
// text silently cut at a block boundary cannot tell the difference between
// "these are all the requirements" and "these are the requirements that fit".
//
// Every operation under test runs as the login that performs it in a real
// installation: the private web login authors, the fleet gateway login
// delivers. The schema-owner pool is fixture surgery only.
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
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, seedFleetTenant } from "./support/fleet-fixture";
import { buildSignedFleetConnectorReleaseForTestV1 } from "./support/fleet-release";
import { WebTaskService } from "../src/web/v1/task-service";
import { WebProjectService } from "../src/web/v1/project-service";
import { WorkBatchOwnerServiceV1, WorkBatchStoreV1, workBatchProposalDigestV1 } from "../src/work-intake/v1";
import { composeWorkerInstructionsV1, TASK_HANDOFF_LIMITS_V1 } from "../src/web/v1/task-handoff";
import { sha256Digest } from "../src/security";
import * as connector from "../scripts/fleet/connector.mjs";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59626) + 3;
const PG = requiresRealPostgres();

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

/** Text of an exact length. The markers used are single characters that occur
 * NOWHERE in the composer's own header text, so an assertion can say which
 * block survived without matching the word "criteria" or "tests". */
const ofLength = (char: string, length: number) => char.repeat(length);
const INSTRUCTION_MARKER = "\u00a8", CRITERIA_MARKER = "\u00b1", TESTS_MARKER = "\u00e3";

test("every field at its own maximum still creates the task, and the truncation is visible",
  async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    await withRealPostgres(async postgres => {
      const surgeon = surgeonPool(postgres), web = pool(postgres, "web"), fleet = pool(postgres, "fleet"),
        fleetOwner = pool(postgres, "fleetOwner"), intake = pool(postgres, "control_room_work_intake_agent");
      const dir = await mkdtemp(join(tmpdir(), "mr5ofix-bound-"));
      let gateway: FleetGatewayStoreV1 | undefined, server: ReturnType<typeof createServer> | undefined;
      try {
        await seedFleetTenant((sql, params) => surgeon.client.query(sql, params));

        // THE COLUMN'S OWN BOUND, read out of the live catalog rather than
        // restated in this file. If the migration's CHECK and the composing
        // code ever disagree again, this is where the two meet, and the failure
        // names the migration instead of the test.
        // The CHECK constraint is named after the column, so asking for the one
        // whose definition mentions `instructions` cannot pick up a neighbour.
        // The bound is parsed out of `pg_get_constraintdef` rather than restated
        // here, because a restated number is the thing that drifted in Finding 2.
        const checkDef = async (columnName: string) => (await surgeon.client.query<{ def: string }>(
          `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
             JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
           WHERE n.nspname='public' AND r.relname='control_task_handoffs' AND c.contype='c'
             AND pg_get_constraintdef(c.oid) LIKE '%length(${columnName})%'`)).rows[0]?.def;
        const boundOf = (definition: string, columnName: string) => {
          // pg_get_constraintdef renders the bound as
          // `CHECK (((length(instructions) >= 1) AND (length(instructions) <= 4000)))`,
          // so both sides are matched off the same shape.
          const bound = new RegExp(String.raw`length\(${columnName}\) >= ([0-9]+)\) AND \(length\(${columnName}\) <= ([0-9]+)\)`, "u")
            .exec(definition);
          assert.ok(bound,
            `the CHECK for ${columnName} must bound it on both sides; the catalog says ${definition}`);
          return { maximum: Number(bound![2]), minimum: Number(bound![1]) };
        };
        const instructionCheck = await checkDef("instructions");
        assert.ok(instructionCheck, "control_task_handoffs carries a CHECK on instructions");
        const instructionBound = boundOf(instructionCheck!, "instructions");
        assert.equal(instructionBound.maximum, TASK_HANDOFF_LIMITS_V1.instructions,
          "the composing code's ceiling IS the column's own CHECK bound, read from the live catalog");
        assert.equal(instructionBound.minimum, 1,
          "and the column still refuses an empty instruction");
        // The two requirement columns must accept what the owner-facing schemas
        // allow, so a maximum-length owner approval is storable at all.
        for (const columnName of ["acceptance_criteria", "acceptance_tests"] as const) {
          const definition = await checkDef(columnName);
          assert.ok(definition, `control_task_handoffs carries a CHECK on ${columnName}`);
          const bound = boundOf(definition!, columnName);
          assert.ok(bound.maximum >= 4_000,
            `${columnName} must accept the 4,000 characters the owner-facing schemas allow;`
            + ` the catalog says ${bound.maximum}`);
        }

        const release = await buildSignedFleetConnectorReleaseForTestV1({ root: resolve(dir, "fleet"),
          builtFrom: "0".repeat(40) });
        gateway = createFleetGatewayStoreFromConfigurationV1(fleet.client, { tenantId: FLEET_TENANT,
          workIntake: { database: {} as never, integrityKey: Buffer.alloc(32, 3).toString("base64url") } });
        const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
          afterDecision: () => gateway!.reconcile() });
        const handler = createFleetGatewayHandlerV1({ store: gateway, releaseTrust: release.releaseTrust,
          connectorRelease: release.connectorRelease, waitRegistry: new FleetWaitRegistryV1({ waitMs: 60, pollMs: 10 }),
          onUnexpectedError: error => { throw error; } });
        server = createServer((request, response) => { void handler.handle(request, response); });
        await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
        const origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;

        const projects = new WebProjectService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
        const made = await projects.create(ownerIdentity(), { title: "MR5OFIX bound project",
          summary: "Every field at its own maximum." }, "mr5ofix-project-create-key-000");
        const projectId = made.project.projectId;
        const tasks = new WebTaskService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });

        const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "MR5OFIX worker",
          workerKind: "codex", projectIds: [made.project.projectId],
          capabilities: ["writing", "code.change", "code.review"], maxConcurrent: 4 });
        const configPath = join(dir, "worker.json");
        await connector.join({ server: origin, code: code.code, workerKind: "codex", configPath });
        const client = connector.createClient(await connector.loadConfig(configPath));

        // Every stored hand-off must satisfy the column. One reader of the row
        // for both paths, because the question is the same for each.
        const storedRow = async (jobId: string) => (await surgeon.client.query<{ instructions: string;
          acceptance_criteria: string | null; acceptance_tests: string | null }>(
          "SELECT instructions,acceptance_criteria,acceptance_tests FROM control_task_handoffs"
          + " WHERE tenant_id=$1 AND job_id=$2", [FLEET_TENANT, jobId])).rows[0];
        /** The job a batch item's approval made, or undefined if it made none.
         * A refused approval must leave nothing behind, and this is how the
         * test asks that without guessing an id. */
        const jobIdOfLocalId = async (localId: string): Promise<string> => (await surgeon.client.query<{ job_id: string | null }>(
          "SELECT job_id FROM work_batch_items WHERE tenant_id=$1 AND local_id=$2", [FLEET_TENANT, localId]))
          .rows[0]?.job_id ?? "";

        // ---- PATH 1: the ordinary proposal, every field at its own maximum.
        // `taskDraftSchema`'s real limits, not an invented size: instructions
        // 4,000, acceptance criteria and tests 2,000 each.
        const MAX_TASK_DRAFT = Object.freeze({ instructions: 4_000, criteria: 2_000, tests: 2_000 } as const);
        const draft = { title: "MR5OFIX maximum draft",
          instructions: ofLength(INSTRUCTION_MARKER, MAX_TASK_DRAFT.instructions),
          acceptanceCriteria: ofLength(CRITERIA_MARKER, MAX_TASK_DRAFT.criteria),
          acceptanceTests: ofLength(TESTS_MARKER, MAX_TASK_DRAFT.tests) };
        // The INPUT is over the column, which is the whole point: the composed
        // text is the three fields plus their two headers and the separators
        // between them, and this asserts that from the fields themselves rather
        // than from the composer, so the test still means something if the
        // composer is changed again. Asserting on the composer's OUTPUT would
        // have passed trivially before the fix, when it returned 5,081
        // characters because nothing bounded it, and passes now because
        // something does.
        const inputLength = draft.instructions.length + draft.acceptanceCriteria.length
          + draft.acceptanceTests.length
          + "Acceptance criteria the owner approved:".length + "Acceptance tests the owner approved:".length
          + 3 * "\n\n".length;
        assert.ok(inputLength > TASK_HANDOFF_LIMITS_V1.instructions,
          `a composition of every field at its own maximum must exceed the column's bound, or this test`
          + ` proves nothing (input ${inputLength} vs ceiling ${TASK_HANDOFF_LIMITS_V1.instructions})`);
        // And the composer really does bring it back under, with the notice.
        const composed = composeWorkerInstructionsV1(draft);
        assert.ok(composed.length <= TASK_HANDOFF_LIMITS_V1.instructions,
          `the shipped composer bounds its output (${composed.length})`);
        assert.ok(composed.endsWith(TASK_HANDOFF_LIMITS_V1.truncationNotice),
          "and says so in the text it returns");
        // The bug itself, measured on the shipped function before the path runs.
        const proposed = await tasks.propose(ownerIdentity(), projectId, draft, "mr5ofix-max-draft-propose-key-01");
        const draftRow = await storedRow(proposed.receipt.jobId);
        assert.ok(draftRow, "the maximum draft created its job AND its hand-off row");
        assert.ok(draftRow!.instructions.length <= TASK_HANDOFF_LIMITS_V1.instructions,
          `the stored instructions are within the column's bound (${draftRow!.instructions.length})`);
        assert.ok(draftRow!.instructions.startsWith(INSTRUCTION_MARKER),
          "the task text itself survives: truncation is not allowed to invent or reorder the head");
        assert.ok(draftRow!.instructions.endsWith(TASK_HANDOFF_LIMITS_V1.truncationNotice),
          `a truncated composition says so; tail was ${JSON.stringify(draftRow!.instructions.slice(-40))}`);
        assert.ok(draftRow!.instructions.includes(TASK_HANDOFF_LIMITS_V1.truncationNotice),
          "the truncation marker appears exactly once, not once per dropped block");
        assert.equal((draftRow!.instructions.match(
          new RegExp(TASK_HANDOFF_LIMITS_V1.truncationNotice.replaceAll(/[[\]\\^$.*+?(){}|]/gu, String.raw`\$&`), "gu")) ?? []).length,
        1, "the truncation marker is not repeated");
        // The bound is on JavaScript `.length` (UTF-16 code units) while the column
        // checks PostgreSQL's `length()` (unicode characters). That is safe in
        // the direction that matters, and it was measured rather than assumed:
        // on a real UTF8 cluster, `length()` is never GREATER than the code-unit
        // count for any input (astral emoji: 10 characters against 20 code
        // units), so a value at the code-unit ceiling is always at or under the
        // column's character bound. The database would only ever see a shorter
        // value than the code believes.
        const multibyte = ofLength("\u{1F600}", 4_000) + ofLength(CRITERIA_MARKER, 2_000);
        const multibyteRow = composeWorkerInstructionsV1({ instructions: multibyte.slice(0, 4_000),
          acceptanceCriteria: null, acceptanceTests: null });
        assert.ok(multibyteRow.length <= TASK_HANDOFF_LIMITS_V1.instructions,
          `astral-plane text at the ceiling composes within the bound (${multibyteRow.length})`);
        const multibyteTask = await tasks.propose(ownerIdentity(), projectId,
          { title: "MR5OFIX astral draft", instructions: multibyte.slice(0, 4_000) },
          "mr5ofix-astral-propose-key-0001");
        const astralRow = await storedRow(multibyteTask.receipt.jobId);
        assert.ok(astralRow, "an astral-plane instruction creates its hand-off row like any other");
        const measured = (await surgeon.client.query<{ characters: number }>(
          "SELECT length(instructions) AS characters FROM control_task_handoffs"
          + " WHERE tenant_id=$1 AND job_id=$2", [FLEET_TENANT, multibyteTask.receipt.jobId])).rows[0];
        assert.ok(measured && measured.characters <= TASK_HANDOFF_LIMITS_V1.instructions,
          `and the database agrees it is within its own bound (${measured?.characters} characters)`);
        // and the row's own requirement columns stay empty on this route. That
        // is not an accident of the fixture and is asserted rather than worked
        // around: `proposeWithDependenciesInSession` passes
        // `acceptanceCriteria`/`acceptanceTests` NESTED inside its call to
        // `composeWorkerInstructionsV1`, so `recordTaskHandoffInSession` receives
        // them as undefined and writes null. The approved requirements therefore
        // reach the worker inside `instructions`, which is the delivery contract,
        // and the dedicated columns are unused on both authoring paths. Pinning
        // that here means a change which starts writing them is a deliberate,
        // visible one rather than a silent behaviour shift for the reader.
        assert.equal(draftRow!.acceptance_criteria, null,
          "the ordinary propose route carries the approved requirements inside instructions, not in this column");
        assert.equal(draftRow!.acceptance_tests, null, "and likewise for the tests column");
        // At this length the requirements cannot fit, so they are dropped -- and
        // the ONLY thing that tells the worker so is the marker. Without it a
        // worker would read a truncated task as the whole task.
        assert.ok(!draftRow!.instructions.includes(CRITERIA_MARKER),
          "at the maximum, the criteria block does not fit and is not smuggled in");

        // ---- PATH 2: the owner-approved batch item. The route Finding 2 was
        // reported on, and the one whose INTAKE schema (`workBatchProposalTaskSchemaV1`)
        // allows 4,000 per field -- so the naive reading is that 12,000
        // characters reach the composer.
        //
        // They do not, and the reason is worth pinning rather than hiding:
        // `WorkBatchOwnerServiceV1` re-validates the approved item through
        // `proposeWithDependenciesInSession`, which parses it with
        // `taskDraftSchema` -- whose `acceptanceCriteria`/`acceptanceTests` are
        // 2,000 and whose `title` is 120, both narrower than the intake schema's
        // 4,000 and 180. The largest text the product JOINTLY accepts on this
        // route is therefore instructions 4,000 + criteria 2,000 + tests 2,000,
        // and that is what must succeed. The raw intake maximum is exercised
        // below too, to prove it is refused CLEANLY rather than by a raw CHECK
        // violation -- which is the actual claim this test exists to make.
        const JOINT_MAXIMUM = Object.freeze({ instructions: 4_000, criteria: 2_000, tests: 2_000, title: 120 } as const);
        const issuedAt = new Date(Date.now() - 60_000).toISOString();
        const PROPOSER = "identity:mr5ofix-intake-agent";
        await surgeon.client.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,
          auth_provider,auth_subject_digest,state,created_at,updated_at)
          VALUES($1,$2,'agent','MR5OFIX proposer','work-intake',$3,'active',$4,$4)`,
        [PROPOSER, FLEET_TENANT, sha256Digest("mr5ofix-intake-agent"), issuedAt]);
        await surgeon.client.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,
          allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
          VALUES('grant:mr5ofix-intake',$1,$2,'work_batch_proposer','["work_batches.propose"]',$3::jsonb,
          'low',false,false,$4,$4)`, [FLEET_TENANT, PROPOSER, JSON.stringify([projectId]), issuedAt]);
        const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
        const proposeBatch = async (localId: string, fields: { title: string; instructions: string;
          acceptanceCriteria: string; acceptanceTests: string }, keySuffix: string) => {
          const batchProposal = { schema: "control-room.work-batch-proposal/v1", projectId, tasks: [
            { localId, title: fields.title, instructions: fields.instructions, requiredCapability: "writing",
              role: "builder", acceptanceCriteria: fields.acceptanceCriteria,
              acceptanceTests: fields.acceptanceTests }], edges: [] };
          const batch = await new WorkBatchStoreV1(intake.client, new Uint8Array(32).fill(9)).create(
            { principal: { tenantId: FLEET_TENANT, identityId: PROPOSER, actorType: "agent" as const,
              authenticatedAt: issuedAt, expiresAt },
              proposal: batchProposal as never, proposalDigest: workBatchProposalDigestV1(batchProposal as never),
              idempotencyKey: `mr5ofix-batch-proposal-key-${keySuffix}`, now: issuedAt, queueDepthLimit: 5 });
          const ownerOf = new WorkBatchOwnerServiceV1(web.client, tasks,
            { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE }, new Uint8Array(32).fill(9));
          const flagged = await ownerOf.view(ownerIdentity(), projectId, batch.batchId);
          const openFlag = flagged.flagsByLocalId[localId]?.find(flag => !flag.dismissed);
          if (openFlag) await ownerOf.command(ownerIdentity(), projectId, { operation: "dismiss_flag",
            batchId: batch.batchId, expectedRevision: 1, localId, flagKind: openFlag.kind,
            reasonCode: "owner_dismissed" }, `mr5ofix-batch-dismiss-key-${keySuffix}`);
          return ownerOf.command(ownerIdentity(), projectId, { operation: "decide", batchId: batch.batchId,
            expectedRevision: 1, items: [{ localId, decision: "approve" }] }, `mr5ofix-batch-decide-key-${keySuffix}`);
        };

        // THE ASSERTION FINDING 2 IS ABOUT: this call used to throw
        // `control_task_handoffs_instructions_check` and roll the whole owner
        // approval back. It must SUCCEED, at the joint maximum.
        const receipt = await proposeBatch("maximum", {
          title: "M".repeat(JOINT_MAXIMUM.title),
          instructions: ofLength(INSTRUCTION_MARKER, JOINT_MAXIMUM.instructions),
          acceptanceCriteria: ofLength(CRITERIA_MARKER, JOINT_MAXIMUM.criteria),
          acceptanceTests: ofLength(TESTS_MARKER, JOINT_MAXIMUM.tests) }, "001");
        assert.equal(receipt.jobIds.length, 1, "the owner's maximum-length approval materialised a job");
        const batchRow = await storedRow(receipt.jobIds[0]!);
        assert.ok(batchRow, "and wrote its hand-off row in the same transaction");
        assert.ok(batchRow!.instructions.length <= TASK_HANDOFF_LIMITS_V1.instructions,
          `the maximum batch item's stored instructions are within the column (${batchRow!.instructions.length})`);
        assert.equal(batchRow!.instructions.endsWith(TASK_HANDOFF_LIMITS_V1.truncationNotice), true,
          "and the truncation is visible in what is stored");
        // Nothing is smuggled in past the bound. The markers are DISTINCT single
        // characters precisely so they cannot collide with the composer's own
        // header text ("Acceptance criteria the owner approved:") -- an earlier
        // version of this assertion looked for a lowercase "c" and matched the
        // word "criteria" in the header, which proves nothing either way.
        assert.ok(!batchRow!.instructions.includes(CRITERIA_MARKER) && !batchRow!.instructions.includes(TESTS_MARKER),
          "neither requirement block is smuggled past the bound");
        // The owner's approved text is not LOST by the bound: it is still in
        // the batch row it was approved from. The bound is on delivery, not on
        // what the owner wrote.
        const approved = (await surgeon.client.query<{ acceptance_criteria: string; acceptance_tests: string }>(
          `SELECT coalesce(i.acceptance_criteria,'') AS acceptance_criteria,
                  coalesce(i.acceptance_tests,'') AS acceptance_tests
             FROM work_batch_items i WHERE i.tenant_id=$1 AND i.local_id='maximum'`, [FLEET_TENANT])).rows[0];
        assert.equal(approved?.acceptance_criteria.length, JOINT_MAXIMUM.criteria,
          "the owner's approved criteria are still intact where they were approved");
        assert.equal(approved?.acceptance_tests.length, JOINT_MAXIMUM.tests,
          "and likewise for the approved tests");

        // ---- THE RAW INTAKE MAXIMUM, at 4,000 per field. Whatever happens, it
        // must not be a raw `violates check constraint`: either the product's
        // own narrower schema refuses it as a validation error, or it is
        // accepted and truncated. A raw database error here is the exact
        // failure Finding 2 names, and this is the assertion that would catch it
        // coming back.
        await assert.rejects(() => proposeBatch("rawmax", {
          title: "R".repeat(120), instructions: ofLength(INSTRUCTION_MARKER, 4_000),
          acceptanceCriteria: ofLength(CRITERIA_MARKER, 4_000), acceptanceTests: ofLength(TESTS_MARKER, 4_000) }, "002"),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "invalid_request",
            `a 4,000-character requirement is refused by the product's own validation, never by the database:`
            + ` got ${String((error as { code?: string }).code)} ${String((error as Error).message).slice(0, 160)}`);
          return true;
        });
        assert.equal((await storedRow(await jobIdOfLocalId("rawmax")) ?? undefined) === undefined, true,
          "and the refused approval wrote no job and no hand-off row");

        // ---- AND IT REACHES THE BOT, within the delivery's own bounds. The
        // claim view composes again from the stored row, so this proves the
        // SECOND composition is bounded too -- which is where a truncated
        // composition would otherwise be cut a second time.
        for (const [label, slug, jobId] of [["maximum draft", "draft", proposed.receipt.jobId],
          ["maximum batch item", "batch", receipt.jobIds[0]!]] as const) {
          const offer = await owner.offerTask(ownerIdentity(), { projectId, jobId, capability: "writing" });
          const claim = await client.claim(offer.offerId, `mr5ofix-key-${slug}`);
          assert.ok(claim.instructions.length > 0,
            `the ${label} reaches the bot with text, not an empty instruction`);
          assert.ok(claim.instructions.length <= TASK_HANDOFF_LIMITS_V1.instructions,
            `what the bot receives for the ${label} is within the delivery bound`
            + ` (${claim.instructions.length} > ${TASK_HANDOFF_LIMITS_V1.instructions})`);
          // The truncation survives the second composition rather than being
          // truncated away, so the worker is still told the requirements were cut.
          assert.ok(claim.instructions.includes(TASK_HANDOFF_LIMITS_V1.truncationNotice),
            `the ${label} still says its requirements were truncated on the way to the bot`);
          await client.progress(claim.claimId, "mr5ofix started", `mr5ofix-progress-${slug}`);
          await client.result(claim.claimId, "mr5ofix finished", [], `mr5ofix-result-${slug}`);
        }
      } finally {
        await new Promise<void>(done => { server ? server.close(() => done()) : done(); });
        await Promise.allSettled([surgeon.close(), web.close(), fleet.close(), fleetOwner.close(), intake.close()]);
        await rm(dir, { recursive: true, force: true });
      }
    }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
  });