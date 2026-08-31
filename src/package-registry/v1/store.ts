import type { DatabaseClient } from "../../persistence/database";
import { harnessAdapterManifestSchemaV1 } from "../../harness/v1";
import type { HarnessAdapterManifestV1 } from "../../harness/v1";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { evaluatePackageCompatibilityV1 } from "./compatibility";
import {
  packageActivationCommandSchemaV1,
  packageHarnessMappingInputSchemaV1,
  packageHarnessMappingSchemaV1,
  packagePromotionSchemaV1,
  packageReviewSchemaV1,
  registryPackageSchemaV1,
} from "./schemas";
import type {
  PackageActivationCommandV1,
  PackageHarnessMappingInputV1,
  PackageHarnessMappingV1,
  PackagePromotionV1,
  PackageReviewV1,
  RegistryPackageV1,
  ResolvedActivePackageV1,
  StoredPackageV1,
} from "./types";

export type PackageRegistrySafeCodeV1 =
  | "invalid_package" | "package_conflict" | "package_not_found" | "scope_mismatch"
  | "invalid_review" | "review_conflict" | "review_gate_failed"
  | "invalid_mapping" | "mapping_conflict" | "compatibility_failed"
  | "activation_conflict" | "active_version_changed" | "rollback_target_not_previously_active" | "registry_integrity_failed";

export class PackageRegistryErrorV1 extends Error {
  constructor(readonly safeCode: PackageRegistrySafeCodeV1) { super(safeCode); this.name = "PackageRegistryErrorV1"; }
}

interface PackageRow {
  id:string;tenant_id:string;project_id:string;kind:string;name:string;version:string;package_digest:string;package_auth_tag:string;
  producer_id:string;payload:RegistryPackageV1;created_at:string|Date;
}
interface ReviewRow {
  id:string;tenant_id:string;project_id:string;package_id:string;package_digest:string;producer_id:string;reviewer_id:string;
  decision:string;review_digest:string;review_auth_tag:string;payload:PackageReviewV1;reviewed_at:string|Date;
}
interface MappingRow {
  id:string;tenant_id:string;project_id:string;package_id:string;package_digest:string;adapter_id:string;adapter_version:string;
  decision:string;mapping_digest:string;manifest_digest:string;mapping_auth_tag:string;payload:PackageHarnessMappingV1;verified_at:string|Date;
}
interface ChannelRow {
  tenant_id:string;project_id:string;kind:"procedure"|"knowledge";name:string;active_package_id:string;active_package_digest:string;
  active_promotion_id:string;active_promotion_digest:string;channel_auth_tag:string;revision:number|string;updated_at:string|Date;
}
interface PromotionRow {
  id:string;tenant_id:string;project_id:string;kind:string;name:string;package_id:string;package_digest:string;review_id:string;
  mapping_id:string;action:string;prior_package_id:string|null;prior_package_digest:string|null;channel_revision:number|string;
  command_digest:string;promotion_digest:string;promotion_auth_tag:string;payload:PackagePromotionV1;activated_at:string|Date;
}
type QuerySource=Pick<DatabaseClient,"query">;

const packageColumns="id,tenant_id,project_id,kind,name,version,package_digest,package_auth_tag,producer_id,payload,created_at";
const reviewColumns="id,tenant_id,project_id,package_id,package_digest,producer_id,reviewer_id,decision,review_digest,review_auth_tag,payload,reviewed_at";
const mappingColumns="id,tenant_id,project_id,package_id,package_digest,adapter_id,adapter_version,decision,mapping_digest,manifest_digest,mapping_auth_tag,payload,verified_at";
const channelColumns="tenant_id,project_id,kind,name,active_package_id,active_package_digest,active_promotion_id,active_promotion_digest,channel_auth_tag,revision,updated_at";
const promotionColumns="id,tenant_id,project_id,kind,name,package_id,package_digest,review_id,mapping_id,action,prior_package_id,prior_package_digest,channel_revision,command_digest,promotion_digest,promotion_auth_tag,payload,activated_at";

