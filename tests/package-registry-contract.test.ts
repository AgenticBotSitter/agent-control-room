import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { hermesAdapterManifestV1 } from "../src/harness/hermes-v1";
import { adaptPglite } from "../src/persistence/database";
import { PackageRegistryErrorV1, PackageRegistryStoreV1, PACKAGE_REGISTRY_SCHEMA_VERSION_V1, evaluatePackageCompatibilityV1, registryPackageSchemaV1 } from "../src/package-registry/v1";
import { sha256Digest } from "../src/security";
import type { PackageActivationCommandV1, PackageHarnessMappingInputV1, PackageReviewV1, ProcedurePackageV1, RegistryPackageV1 } from "../src/package-registry/v1";

const at = "2026-08-28T15:00:00.000Z";
const later = "2026-08-28T15:01:00.000Z";
const evidence = (name: string) => sha256Digest({ evidence: name });
const registryIntegrityKey = new Uint8Array(32).fill(0x71);

async function setup(): Promise<{ raw: PGlite; store: PackageRegistryStoreV1 }> {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((entry) => entry.endsWith(".sql")).sort()) await raw.exec(await readFile(resolve("db/migrations",file),"utf8"));
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:registry','Registry')`);
  await raw.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES ('workspace:registry','tenant:registry','Registry')`);
  await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,redaction_policy_version,cursor_retention_days) VALUES ('adapter:source','tenant:registry','fixture','v1','advisory','v1',30)`);
  await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload) VALUES ('project:registry','tenant:registry','workspace:registry','adapter:source','source:registry','v1','Registry','ready','ready','healthy','advisory',$1,'{}'::jsonb)`,[at]);
  return { raw,store: new PackageRegistryStoreV1(adaptPglite(raw),registryIntegrityKey) };
}

function procedure(version = "1.0.0", id = `package:procedure:${version}`): ProcedurePackageV1 {
  return {
    schemaVersion: PACKAGE_REGISTRY_SCHEMA_VERSION_V1,id,tenantId:"tenant:registry",projectId:"project:registry",kind:"procedure",name:"build-and-check",version,
    provenance:{ sourceType: version === "1.0.0" ? "owner" : "run_outcome",sourceId:`source:${version}`,sourceDigest:evidence(`source-${version}`),producerId:"worker:producer",producedAt:at },
    compatibility:[{ adapterId:hermesAdapterManifestV1.adapterId,adapterVersion:hermesAdapterManifestV1.adapterVersion,harness:"hermes",harnessVersion:hermesAdapterManifestV1.harnessVersion,requiredVerbs:["start","stream"],supportedPlatforms:["linux","macos","windows"] }],
    separation:{ grantsAuthority:false,suppliesPolicy:false,containsCredentials:false },createdAt:at,
    content:{ objective:"Build the bounded change and return evidence.",steps:[{id:"step:build",instruction:"Apply only the requested project change."}],acceptanceSteps:[{id:"check:test",check:"Run the named deterministic verification."}],inputRoles:["work packet"],outputRoles:["artifact reference","verification evidence"] },
  };
}

function review(item: ProcedurePackageV1, digest: string, decision: "accepted" | "rejected", id = `review:${item.version}:${decision}`): PackageReviewV1 {
  return { schemaVersion:PACKAGE_REGISTRY_SCHEMA_VERSION_V1,id,tenantId:item.tenantId,projectId:item.projectId,packageId:item.id,packageDigest:digest,producerId:item.provenance.producerId,reviewerId:"worker:independent-reviewer",decision,reasonCode:decision === "accepted" ? "contract_verified" : "acceptance_incomplete",evidenceDigests:[evidence(id)],reviewedAt:later };
}

function mapping(item: ProcedurePackageV1, digest: string, id = `mapping:${item.version}`): PackageHarnessMappingInputV1 {
  return { schemaVersion:PACKAGE_REGISTRY_SCHEMA_VERSION_V1,id,tenantId:item.tenantId,projectId:item.projectId,packageId:item.id,packageDigest:digest,adapterId:hermesAdapterManifestV1.adapterId,adapterVersion:hermesAdapterManifestV1.adapterVersion,harness:"hermes",harnessVersion:hermesAdapterManifestV1.harnessVersion,platform:"macos",verifiedVerbs:["start","stream"],decision:"verified",verifierId:"worker:mapping-reviewer",evidenceDigests:[evidence(id)],verifiedAt:later };
}

function activation(item: ProcedurePackageV1, digest: string, reviewId: string, mappingId: string, expectedActiveDigest: string | null, action: "promote" | "rollback" = "promote"): PackageActivationCommandV1 {
  return { schemaVersion:PACKAGE_REGISTRY_SCHEMA_VERSION_V1,id:`activation:${action}:${item.version}`,tenantId:item.tenantId,projectId:item.projectId,packageId:item.id,packageDigest:digest,reviewId,mappingId,actorId:"actor:registry-controller",expectedActiveDigest,action,reasonCode:action === "promote" ? "review_gate_passed" : "restore_prior_reviewed_version",activatedAt:later };
}

async function acceptedVersion(store: PackageRegistryStoreV1, item: ProcedurePackageV1) {
  const registered = await store.register(item); const accepted = review(item,registered.stored.packageDigest,"accepted"); const verified = mapping(item,registered.stored.packageDigest);
  await store.review(accepted); await store.recordMapping(verified,hermesAdapterManifestV1);
  return { digest:registered.stored.packageDigest,review:accepted,mapping:verified };
}

test("CR7E schemas keep procedures, facts, policy, authority, and credentials separate", () => {
  assert.equal(registryPackageSchemaV1.safeParse(procedure()).success,true);
  for (const hostile of [
    { ...procedure(),authority:{ operations:["deploy"] } },
    { ...procedure(),policy:{ allow:true } },
    { ...procedure(),credentialRefs:["credential:prod"] },
    { ...procedure(),separation:{ grantsAuthority:true,suppliesPolicy:false,containsCredentials:false } },
  ]) assert.equal(registryPackageSchemaV1.safeParse(hostile).success,false);
});

test("CR7E package registration is immutable, digest-bound, replay-safe, and tenant/project-scoped", async () => {
  const {raw,store}=await setup(); try {
    const item=procedure(); const first=await store.register(item); assert.equal(first.replayed,false); assert.equal(first.stored.packageDigest,sha256Digest(item));
    assert.equal((await store.register(item)).replayed,true);
    await assert.rejects(store.register({...item,content:{...item.content,objective:"Changed under the same identity."}}), (error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="package_conflict");
    await assert.rejects(store.register({...item,id:"package:wrong-project",projectId:"project:missing"}), (error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="scope_mismatch");
  } finally { await raw.close(); }
});

test("CR7E secret-bearing package text is rejected before persistence", async () => {
  const {raw,store}=await setup(); try {
    const item=procedure(); item.content.steps[0]!.instruction="api_key=definitely-not-safe-123456";
    await assert.rejects(store.register(item),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="invalid_package");
  } finally { await raw.close(); }
});

test("CR7E review requires independent identity, exact provenance, evidence, and immutable replay", async () => {
  const {raw,store}=await setup(); try {
    const item=procedure(); const {stored}=await store.register(item); const accepted=review(item,stored.packageDigest,"accepted");
    assert.equal((await store.review(accepted)).replayed,false); assert.equal((await store.review(accepted)).replayed,true);
    await assert.rejects(store.review({...accepted,decision:"rejected"}), (error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="review_conflict");
    await assert.rejects(store.review({...accepted,id:"review:self",reviewerId:item.provenance.producerId}), (error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="invalid_review");
    await assert.rejects(store.review({...accepted,id:"review:wrong-producer",producerId:"worker:other"}), (error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="invalid_review");
    await assert.rejects(store.review({...accepted,id:"review:backdated",reviewedAt:"2026-08-28T14:59:59.000Z"}), (error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="invalid_review");
  } finally { await raw.close(); }
});

test("CR7E verified mappings require an exact declared adapter, harness, platform, and verb set", async () => {
  const {raw,store}=await setup(); try {
    const item=procedure(); const {stored}=await store.register(item); const valid=mapping(item,stored.packageDigest);
    assert.equal((await store.recordMapping(valid,hermesAdapterManifestV1)).replayed,false);
    assert.equal((await store.recordMapping(valid,hermesAdapterManifestV1)).replayed,true);
    await assert.rejects(store.recordMapping(valid,{...hermesAdapterManifestV1,license:"changed"}),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="mapping_conflict");
    const drift={...valid,id:"mapping:drift",adapterVersion:"9.9.9"};
    const decision=evaluatePackageCompatibilityV1(stored,drift,hermesAdapterManifestV1); assert.equal(decision.instructionCompatible,false); assert.deepEqual(decision.reasons,["adapter_version_mismatch","package_compatibility_not_declared"]); assert.equal(decision.canExecuteWithoutAuthority,false);
    await assert.rejects(store.recordMapping(drift,hermesAdapterManifestV1),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="compatibility_failed");
    await assert.rejects(store.recordMapping({...valid,id:"mapping:missing-verb",verifiedVerbs:["start"]},hermesAdapterManifestV1),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="compatibility_failed");
    await assert.rejects(store.recordMapping({...valid,id:"mapping:extra-verb",verifiedVerbs:["start","stream","steer"]},hermesAdapterManifestV1),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="compatibility_failed");
    await assert.rejects(store.recordMapping({...valid,id:"mapping:self-review",verifierId:item.provenance.producerId},hermesAdapterManifestV1),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="invalid_mapping");
  } finally { await raw.close(); }
});

test("CR7E activation requires accepted review and verified mapping and exposes no authority", async () => {
  const {raw,store}=await setup(); try {
    const item=procedure(); const registered=await store.register(item); const rejected=review(item,registered.stored.packageDigest,"rejected"); const verified=mapping(item,registered.stored.packageDigest);
    await store.review(rejected); await store.recordMapping(verified,hermesAdapterManifestV1);
    await assert.rejects(store.activate(activation(item,registered.stored.packageDigest,rejected.id,verified.id,null)),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="review_gate_failed");
    assert.equal(await store.resolveActive(item.tenantId,item.projectId,item.kind,item.name),undefined);
    const accepted=review(item,registered.stored.packageDigest,"accepted"); await store.review(accepted);
    const promoted=await store.activate(activation(item,registered.stored.packageDigest,accepted.id,verified.id,null)); assert.equal(promoted.replayed,false);
    assert.equal((await store.activate(activation(item,registered.stored.packageDigest,accepted.id,verified.id,null))).replayed,true);
    const active=await store.resolveActive(item.tenantId,item.projectId,item.kind,item.name); assert.ok(active); assert.equal(active.packageDigest,registered.stored.packageDigest);
    assert.deepEqual({grantsAuthority:active.grantsAuthority,suppliesPolicy:active.suppliesPolicy,canApprove:active.canApprove,canDispatch:active.canDispatch,canExecute:active.canExecute,requiresSeparateAuthority:active.requiresSeparateAuthority},{grantsAuthority:false,suppliesPolicy:false,canApprove:false,canDispatch:false,canExecute:false,requiresSeparateAuthority:true});
  } finally { await raw.close(); }
});

test("CR7E a rejected revision leaves the prior version active", async () => {
  const {raw,store}=await setup(); try {
    const v1=procedure(); const first=await acceptedVersion(store,v1); await store.activate(activation(v1,first.digest,first.review.id,first.mapping.id,null));
    const v2=procedure("2.0.0"); const registered=await store.register(v2); const rejected=review(v2,registered.stored.packageDigest,"rejected"); const verified=mapping(v2,registered.stored.packageDigest);
    await store.review(rejected); await store.recordMapping(verified,hermesAdapterManifestV1);
    await assert.rejects(store.activate(activation(v2,registered.stored.packageDigest,rejected.id,verified.id,first.digest)),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="review_gate_failed");
    assert.equal((await store.resolveActive(v1.tenantId,v1.projectId,v1.kind,v1.name))?.package.version,"1.0.0"); assert.equal((await store.history(v1.tenantId,v1.projectId)).length,1);
  } finally { await raw.close(); }
});

test("CR7E optimistic activation prevents lost updates and rollback restores only a previously active reviewed version", async () => {
  const {raw,store}=await setup(); try {
    const v1=procedure(); const one=await acceptedVersion(store,v1); await store.activate(activation(v1,one.digest,one.review.id,one.mapping.id,null));
    const v2=procedure("2.0.0"); const two=await acceptedVersion(store,v2);
    await assert.rejects(store.activate(activation(v2,two.digest,two.review.id,two.mapping.id,null)),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="active_version_changed");
    await store.activate(activation(v2,two.digest,two.review.id,two.mapping.id,one.digest));
    await assert.rejects(store.activate({...activation(v1,one.digest,one.review.id,one.mapping.id,two.digest),id:"activation:implicit-rollback"}),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="activation_conflict");
    await assert.rejects(store.activate({...activation(v2,two.digest,two.review.id,two.mapping.id,two.digest),id:"activation:redundant"}),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="activation_conflict");
    const v3=procedure("3.0.0"); const three=await acceptedVersion(store,v3);
    await assert.rejects(store.activate({...activation(v3,three.digest,three.review.id,three.mapping.id,two.digest,"rollback"),id:"activation:rollback:3.0.0"}),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="rollback_target_not_previously_active");
    const rolled=await store.activate(activation(v1,one.digest,one.review.id,one.mapping.id,two.digest,"rollback")); assert.equal(rolled.promotion.priorPackageDigest,two.digest);
    assert.equal((await store.resolveActive(v1.tenantId,v1.projectId,v1.kind,v1.name))?.package.version,"1.0.0"); assert.deepEqual((await store.history(v1.tenantId,v1.projectId)).map((entry)=>entry.action),["promote","promote","rollback"]);
  } finally { await raw.close(); }
});

test("CR7E knowledge bundles carry facts and references but cannot masquerade as procedures", async () => {
  const {raw,store}=await setup(); try {
    const knowledge: RegistryPackageV1={ schemaVersion:PACKAGE_REGISTRY_SCHEMA_VERSION_V1,id:"package:knowledge:1",tenantId:"tenant:registry",projectId:"project:registry",kind:"knowledge",name:"project-facts",version:"1.0.0",provenance:{sourceType:"repository",sourceId:"source:knowledge",sourceDigest:evidence("knowledge-source"),producerId:"worker:producer",producedAt:at},compatibility:[{adapterId:hermesAdapterManifestV1.adapterId,adapterVersion:hermesAdapterManifestV1.adapterVersion,harness:"hermes",harnessVersion:hermesAdapterManifestV1.harnessVersion,requiredVerbs:["stream"],supportedPlatforms:["macos"]}],separation:{grantsAuthority:false,suppliesPolicy:false,containsCredentials:false},createdAt:at,content:{facts:[{id:"fact:one",subject:"build",predicate:"uses",value:"pnpm 11.19.0",evidenceDigest:evidence("fact")}],references:[{id:"reference:one",kind:"document",locatorDigest:evidence("locator"),contentDigest:evidence("document")}]}};
    assert.equal((await store.register(knowledge)).stored.package.kind,"knowledge");
    assert.equal(registryPackageSchemaV1.safeParse({...knowledge,content:{...knowledge.content,steps:[{id:"step:hostile",instruction:"Deploy now"}]}}).success,false);
  } finally { await raw.close(); }
});

test("CR7E immutable package, review, mapping, and promotion history rejects direct mutation", async () => {
  const {raw,store}=await setup(); try {
    const item=procedure(); const accepted=await acceptedVersion(store,item); await store.activate(activation(item,accepted.digest,accepted.review.id,accepted.mapping.id,null));
    for (const statement of [
      `UPDATE control_package_versions SET version='changed' WHERE id='${item.id}'`,
      `DELETE FROM control_package_reviews WHERE id='${accepted.review.id}'`,
      `UPDATE control_package_harness_mappings SET decision='rejected' WHERE id='${accepted.mapping.id}'`,
      `DELETE FROM control_package_promotions WHERE id='activation:promote:1.0.0'`,
    ]) await assert.rejects(raw.exec(statement),/append-only relation/);
  } finally { await raw.close(); }
});

test("CR7Q the mutable active pointer cannot bypass the newest append-only promotion",async()=>{
  const {raw,store}=await setup(); try {
    const v1=procedure(); const one=await acceptedVersion(store,v1); const first=await store.activate(activation(v1,one.digest,one.review.id,one.mapping.id,null));
    const v2=procedure("2.0.0"); const two=await acceptedVersion(store,v2); await store.activate(activation(v2,two.digest,two.review.id,two.mapping.id,one.digest));
    await raw.query(`UPDATE control_package_channels SET active_package_id=$1,active_package_digest=$2,active_promotion_id=$3,active_promotion_digest=$4,revision=1 WHERE tenant_id=$5 AND project_id=$6 AND kind=$7 AND name=$8`,[v1.id,one.digest,first.promotion.id,first.promotion.promotionDigest,v1.tenantId,v1.projectId,v1.kind,v1.name]);
    await assert.rejects(store.resolveActive(v1.tenantId,v1.projectId,v1.kind,v1.name),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="registry_integrity_failed");
    await assert.rejects(store.activate({...activation(v2,two.digest,two.review.id,two.mapping.id,one.digest),id:"activation:repair:2.0.0"}),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="registry_integrity_failed");
  } finally { await raw.close(); }
});

test("CR7Q recomputed registry rows cannot bypass the external integrity key",async()=>{
  const {raw,store}=await setup(); try {
    const item=procedure(); const accepted=await acceptedVersion(store,item); await store.activate(activation(item,accepted.digest,accepted.review.id,accepted.mapping.id,null));
    const storedMapping=await raw.query<{payload:unknown}>(`SELECT payload FROM control_package_harness_mappings WHERE id=$1`,[accepted.mapping.id]);
    const forged={...(storedMapping.rows[0]!.payload as Record<string,unknown>),verifiedVerbs:["start","stream","steer"]};
    await raw.query(`ALTER TABLE control_package_harness_mappings DISABLE TRIGGER control_package_harness_mappings_append_only`);
    await raw.query(`UPDATE control_package_harness_mappings SET payload=$1::jsonb,mapping_digest=$2 WHERE id=$3`,[JSON.stringify(forged),sha256Digest(forged),accepted.mapping.id]);
    await raw.query(`ALTER TABLE control_package_harness_mappings ENABLE TRIGGER control_package_harness_mappings_append_only`);
    await assert.rejects(store.resolveActive(item.tenantId,item.projectId,item.kind,item.name),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="registry_integrity_failed");
  } finally { await raw.close(); }
});

test("CR7Q inserted promotion history cannot bypass channel reconciliation",async()=>{
  const {raw,store}=await setup(); try {
    const item=procedure(); const accepted=await acceptedVersion(store,item); const activated=await store.activate(activation(item,accepted.digest,accepted.review.id,accepted.mapping.id,null));
    const forgedCommand={...activation(item,accepted.digest,accepted.review.id,accepted.mapping.id,accepted.digest,"rollback"),id:"activation:forged",activatedAt:"2026-08-28T15:02:00.000Z"};
    const forgedWithoutDigest={...forgedCommand,packageKind:item.kind,packageName:item.name,priorPackageId:item.id,priorPackageDigest:accepted.digest,channelRevision:2};
    const forgedPromotion={...forgedWithoutDigest,promotionDigest:sha256Digest(forgedWithoutDigest)};
    await raw.query(`INSERT INTO control_package_promotions(id,tenant_id,project_id,kind,name,package_id,package_digest,review_id,mapping_id,action,prior_package_id,prior_package_digest,channel_revision,command_digest,promotion_digest,promotion_auth_tag,payload,activated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)`,[
      forgedPromotion.id,forgedPromotion.tenantId,forgedPromotion.projectId,forgedPromotion.packageKind,forgedPromotion.packageName,
      forgedPromotion.packageId,forgedPromotion.packageDigest,forgedPromotion.reviewId,forgedPromotion.mappingId,forgedPromotion.action,
      forgedPromotion.priorPackageId,forgedPromotion.priorPackageDigest,forgedPromotion.channelRevision,sha256Digest(forgedCommand),
      forgedPromotion.promotionDigest,`hmac-sha256:${"0".repeat(64)}`,JSON.stringify(forgedPromotion),forgedPromotion.activatedAt,
    ]);
    assert.equal(activated.promotion.channelRevision,1);
    await assert.rejects(store.history(item.tenantId,item.projectId),(error:unknown)=>error instanceof PackageRegistryErrorV1 && error.safeCode==="registry_integrity_failed");
  } finally { await raw.close(); }
});