function iso(value:string|Date):string { return new Date(value).toISOString(); }
function parseOrThrow<T>(parser:{parse(value:unknown):T},input:unknown,code:PackageRegistrySafeCodeV1):T {
  try { return parser.parse(input); } catch { throw new PackageRegistryErrorV1(code); }
}
function assertSafe(input:unknown,code:PackageRegistrySafeCodeV1):void {
  try { assertNoSecretMaterial(input,"package registry input"); } catch { throw new PackageRegistryErrorV1(code); }
}

function packageAuthMaterial(row:Omit<PackageRow,"package_auth_tag"|"payload">):Record<string,unknown> {
  return {id:row.id,tenantId:row.tenant_id,projectId:row.project_id,kind:row.kind,name:row.name,version:row.version,
    packageDigest:row.package_digest,producerId:row.producer_id,createdAt:iso(row.created_at)};
}
function reviewAuthMaterial(row:Omit<ReviewRow,"review_auth_tag"|"payload">):Record<string,unknown> {
  return {id:row.id,tenantId:row.tenant_id,projectId:row.project_id,packageId:row.package_id,packageDigest:row.package_digest,
    producerId:row.producer_id,reviewerId:row.reviewer_id,decision:row.decision,reviewDigest:row.review_digest,reviewedAt:iso(row.reviewed_at)};
}
function mappingAuthMaterial(row:Omit<MappingRow,"mapping_auth_tag"|"payload">):Record<string,unknown> {
  return {id:row.id,tenantId:row.tenant_id,projectId:row.project_id,packageId:row.package_id,packageDigest:row.package_digest,
    adapterId:row.adapter_id,adapterVersion:row.adapter_version,decision:row.decision,mappingDigest:row.mapping_digest,
    manifestDigest:row.manifest_digest,verifiedAt:iso(row.verified_at)};
}
function promotionAuthMaterial(row:Omit<PromotionRow,"promotion_auth_tag"|"payload">):Record<string,unknown> {
  return {id:row.id,tenantId:row.tenant_id,projectId:row.project_id,kind:row.kind,name:row.name,packageId:row.package_id,
    packageDigest:row.package_digest,reviewId:row.review_id,mappingId:row.mapping_id,action:row.action,priorPackageId:row.prior_package_id,
    priorPackageDigest:row.prior_package_digest,channelRevision:Number(row.channel_revision),commandDigest:row.command_digest,
    promotionDigest:row.promotion_digest,activatedAt:iso(row.activated_at)};
}
function channelAuthMaterial(row:Omit<ChannelRow,"channel_auth_tag">):Record<string,unknown> {
  return {tenantId:row.tenant_id,projectId:row.project_id,kind:row.kind,name:row.name,activePackageId:row.active_package_id,
    activePackageDigest:row.active_package_digest,activePromotionId:row.active_promotion_id,activePromotionDigest:row.active_promotion_digest,
    revision:Number(row.revision),updatedAt:iso(row.updated_at)};
}

export class PackageRegistryStoreV1 {
  constructor(private readonly db:DatabaseClient,private readonly integrityKey:Uint8Array) {
    try { hmacSha256Tag(integrityKey,{purpose:"package-registry-key-check"}); }
    catch { throw new PackageRegistryErrorV1("registry_integrity_failed"); }
  }

  async register(input:unknown):Promise<{stored:StoredPackageV1;replayed:boolean}> {
    const item=parseOrThrow(registryPackageSchemaV1,input,"invalid_package") as RegistryPackageV1; assertSafe(item,"invalid_package");
    const packageDigest=sha256Digest(item);
    return this.db.transaction(async(tx)=>{
      const existing=await tx.query<PackageRow>(`SELECT ${packageColumns} FROM control_package_versions WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[item.tenantId,item.id]);
      if (existing.rows[0]) {
        const stored=this.verifiedPackageRow(existing.rows[0]);
        if (stored.packageDigest!==packageDigest) throw new PackageRegistryErrorV1("package_conflict");
        return {stored,replayed:true};
      }
      const project=await tx.query<{id:string}>(`SELECT id FROM projects WHERE tenant_id=$1 AND id=$2`,[item.tenantId,item.projectId]);
      if (!project.rows[0]) throw new PackageRegistryErrorV1("scope_mismatch");
      const version=await tx.query<{package_digest:string}>(`SELECT package_digest FROM control_package_versions WHERE tenant_id=$1 AND project_id=$2 AND kind=$3 AND name=$4 AND version=$5`,[item.tenantId,item.projectId,item.kind,item.name,item.version]);
      if (version.rows[0]) throw new PackageRegistryErrorV1("package_conflict");
      const material={id:item.id,tenant_id:item.tenantId,project_id:item.projectId,kind:item.kind,name:item.name,version:item.version,package_digest:packageDigest,producer_id:item.provenance.producerId,created_at:item.createdAt};
      const authTag=hmacSha256Tag(this.integrityKey,packageAuthMaterial(material));
      await tx.query(`INSERT INTO control_package_versions(id,tenant_id,project_id,kind,name,version,package_digest,package_auth_tag,producer_id,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,[item.id,item.tenantId,item.projectId,item.kind,item.name,item.version,packageDigest,authTag,item.provenance.producerId,JSON.stringify(item),item.createdAt]);
      return {stored:{package:item,packageDigest},replayed:false};
    });
  }

  async review(input:unknown):Promise<{review:PackageReviewV1;replayed:boolean}> {
    const review=parseOrThrow(packageReviewSchemaV1,input,"invalid_review") as PackageReviewV1; assertSafe(review,"invalid_review");
    const reviewDigest=sha256Digest(review);
    return this.db.transaction(async(tx)=>{
      const existing=await tx.query<ReviewRow>(`SELECT ${reviewColumns} FROM control_package_reviews WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[review.tenantId,review.id]);
      if (existing.rows[0]) {
        const verified=this.verifiedReviewRow(existing.rows[0]);
        if (existing.rows[0].review_digest!==reviewDigest) throw new PackageRegistryErrorV1("review_conflict");
        return {review:verified,replayed:true};
      }
      const stored=await this.requirePackage(tx,review.tenantId,review.packageId,review.projectId,review.packageDigest);
      if (stored.package.provenance.producerId!==review.producerId || Date.parse(review.reviewedAt)<Date.parse(stored.package.createdAt)) throw new PackageRegistryErrorV1("invalid_review");
      const material={id:review.id,tenant_id:review.tenantId,project_id:review.projectId,package_id:review.packageId,package_digest:review.packageDigest,producer_id:review.producerId,reviewer_id:review.reviewerId,decision:review.decision,review_digest:reviewDigest,reviewed_at:review.reviewedAt};
      const authTag=hmacSha256Tag(this.integrityKey,reviewAuthMaterial(material));
      await tx.query(`INSERT INTO control_package_reviews(id,tenant_id,project_id,package_id,package_digest,producer_id,reviewer_id,decision,review_digest,review_auth_tag,payload,reviewed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,[review.id,review.tenantId,review.projectId,review.packageId,review.packageDigest,review.producerId,review.reviewerId,review.decision,reviewDigest,authTag,JSON.stringify(review),review.reviewedAt]);
      return {review,replayed:false};
    });
  }

  async recordMapping(input:unknown,manifestInput:unknown):Promise<{mapping:PackageHarnessMappingV1;replayed:boolean}> {
    const mappingInput=parseOrThrow(packageHarnessMappingInputSchemaV1,input,"invalid_mapping") as PackageHarnessMappingInputV1;
    const manifest=parseOrThrow(harnessAdapterManifestSchemaV1,manifestInput,"invalid_mapping") as HarnessAdapterManifestV1;
    assertSafe(mappingInput,"invalid_mapping"); assertSafe(manifest,"invalid_mapping");
    const manifestDigest=sha256Digest(manifest); const mapping:PackageHarnessMappingV1={...mappingInput,manifestDigest,manifest}; const mappingDigest=sha256Digest(mapping);
    return this.db.transaction(async(tx)=>{
      const existing=await tx.query<MappingRow>(`SELECT ${mappingColumns} FROM control_package_harness_mappings WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[mapping.tenantId,mapping.id]);
      if (existing.rows[0]) {
        const verified=this.verifiedMappingRow(existing.rows[0]);
        if (existing.rows[0].mapping_digest!==mappingDigest || existing.rows[0].manifest_digest!==manifestDigest) throw new PackageRegistryErrorV1("mapping_conflict");
        return {mapping:verified,replayed:true};
      }
      const stored=await this.requirePackage(tx,mapping.tenantId,mapping.packageId,mapping.projectId,mapping.packageDigest);
      if (mapping.verifierId===stored.package.provenance.producerId || Date.parse(mapping.verifiedAt)<Date.parse(stored.package.createdAt)) throw new PackageRegistryErrorV1("invalid_mapping");
      const compatibility=evaluatePackageCompatibilityV1(stored,mapping,manifest);
      if (mapping.decision==="verified" && !compatibility.instructionCompatible) throw new PackageRegistryErrorV1("compatibility_failed");
      const material={id:mapping.id,tenant_id:mapping.tenantId,project_id:mapping.projectId,package_id:mapping.packageId,package_digest:mapping.packageDigest,adapter_id:mapping.adapterId,adapter_version:mapping.adapterVersion,decision:mapping.decision,mapping_digest:mappingDigest,manifest_digest:manifestDigest,verified_at:mapping.verifiedAt};
      const authTag=hmacSha256Tag(this.integrityKey,mappingAuthMaterial(material));
      await tx.query(`INSERT INTO control_package_harness_mappings(id,tenant_id,project_id,package_id,package_digest,adapter_id,adapter_version,decision,mapping_digest,manifest_digest,mapping_auth_tag,payload,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,[mapping.id,mapping.tenantId,mapping.projectId,mapping.packageId,mapping.packageDigest,mapping.adapterId,mapping.adapterVersion,mapping.decision,mappingDigest,manifestDigest,authTag,JSON.stringify(mapping),mapping.verifiedAt]);
      return {mapping,replayed:false};
    });
  }

  async activate(input:unknown):Promise<{promotion:PackagePromotionV1;replayed:boolean}> {
    const command=parseOrThrow(packageActivationCommandSchemaV1,input,"activation_conflict") as PackageActivationCommandV1; assertSafe(command,"activation_conflict");
    const commandDigest=sha256Digest(command);
    return this.db.transaction(async(tx)=>{
      const replay=await tx.query<PromotionRow>(`SELECT ${promotionColumns} FROM control_package_promotions WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[command.tenantId,command.id]);
      if (replay.rows[0]) {
        const promotion=this.verifiedPromotionRow(replay.rows[0]);
        if (replay.rows[0].command_digest!==commandDigest) throw new PackageRegistryErrorV1("activation_conflict");
        return {promotion,replayed:true};
      }
      const stored=await this.requirePackage(tx,command.tenantId,command.packageId,command.projectId,command.packageDigest);
      const reviewed=await this.requireAcceptedReview(tx,command.tenantId,command.reviewId,stored);
      const mapped=await this.requireVerifiedMapping(tx,command.tenantId,command.mappingId,stored);
      const currentResult=await tx.query<ChannelRow>(`SELECT ${channelColumns} FROM control_package_channels WHERE tenant_id=$1 AND project_id=$2 AND kind=$3 AND name=$4 FOR UPDATE`,[command.tenantId,command.projectId,stored.package.kind,stored.package.name]);
      const active=currentResult.rows[0]; const priorHistory=active?await this.assertChannelIntegrity(tx,active):[];
      if ((active?.active_package_digest??null)!==command.expectedActiveDigest) throw new PackageRegistryErrorV1("active_version_changed");
      if (active?.active_package_digest===command.packageDigest) throw new PackageRegistryErrorV1("activation_conflict");
      const previouslyActive=priorHistory.some((entry)=>entry.packageId===command.packageId && entry.packageDigest===command.packageDigest);
      if (command.action==="rollback" && (!active || !previouslyActive)) throw new PackageRegistryErrorV1("rollback_target_not_previously_active");
      if (command.action==="promote" && previouslyActive) throw new PackageRegistryErrorV1("activation_conflict");
      if (Date.parse(command.activatedAt)<Math.max(Date.parse(stored.package.createdAt),Date.parse(reviewed.reviewedAt),Date.parse(mapped.verifiedAt),active?Date.parse(iso(active.updated_at)):0)) throw new PackageRegistryErrorV1("activation_conflict");
      const priorPackageId=active?.active_package_id??null; const priorPackageDigest=active?.active_package_digest??null; const channelRevision=active?Number(active.revision)+1:1;
      const withoutDigest={...command,packageKind:stored.package.kind,packageName:stored.package.name,priorPackageId,priorPackageDigest,channelRevision};
      const promotion:PackagePromotionV1={...withoutDigest,promotionDigest:sha256Digest(withoutDigest)};
      const promotionMaterial={id:promotion.id,tenant_id:promotion.tenantId,project_id:promotion.projectId,kind:promotion.packageKind,name:promotion.packageName,package_id:promotion.packageId,package_digest:promotion.packageDigest,review_id:promotion.reviewId,mapping_id:promotion.mappingId,action:promotion.action,prior_package_id:promotion.priorPackageId,prior_package_digest:promotion.priorPackageDigest,channel_revision:promotion.channelRevision,command_digest:commandDigest,promotion_digest:promotion.promotionDigest,activated_at:promotion.activatedAt};
      const promotionAuthTag=hmacSha256Tag(this.integrityKey,promotionAuthMaterial(promotionMaterial));
      await tx.query(`INSERT INTO control_package_promotions(id,tenant_id,project_id,kind,name,package_id,package_digest,review_id,mapping_id,action,prior_package_id,prior_package_digest,channel_revision,command_digest,promotion_digest,promotion_auth_tag,payload,activated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)`,[promotion.id,promotion.tenantId,promotion.projectId,promotion.packageKind,promotion.packageName,promotion.packageId,promotion.packageDigest,promotion.reviewId,promotion.mappingId,promotion.action,promotion.priorPackageId,promotion.priorPackageDigest,promotion.channelRevision,commandDigest,promotion.promotionDigest,promotionAuthTag,JSON.stringify(promotion),promotion.activatedAt]);
      const channelMaterial={tenant_id:promotion.tenantId,project_id:promotion.projectId,kind:promotion.packageKind,name:promotion.packageName,active_package_id:promotion.packageId,active_package_digest:promotion.packageDigest,active_promotion_id:promotion.id,active_promotion_digest:promotion.promotionDigest,revision:promotion.channelRevision,updated_at:promotion.activatedAt};
      const channelAuthTag=hmacSha256Tag(this.integrityKey,channelAuthMaterial(channelMaterial));
      await tx.query(`INSERT INTO control_package_channels(tenant_id,project_id,kind,name,active_package_id,active_package_digest,active_promotion_id,active_promotion_digest,channel_auth_tag,revision,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,project_id,kind,name) DO UPDATE SET active_package_id=EXCLUDED.active_package_id,active_package_digest=EXCLUDED.active_package_digest,active_promotion_id=EXCLUDED.active_promotion_id,active_promotion_digest=EXCLUDED.active_promotion_digest,channel_auth_tag=EXCLUDED.channel_auth_tag,revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at`,[promotion.tenantId,promotion.projectId,promotion.packageKind,promotion.packageName,promotion.packageId,promotion.packageDigest,promotion.id,promotion.promotionDigest,channelAuthTag,promotion.channelRevision,promotion.activatedAt]);
      return {promotion,replayed:false};
    });
  }

  async get(tenantId:string,packageId:string):Promise<StoredPackageV1|undefined> {
    const result=await this.db.query<PackageRow>(`SELECT ${packageColumns} FROM control_package_versions WHERE tenant_id=$1 AND id=$2`,[tenantId,packageId]);
    return result.rows[0]?this.verifiedPackageRow(result.rows[0]):undefined;
  }

  async resolveActive(tenantId:string,projectId:string,kind:"procedure"|"knowledge",name:string):Promise<ResolvedActivePackageV1|undefined> {
    const result=await this.db.query<ChannelRow>(`SELECT ${channelColumns} FROM control_package_channels WHERE tenant_id=$1 AND project_id=$2 AND kind=$3 AND name=$4`,[tenantId,projectId,kind,name]);
    const channel=result.rows[0]; if (!channel) return undefined;
    const promotions=await this.assertChannelIntegrity(this.db,channel); const promotion=promotions.at(-1)!;
    const stored=await this.requirePackage(this.db,tenantId,promotion.packageId,projectId,promotion.packageDigest);
    const mapping=await this.requireVerifiedMapping(this.db,tenantId,promotion.mappingId,stored);
    await this.requireAcceptedReview(this.db,tenantId,promotion.reviewId,stored);
    return {...stored,promotion,mapping,trust:"reviewed_and_active",grantsAuthority:false,suppliesPolicy:false,canApprove:false,canDispatch:false,canExecute:false,requiresSeparateAuthority:true};
  }

  async history(tenantId:string,projectId:string):Promise<PackagePromotionV1[]> {
    const channelResult=await this.db.query<ChannelRow>(`SELECT ${channelColumns} FROM control_package_channels WHERE tenant_id=$1 AND project_id=$2 ORDER BY kind,name`,[tenantId,projectId]);
    const rows=await this.db.query<{kind:string;name:string}>(`SELECT DISTINCT kind,name FROM control_package_promotions WHERE tenant_id=$1 AND project_id=$2`,[tenantId,projectId]);
    const channelKeys=new Set(channelResult.rows.map((row)=>`${row.kind}\0${row.name}`));
    if (rows.rows.some((row)=>!channelKeys.has(`${row.kind}\0${row.name}`))) throw new PackageRegistryErrorV1("registry_integrity_failed");
    const result:PackagePromotionV1[]=[];
    for (const channel of channelResult.rows) result.push(...await this.assertChannelIntegrity(this.db,channel));
    return result;
  }

  private verifiedPackageRow(row:PackageRow):StoredPackageV1 {
    const item=parseOrThrow(registryPackageSchemaV1,row.payload,"registry_integrity_failed") as RegistryPackageV1;
    if (sha256Digest(item)!==row.package_digest || hmacSha256Tag(this.integrityKey,packageAuthMaterial(row))!==row.package_auth_tag
      || row.id!==item.id || row.tenant_id!==item.tenantId || row.project_id!==item.projectId || row.kind!==item.kind || row.name!==item.name
      || row.version!==item.version || row.producer_id!==item.provenance.producerId || iso(row.created_at)!==item.createdAt) throw new PackageRegistryErrorV1("registry_integrity_failed");
    return {package:item,packageDigest:row.package_digest};
  }

  private verifiedReviewRow(row:ReviewRow):PackageReviewV1 {
    const review=parseOrThrow(packageReviewSchemaV1,row.payload,"registry_integrity_failed") as PackageReviewV1;
    if (sha256Digest(review)!==row.review_digest || hmacSha256Tag(this.integrityKey,reviewAuthMaterial(row))!==row.review_auth_tag
      || row.id!==review.id || row.tenant_id!==review.tenantId || row.project_id!==review.projectId || row.package_id!==review.packageId
      || row.package_digest!==review.packageDigest || row.producer_id!==review.producerId || row.reviewer_id!==review.reviewerId
      || row.decision!==review.decision || iso(row.reviewed_at)!==review.reviewedAt) throw new PackageRegistryErrorV1("registry_integrity_failed");
    return review;
  }

  private verifiedMappingRow(row:MappingRow):PackageHarnessMappingV1 {
    const mapping=parseOrThrow(packageHarnessMappingSchemaV1,row.payload,"registry_integrity_failed") as PackageHarnessMappingV1;
    if (sha256Digest(mapping)!==row.mapping_digest || sha256Digest(mapping.manifest)!==row.manifest_digest || mapping.manifestDigest!==row.manifest_digest
      || hmacSha256Tag(this.integrityKey,mappingAuthMaterial(row))!==row.mapping_auth_tag || row.id!==mapping.id || row.tenant_id!==mapping.tenantId
      || row.project_id!==mapping.projectId || row.package_id!==mapping.packageId || row.package_digest!==mapping.packageDigest
      || row.adapter_id!==mapping.adapterId || row.adapter_version!==mapping.adapterVersion || row.decision!==mapping.decision
      || iso(row.verified_at)!==mapping.verifiedAt) throw new PackageRegistryErrorV1("registry_integrity_failed");
    return mapping;
  }

  private verifiedPromotionRow(row:PromotionRow):PackagePromotionV1 {
    const promotion=parseOrThrow(packagePromotionSchemaV1,row.payload,"registry_integrity_failed") as PackagePromotionV1;
    const {packageKind:_kind,packageName:_name,priorPackageId:_priorId,priorPackageDigest:_priorDigest,channelRevision:_revision,promotionDigest:_promotionDigest,...command}=promotion;
    void _kind;void _name;void _priorId;void _priorDigest;void _revision;void _promotionDigest;
    const {promotionDigest,...material}=promotion;
    if (sha256Digest(material)!==promotionDigest || promotionDigest!==row.promotion_digest || sha256Digest(command)!==row.command_digest
      || hmacSha256Tag(this.integrityKey,promotionAuthMaterial(row))!==row.promotion_auth_tag || row.id!==promotion.id
      || row.tenant_id!==promotion.tenantId || row.project_id!==promotion.projectId || row.kind!==promotion.packageKind || row.name!==promotion.packageName
      || row.package_id!==promotion.packageId || row.package_digest!==promotion.packageDigest || row.review_id!==promotion.reviewId
      || row.mapping_id!==promotion.mappingId || row.action!==promotion.action || row.prior_package_id!==promotion.priorPackageId
      || row.prior_package_digest!==promotion.priorPackageDigest || Number(row.channel_revision)!==promotion.channelRevision
      || iso(row.activated_at)!==promotion.activatedAt) throw new PackageRegistryErrorV1("registry_integrity_failed");
    return promotion;
  }

  private verifiedChannelRow(row:ChannelRow):void {
    if (hmacSha256Tag(this.integrityKey,channelAuthMaterial(row))!==row.channel_auth_tag) throw new PackageRegistryErrorV1("registry_integrity_failed");
  }

  private async requirePackage(source:QuerySource,tenantId:string,packageId:string,projectId:string,packageDigest:string):Promise<StoredPackageV1> {
    const result=await source.query<PackageRow>(`SELECT ${packageColumns} FROM control_package_versions WHERE tenant_id=$1 AND id=$2`,[tenantId,packageId]);
    const row=result.rows[0]; if (!row) throw new PackageRegistryErrorV1("package_not_found");
    const stored=this.verifiedPackageRow(row);
    if (stored.package.projectId!==projectId || stored.packageDigest!==packageDigest) throw new PackageRegistryErrorV1("scope_mismatch");
    return stored;
  }

  private async requireAcceptedReview(source:QuerySource,tenantId:string,reviewId:string,stored:StoredPackageV1):Promise<PackageReviewV1> {
    const result=await source.query<ReviewRow>(`SELECT ${reviewColumns} FROM control_package_reviews WHERE tenant_id=$1 AND id=$2`,[tenantId,reviewId]);
    const review=result.rows[0]?this.verifiedReviewRow(result.rows[0]):undefined;
    if (!review || review.decision!=="accepted" || review.packageId!==stored.package.id || review.packageDigest!==stored.packageDigest
      || review.projectId!==stored.package.projectId || review.producerId!==stored.package.provenance.producerId
      || review.reviewerId===stored.package.provenance.producerId || Date.parse(review.reviewedAt)<Date.parse(stored.package.createdAt)) throw new PackageRegistryErrorV1("review_gate_failed");
    return review;
  }

  private async requireVerifiedMapping(source:QuerySource,tenantId:string,mappingId:string,stored:StoredPackageV1):Promise<PackageHarnessMappingV1> {
    const result=await source.query<MappingRow>(`SELECT ${mappingColumns} FROM control_package_harness_mappings WHERE tenant_id=$1 AND id=$2`,[tenantId,mappingId]);
    const mapping=result.rows[0]?this.verifiedMappingRow(result.rows[0]):undefined;
    if (!mapping || mapping.decision!=="verified" || mapping.packageId!==stored.package.id || mapping.packageDigest!==stored.packageDigest
      || mapping.projectId!==stored.package.projectId || mapping.verifierId===stored.package.provenance.producerId
      || Date.parse(mapping.verifiedAt)<Date.parse(stored.package.createdAt)
      || !evaluatePackageCompatibilityV1(stored,mapping,mapping.manifest).instructionCompatible) throw new PackageRegistryErrorV1("compatibility_failed");
    return mapping;
  }

  private async assertChannelIntegrity(source:QuerySource,channel:ChannelRow):Promise<PackagePromotionV1[]> {
    this.verifiedChannelRow(channel);
    const result=await source.query<PromotionRow>(`SELECT ${promotionColumns} FROM control_package_promotions WHERE tenant_id=$1 AND project_id=$2 AND kind=$3 AND name=$4 ORDER BY channel_revision`,[channel.tenant_id,channel.project_id,channel.kind,channel.name]);
    if (!result.rows.length || result.rows.length!==Number(channel.revision)) throw new PackageRegistryErrorV1("registry_integrity_failed");
    const promotions:PackagePromotionV1[]=[]; const seen=new Set<string>(); let prior:PackagePromotionV1|undefined;
    for (const [index,row] of result.rows.entries()) {
      const promotion=this.verifiedPromotionRow(row);
      if (promotion.channelRevision!==index+1 || promotion.priorPackageId!==(prior?.packageId??null) || promotion.priorPackageDigest!==(prior?.packageDigest??null)
        || (prior && Date.parse(promotion.activatedAt)<Date.parse(prior.activatedAt))) throw new PackageRegistryErrorV1("registry_integrity_failed");
      const targetKey=`${promotion.packageId}\0${promotion.packageDigest}`; const wasSeen=seen.has(targetKey);
      if ((promotion.action==="rollback")!==wasSeen || (index===0 && promotion.action!=="promote")) throw new PackageRegistryErrorV1("registry_integrity_failed");
      const stored=await this.requirePackage(source,promotion.tenantId,promotion.packageId,promotion.projectId,promotion.packageDigest);
      const review=await this.requireAcceptedReview(source,promotion.tenantId,promotion.reviewId,stored);
      const mapping=await this.requireVerifiedMapping(source,promotion.tenantId,promotion.mappingId,stored);
      if (Date.parse(promotion.activatedAt)<Math.max(Date.parse(stored.package.createdAt),Date.parse(review.reviewedAt),Date.parse(mapping.verifiedAt))) throw new PackageRegistryErrorV1("registry_integrity_failed");
      seen.add(targetKey); promotions.push(promotion); prior=promotion;
    }
    const latest=promotions.at(-1)!;
    if (latest.id!==channel.active_promotion_id || latest.promotionDigest!==channel.active_promotion_digest
      || latest.packageId!==channel.active_package_id || latest.packageDigest!==channel.active_package_digest
      || latest.channelRevision!==Number(channel.revision) || latest.activatedAt!==iso(channel.updated_at)) throw new PackageRegistryErrorV1("registry_integrity_failed");
    return promotions;
  }
}
