import { timingSafeEqual } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security/digest";
import { assertNoSecretMaterial } from "../../security/redaction";
import { exactHostDataSnapshotV1 } from "../../security/host-value";
import { ROLLBACK_CHECKPOINT_SCHEMA_V1, rollbackCheckpointDigestV1, type RollbackCheckpointStoreV1, type RollbackCheckpointV1 } from "../../security/rollback-checkpoint";
import { telegramCallbackRecordSchemaV1, telegramMessagePlanSchemaV1, telegramPresentationSchemaV1, telegramRecipientPolicySchemaV1, telegramWebhookObservationSchemaV1 } from "./schemas";
import { authenticateTelegramCallbackTokenV1, buildTelegramResponseProposalV1, parseTelegramCallbackTokenV1 } from "./security";
import { TELEGRAM_CONTRACT_VERSION_V1, type TelegramCallbackReceiptV1, type TelegramCallbackRecordV1, type TelegramPresentationV1,
  type TelegramMessagePlanV1, type TelegramRecipientPolicyV1, type TelegramResponseProposalV1, type TelegramWebhookObservationV1 } from "./types";

export type TelegramDeliveryStateV1="queued"|"sending"|"retry_wait"|"delivered"|"ambiguous"|"dead_letter";
export type TelegramStoreSafeCodeV1="invalid_record"|"integrity_failed"|"record_conflict"|"record_not_found"|"recipient_not_allowed"|
  "scope_mismatch"|"replay_conflict"|"callback_consumed"|"callback_invalid"|"delivery_not_claimable"|"claim_mismatch";
export class TelegramStoreErrorV1 extends Error { constructor(readonly safeCode:TelegramStoreSafeCodeV1){super(safeCode);this.name="TelegramStoreErrorV1";} }

export interface TelegramDeliveryRecordV1 {
  schemaVersion:typeof TELEGRAM_CONTRACT_VERSION_V1;deliveryId:string;tenantId:string;projectId:string;recipientId:string;idempotencyKey:string;
  presentation:TelegramPresentationV1;state:TelegramDeliveryStateV1;attemptCount:number;nextAttemptAt:string;claimId?:string;claimExpiresAt?:string;
  lastClaimId?:string;providerReceiptDigest?:string;safeReasonCode?:string;createdAt:string;updatedAt:string;grantsApproval:false;grantsExecutionAuthority:false;
}
export interface TelegramDeliveryReceiptV1 {schemaVersion:typeof TELEGRAM_CONTRACT_VERSION_V1;deliveryId:string;state:"delivered"|"retry_wait"|"ambiguous"|"dead_letter";
  attemptCount:number;providerReceiptDigest?:string;safeReasonCode?:string;recordedAt:string;grantsApproval:false;grantsExecutionAuthority:false;}
export interface TelegramRecipientPolicyEventV1 {tenantId:string;recipientId:string;policyDigest:string;priorPolicyDigest?:string;policy:TelegramRecipientPolicyV1;occurredAt:string;}
interface TelegramSettlementInputV1 {tenantId:string;deliveryId:string;claimId:string;now:string;outcome:"delivered"|"definite_failure"|"ambiguous";providerReceiptDigest?:string;safeReasonCode?:string;retryAfterSeconds?:number;}

interface RecipientRow{tenant_id:string;recipient_id:string;chat_id_digest:string;policy_digest:string;policy_auth_tag:string;policy:TelegramRecipientPolicyV1;verified_at:string|Date;expires_at:string|Date;}
interface PolicyEventRow{tenant_id:string;recipient_id:string;policy_digest:string;prior_policy_digest:string|null;policy_auth_tag:string;policy:TelegramRecipientPolicyV1;occurred_at:string|Date;}
interface CallbackRow{tenant_id:string;callback_id:string;project_id:string;recipient_id:string;record_digest:string;record_auth_tag:string;record:TelegramCallbackRecordV1;issued_at:string|Date;expires_at:string|Date;}
interface UpdateRow{tenant_id:string;update_id:number;observation_digest:string;observation_auth_tag:string;observation:StoredObservation;observed_at:string|Date;}
interface ReceiptRow{tenant_id:string;callback_id:string;update_id:number;proposal_digest:string;proposal_auth_tag:string;proposal:TelegramResponseProposalV1;recorded_at:string|Date;}
interface DeliveryRow{tenant_id:string;delivery_id:string;project_id:string;recipient_id:string;idempotency_key:string;presentation_digest:string;presentation:TelegramPresentationV1;
  state:TelegramDeliveryStateV1;attempt_count:number;next_attempt_at:string|Date;claim_id:string|null;claim_expires_at:string|Date|null;last_claim_id:string|null;provider_receipt_digest:string|null;
  safe_reason_code:string|null;created_at:string|Date;updated_at:string|Date;state_auth_tag:string;}
interface StoredObservation{schemaVersion:typeof TELEGRAM_CONTRACT_VERSION_V1;updateId:number;bodyDigest:string;chatIdDigest:string;callbackQueryIdDigest:string;callbackTokenDigest:string;observedAt:string;}
interface TelegramIntegrityRow{tenant_id:string;revision:number;record_count:number;state_digest:string;state_auth_tag:string;}
type Source=Pick<DatabaseClient,"query">|DatabaseSession;
const iso=(value:string|Date)=>new Date(value).toISOString();
const equal=(left:string,right:string)=>{const a=Buffer.from(left);const b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);};
const idPattern=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,159}$/;const digestPattern=/^sha256:[a-f0-9]{64}$/;
const riskOrder=["low","medium","high","critical"] as const;
function validId(value:string){if(!idPattern.test(value))throw new TelegramStoreErrorV1("invalid_record");}
function validTime(value:string){if(!Number.isFinite(Date.parse(value)))throw new TelegramStoreErrorV1("invalid_record");}
function parse<T>(schema:{parse(value:unknown):T},value:unknown):T{try{return schema.parse(value);}catch{throw new TelegramStoreErrorV1("invalid_record");}}
function safe(value:unknown){try{assertNoSecretMaterial(value,"Telegram durable record");}catch{throw new TelegramStoreErrorV1("invalid_record");}}
function exactInput<T>(value:unknown,required:string[],optional:string[]=[]):T{const snapshot=exactHostDataSnapshotV1(value,required,optional);if(!snapshot)throw new TelegramStoreErrorV1("invalid_record");return snapshot as T;}

export class TelegramDurableStoreV1 {
  readonly #key:Uint8Array;readonly #callbackKey:Uint8Array;
  readonly #checkpointRead:RollbackCheckpointStoreV1["read"];readonly #checkpointInitialize:RollbackCheckpointStoreV1["initialize"];readonly #checkpointAdvance:RollbackCheckpointStoreV1["advance"];
  constructor(private readonly db:DatabaseClient,integrityKey:Uint8Array,callbackKey:Uint8Array,checkpointStore:RollbackCheckpointStoreV1){try{hmacSha256Tag(integrityKey,{purpose:"telegram-store"});hmacSha256Tag(callbackKey,{purpose:"telegram-callback"});if(callbackKey.byteLength<32)throw new Error("short callback key");this.#key=new Uint8Array(integrityKey);this.#callbackKey=new Uint8Array(callbackKey);this.#checkpointRead=checkpointStore.read.bind(checkpointStore);this.#checkpointInitialize=checkpointStore.initialize.bind(checkpointStore);this.#checkpointAdvance=checkpointStore.advance.bind(checkpointStore);}catch{throw new TelegramStoreErrorV1("integrity_failed");}}

  async provisionTenant(tenantId:string):Promise<void>{validId(tenantId);await this.db.transaction(async(tx)=>{const tenant=await tx.query<{id:string}>("SELECT id FROM tenants WHERE id=$1 FOR UPDATE",[tenantId]);if(!tenant.rows[0])throw new TelegramStoreErrorV1("scope_mismatch");
    const existing=await tx.query<TelegramIntegrityRow>("SELECT * FROM control_telegram_integrity WHERE tenant_id=$1 FOR UPDATE",[tenantId]),computed=await this.computedTenantState(tx,tenantId);
    if(existing.rows[0]||computed.recordCount!==0||this.readCheckpoint(tenantId))throw new TelegramStoreErrorV1("integrity_failed");
    const revision=1,stateAuthTag=this.tenantStateTag(tenantId,revision,computed.recordCount,computed.stateDigest),checkpoint=this.checkpoint(tenantId,revision,computed.recordCount,computed.stateDigest,stateAuthTag);
    await tx.query(`INSERT INTO control_telegram_integrity(tenant_id,revision,record_count,state_digest,state_auth_tag) VALUES($1,$2,$3,$4,$5)`,[tenantId,revision,computed.recordCount,computed.stateDigest,stateAuthTag]);
    try{this.#checkpointInitialize(checkpoint);}catch{throw new TelegramStoreErrorV1("integrity_failed");}});}

  async registerRecipient(input:unknown):Promise<{policy:TelegramRecipientPolicyV1;replayed:boolean}>{
    const policy=parse(telegramRecipientPolicySchemaV1,input) as TelegramRecipientPolicyV1;safe(policy);const digest=sha256Digest(policy);
    const material={tenantId:policy.tenantId,recipientId:policy.recipientId,chatIdDigest:policy.chatIdDigest,policyDigest:digest,verifiedAt:policy.verifiedAt,expiresAt:policy.policyExpiresAt};
    const tag=hmacSha256Tag(this.#key,material);
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,policy.tenantId);const existing=await tx.query<RecipientRow>("SELECT * FROM control_telegram_recipients WHERE tenant_id=$1 AND recipient_id=$2 FOR UPDATE",[policy.tenantId,policy.recipientId]);
      if(existing.rows[0]){const found=this.verifyRecipient(existing.rows[0]);if(sha256Digest(found)!==digest)throw new TelegramStoreErrorV1("record_conflict");return{policy:found,replayed:true};}
      await tx.query(`INSERT INTO control_telegram_recipients(tenant_id,recipient_id,chat_id_digest,policy_digest,policy_auth_tag,policy,verified_at,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [policy.tenantId,policy.recipientId,policy.chatIdDigest,digest,tag,JSON.stringify(policy),policy.verifiedAt,policy.policyExpiresAt]);
      await tx.query(`INSERT INTO control_telegram_recipient_policy_events(tenant_id,recipient_id,policy_digest,prior_policy_digest,policy_auth_tag,policy,occurred_at) VALUES($1,$2,$3,NULL,$4,$5::jsonb,$6)`,
        [policy.tenantId,policy.recipientId,digest,this.policyEventTag(policy.tenantId,policy.recipientId,digest,undefined,policy,policy.verifiedAt),JSON.stringify(policy),policy.verifiedAt]);await this.refreshTenantState(tx,policy.tenantId);return{policy,replayed:false};});
  }

  async replaceRecipientPolicy(input:{expectedPolicyDigest:string;policy:unknown}):Promise<TelegramRecipientPolicyV1>{
    if(!digestPattern.test(input.expectedPolicyDigest))throw new TelegramStoreErrorV1("invalid_record");const policy=parse(telegramRecipientPolicySchemaV1,input.policy) as TelegramRecipientPolicyV1;safe(policy);const digest=sha256Digest(policy);
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,policy.tenantId);const result=await tx.query<RecipientRow>("SELECT * FROM control_telegram_recipients WHERE tenant_id=$1 AND recipient_id=$2 FOR UPDATE",[policy.tenantId,policy.recipientId]);if(!result.rows[0])throw new TelegramStoreErrorV1("record_not_found");
      const prior=this.verifyRecipient(result.rows[0]);if(result.rows[0].policy_digest!==input.expectedPolicyDigest)throw new TelegramStoreErrorV1("record_conflict");
      if(policy.chatIdDigest!==prior.chatIdDigest||Date.parse(policy.verifiedAt)<Date.parse(prior.verifiedAt)||digest===input.expectedPolicyDigest)throw new TelegramStoreErrorV1("invalid_record");
      const material={tenantId:policy.tenantId,recipientId:policy.recipientId,chatIdDigest:policy.chatIdDigest,policyDigest:digest,verifiedAt:policy.verifiedAt,expiresAt:policy.policyExpiresAt};const tag=hmacSha256Tag(this.#key,material);
      await tx.query(`INSERT INTO control_telegram_recipient_policy_events(tenant_id,recipient_id,policy_digest,prior_policy_digest,policy_auth_tag,policy,occurred_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [policy.tenantId,policy.recipientId,digest,input.expectedPolicyDigest,this.policyEventTag(policy.tenantId,policy.recipientId,digest,input.expectedPolicyDigest,policy,policy.verifiedAt),JSON.stringify(policy),policy.verifiedAt]);
      await tx.query(`UPDATE control_telegram_recipients SET policy_digest=$3,policy_auth_tag=$4,policy=$5::jsonb,verified_at=$6,expires_at=$7 WHERE tenant_id=$1 AND recipient_id=$2`,
        [policy.tenantId,policy.recipientId,digest,tag,JSON.stringify(policy),policy.verifiedAt,policy.policyExpiresAt]);await this.refreshTenantState(tx,policy.tenantId);return policy;});
  }

  async registerCallback(input:{record:unknown;messagePlan:unknown}):Promise<{record:TelegramCallbackRecordV1;replayed:boolean}>{
    const record=parse(telegramCallbackRecordSchemaV1,input.record) as TelegramCallbackRecordV1;
    const messagePlan=parse(telegramMessagePlanSchemaV1,input.messagePlan) as TelegramMessagePlanV1;safe(record);safe(messagePlan);const digest=sha256Digest(record);
    if(record.messagePlanDigest!==sha256Digest(messagePlan)||record.tenantId!==messagePlan.tenantId||record.projectId!==messagePlan.projectId||record.recipientId!==messagePlan.recipientId
      ||record.attentionId!==messagePlan.attentionId||record.attentionDigest!==messagePlan.attentionDigest||record.messageClass!==messagePlan.messageClass||record.risk!==messagePlan.risk||!messagePlan.responseKinds.includes(record.responseKind)
      ||(["high","critical"] as string[]).includes(messagePlan.risk)||Date.parse(record.issuedAt)<Date.parse(messagePlan.createdAt)||Date.parse(record.expiresAt)>Date.parse(messagePlan.expiresAt)
      ||(record.responseKind==="answer_choice"&&!messagePlan.responseOptions.some((option)=>option.valueDigest===record.responseValueDigest)))throw new TelegramStoreErrorV1("callback_invalid");
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,record.tenantId);const recipient=await this.requireRecipient(tx,record.tenantId,record.recipientId,true);
      if(!recipient.enabled||recipient.chatIdDigest!==record.chatIdDigest||!recipient.allowedProjectIds.includes(record.projectId)||!recipient.allowedMessageClasses.includes(record.messageClass)||riskOrder.indexOf(record.risk)>riskOrder.indexOf(recipient.maximumRisk)||Date.parse(record.issuedAt)<Date.parse(recipient.verifiedAt)||Date.parse(record.expiresAt)>Date.parse(recipient.policyExpiresAt))throw new TelegramStoreErrorV1("recipient_not_allowed");
      const existing=await tx.query<CallbackRow>("SELECT * FROM control_telegram_callbacks WHERE tenant_id=$1 AND callback_id=$2 FOR UPDATE",[record.tenantId,record.callbackId]);
      if(existing.rows[0]){const found=this.verifyCallback(existing.rows[0]);if(sha256Digest(found)!==digest)throw new TelegramStoreErrorV1("record_conflict");return{record:found,replayed:true};}
      const material={tenantId:record.tenantId,callbackId:record.callbackId,projectId:record.projectId,recipientId:record.recipientId,recordDigest:digest,issuedAt:record.issuedAt,expiresAt:record.expiresAt};
      await tx.query(`INSERT INTO control_telegram_callbacks(tenant_id,callback_id,project_id,recipient_id,record_digest,record_auth_tag,record,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [record.tenantId,record.callbackId,record.projectId,record.recipientId,digest,hmacSha256Tag(this.#key,material),JSON.stringify(record),record.issuedAt,record.expiresAt]);await this.refreshTenantState(tx,record.tenantId);return{record,replayed:false};});
  }

  async consumeCallback(input:{tenantId:string;recipientId:string;observation:unknown;now:string}):Promise<TelegramCallbackReceiptV1>{
    validId(input.tenantId);validId(input.recipientId);validTime(input.now);const observation=parse(telegramWebhookObservationSchemaV1,input.observation) as TelegramWebhookObservationV1;
    if(Date.parse(observation.observedAt)>Date.parse(input.now)||Date.parse(input.now)-Date.parse(observation.observedAt)>5*60_000)throw new TelegramStoreErrorV1("callback_invalid");
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,input.tenantId);const recipient=await this.requireRecipient(tx,input.tenantId,input.recipientId,true);
      if(!recipient.enabled||Date.parse(input.now)<Date.parse(recipient.verifiedAt)||Date.parse(input.now)>=Date.parse(recipient.policyExpiresAt)||recipient.chatIdDigest!==observation.chatIdDigest)throw new TelegramStoreErrorV1("recipient_not_allowed");
      let tokenId:string;try{tokenId=parseTelegramCallbackTokenV1(observation.callbackToken).callbackId;}catch{throw new TelegramStoreErrorV1("callback_invalid");}const callbackResult=await tx.query<CallbackRow>("SELECT * FROM control_telegram_callbacks WHERE tenant_id=$1 AND callback_id=$2 FOR UPDATE",[input.tenantId,tokenId]);
      if(!callbackResult.rows[0])throw new TelegramStoreErrorV1("record_not_found");const record=this.verifyCallback(callbackResult.rows[0]);
      if(record.recipientId!==input.recipientId||record.chatIdDigest!==observation.chatIdDigest)throw new TelegramStoreErrorV1("scope_mismatch");
      if(!recipient.allowedProjectIds.includes(record.projectId)||!recipient.allowedMessageClasses.includes(record.messageClass)||riskOrder.indexOf(record.risk)>riskOrder.indexOf(recipient.maximumRisk))throw new TelegramStoreErrorV1("recipient_not_allowed");
      try{authenticateTelegramCallbackTokenV1({token:observation.callbackToken,record,now:input.now,key:this.#callbackKey});}catch{throw new TelegramStoreErrorV1("callback_invalid");}
      const observationDigest=sha256Digest(observation);const knownUpdate=await tx.query<UpdateRow>("SELECT * FROM control_telegram_updates WHERE tenant_id=$1 AND update_id=$2 FOR UPDATE",[input.tenantId,observation.updateId]);
      if(knownUpdate.rows[0]){this.verifyUpdate(knownUpdate.rows[0]);if(knownUpdate.rows[0].observation_digest!==observationDigest)throw new TelegramStoreErrorV1("replay_conflict");}
      const knownReceipt=await tx.query<ReceiptRow>("SELECT * FROM control_telegram_callback_receipts WHERE tenant_id=$1 AND callback_id=$2 FOR UPDATE",[input.tenantId,record.callbackId]);
      if(knownReceipt.rows[0]){const proposal=this.verifyReceipt(knownReceipt.rows[0]);if(knownReceipt.rows[0].update_id!==observation.updateId||proposal.callbackQueryIdDigest!==observation.callbackQueryIdDigest)throw new TelegramStoreErrorV1("callback_consumed");return{schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,status:"replayed",proposal};}
      if(knownUpdate.rows[0])throw new TelegramStoreErrorV1("replay_conflict");
      const stored:StoredObservation={schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,updateId:observation.updateId,bodyDigest:observation.bodyDigest,chatIdDigest:observation.chatIdDigest,
        callbackQueryIdDigest:observation.callbackQueryIdDigest,callbackTokenDigest:sha256Digest({token:observation.callbackToken}),observedAt:input.now};safe(stored);
      const updateMaterial={tenantId:input.tenantId,updateId:observation.updateId,observationDigest,storedObservationDigest:sha256Digest(stored),observedAt:input.now};
      await tx.query(`INSERT INTO control_telegram_updates(tenant_id,update_id,observation_digest,observation_auth_tag,observation,observed_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
        [input.tenantId,observation.updateId,observationDigest,hmacSha256Tag(this.#key,updateMaterial),JSON.stringify(stored),input.now]);
      const proposal=buildTelegramResponseProposalV1(record,observation,input.now);const proposalDigest=sha256Digest(proposal);
      const receiptMaterial={tenantId:input.tenantId,callbackId:record.callbackId,updateId:observation.updateId,proposalDigest,recordedAt:input.now};
      await tx.query(`INSERT INTO control_telegram_callback_receipts(tenant_id,callback_id,update_id,proposal_digest,proposal_auth_tag,proposal,recorded_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [input.tenantId,record.callbackId,observation.updateId,proposalDigest,hmacSha256Tag(this.#key,receiptMaterial),JSON.stringify(proposal),input.now]);await this.refreshTenantState(tx,input.tenantId);
      return{schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,status:"recorded",proposal};});
  }

  async enqueue(input:{deliveryId:string;idempotencyKey:string;presentation:unknown;now:string;notBefore?:string}):Promise<{delivery:TelegramDeliveryRecordV1;replayed:boolean}>{
    validId(input.deliveryId);validId(input.idempotencyKey);const presentation=parse(telegramPresentationSchemaV1,input.presentation) as TelegramPresentationV1;safe(presentation);
    if(Date.parse(input.now)>=Date.parse(presentation.expiresAt))throw new TelegramStoreErrorV1("invalid_record");
    const nextAttemptAt=input.notBefore??input.now;if(!Number.isFinite(Date.parse(nextAttemptAt))||Date.parse(nextAttemptAt)<Date.parse(input.now)||Date.parse(nextAttemptAt)>=Date.parse(presentation.expiresAt))throw new TelegramStoreErrorV1("invalid_record");
    if(presentation.delivery==="defer_quiet_hours"&&Date.parse(nextAttemptAt)<=Date.parse(input.now))throw new TelegramStoreErrorV1("invalid_record");
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,presentation.tenantId);const recipient=await this.requireRecipient(tx,presentation.tenantId,presentation.recipientId,true);
      if(!recipient.enabled||!recipient.allowedProjectIds.includes(presentation.projectId)||presentation.messageClasses.some((value)=>!recipient.allowedMessageClasses.includes(value))||
        riskOrder.indexOf(presentation.risk)>riskOrder.indexOf(recipient.maximumRisk)||Date.parse(input.now)<Date.parse(recipient.verifiedAt)||Date.parse(input.now)>=Date.parse(recipient.policyExpiresAt))throw new TelegramStoreErrorV1("recipient_not_allowed");
      const existing=await tx.query<DeliveryRow>("SELECT * FROM control_telegram_deliveries WHERE tenant_id=$1 AND (delivery_id=$2 OR idempotency_key=$3) FOR UPDATE",[presentation.tenantId,input.deliveryId,input.idempotencyKey]);
      if(existing.rows[0]){const found=this.verifyDelivery(existing.rows[0]);if(found.deliveryId!==input.deliveryId||found.idempotencyKey!==input.idempotencyKey||sha256Digest(found.presentation)!==sha256Digest(presentation))throw new TelegramStoreErrorV1("record_conflict");return{delivery:found,replayed:true};}
      const delivery:TelegramDeliveryRecordV1={schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,deliveryId:input.deliveryId,tenantId:presentation.tenantId,projectId:presentation.projectId,
        recipientId:presentation.recipientId,idempotencyKey:input.idempotencyKey,presentation,state:presentation.delivery==="defer_quiet_hours"?"retry_wait":"queued",attemptCount:0,
        nextAttemptAt,createdAt:input.now,updatedAt:input.now,grantsApproval:false,grantsExecutionAuthority:false};await this.insertDelivery(tx,delivery);return{delivery,replayed:false};});
  }

  async claimNext(input:{tenantId:string;claimId:string;now:string;leaseSeconds:number}):Promise<TelegramDeliveryRecordV1|undefined>{
    validId(input.tenantId);validId(input.claimId);validTime(input.now);if(!Number.isInteger(input.leaseSeconds)||input.leaseSeconds<5||input.leaseSeconds>60)throw new TelegramStoreErrorV1("invalid_record");
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,input.tenantId);await this.recoverExpired(tx,input.tenantId,input.now);
      const candidateResult=await tx.query<DeliveryRow>(`SELECT * FROM control_telegram_deliveries WHERE tenant_id=$1 AND state IN ('queued','retry_wait') AND next_attempt_at<=$2 ORDER BY next_attempt_at,created_at,delivery_id LIMIT 1`,[input.tenantId,input.now]);
      if(!candidateResult.rows[0])return undefined;const candidate=this.verifyDelivery(candidateResult.rows[0]);
      const recipient=await this.requireRecipient(tx,candidate.tenantId,candidate.recipientId,true);
      const result=await tx.query<DeliveryRow>(`SELECT * FROM control_telegram_deliveries WHERE tenant_id=$1 AND delivery_id=$2 AND state IN ('queued','retry_wait') AND next_attempt_at<=$3 FOR UPDATE`,[input.tenantId,candidate.deliveryId,input.now]);
      if(!result.rows[0])return undefined;const current=this.verifyDelivery(result.rows[0]);
      const disallowed=!recipient.enabled||!recipient.allowedProjectIds.includes(current.projectId)||current.presentation.messageClasses.some((value)=>!recipient.allowedMessageClasses.includes(value))||
        riskOrder.indexOf(current.presentation.risk)>riskOrder.indexOf(recipient.maximumRisk)||Date.parse(input.now)<Date.parse(recipient.verifiedAt)||Date.parse(input.now)>=Date.parse(recipient.policyExpiresAt);
      if(disallowed){await this.updateDelivery(tx,{...current,state:"dead_letter",safeReasonCode:"recipient_policy_not_current",updatedAt:input.now});return undefined;}
      if(Date.parse(input.now)>=Date.parse(current.presentation.expiresAt)){await this.updateDelivery(tx,{...current,state:"dead_letter",safeReasonCode:"presentation_expired",updatedAt:input.now});return undefined;}
      return this.updateDelivery(tx,{...current,state:"sending",attemptCount:current.attemptCount+1,claimId:input.claimId,claimExpiresAt:new Date(Date.parse(input.now)+input.leaseSeconds*1000).toISOString(),updatedAt:input.now});});
  }

  async settle(input:TelegramSettlementInputV1):Promise<TelegramDeliveryReceiptV1>{
    const settlement=exactInput<TelegramSettlementInputV1>(input,["tenantId","deliveryId","claimId","now","outcome"],["providerReceiptDigest","safeReasonCode","retryAfterSeconds"]);
    if(typeof settlement.tenantId!=="string"||typeof settlement.deliveryId!=="string"||typeof settlement.claimId!=="string"||typeof settlement.now!=="string"||!(["delivered","definite_failure","ambiguous"] as unknown[]).includes(settlement.outcome)
      ||(settlement.providerReceiptDigest!==undefined&&typeof settlement.providerReceiptDigest!=="string")||(settlement.safeReasonCode!==undefined&&typeof settlement.safeReasonCode!=="string")||(settlement.retryAfterSeconds!==undefined&&typeof settlement.retryAfterSeconds!=="number"))throw new TelegramStoreErrorV1("invalid_record");
    validId(settlement.tenantId);validId(settlement.deliveryId);validId(settlement.claimId);validTime(settlement.now);if(settlement.safeReasonCode)validId(settlement.safeReasonCode);if(settlement.providerReceiptDigest&&!digestPattern.test(settlement.providerReceiptDigest))throw new TelegramStoreErrorV1("invalid_record");
    if((settlement.outcome==="delivered"&&(!settlement.providerReceiptDigest||settlement.safeReasonCode!==undefined||settlement.retryAfterSeconds!==undefined))
      ||(settlement.outcome==="ambiguous"&&(settlement.providerReceiptDigest!==undefined||settlement.retryAfterSeconds!==undefined))
      ||(settlement.outcome==="definite_failure"&&settlement.providerReceiptDigest!==undefined))throw new TelegramStoreErrorV1("invalid_record");
    return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,settlement.tenantId);const result=await tx.query<DeliveryRow>("SELECT * FROM control_telegram_deliveries WHERE tenant_id=$1 AND delivery_id=$2 FOR UPDATE",[settlement.tenantId,settlement.deliveryId]);if(!result.rows[0])throw new TelegramStoreErrorV1("record_not_found");
      const current=this.verifyDelivery(result.rows[0]);if(current.state!=="sending"){
        const matches=current.lastClaimId===settlement.claimId&&this.matchesSettlementReplay(current,settlement);
        if(!matches)throw new TelegramStoreErrorV1("claim_mismatch");return this.receipt(current,current.updatedAt);
      }
      if(current.claimId!==settlement.claimId||Date.parse(settlement.now)>=Date.parse(current.claimExpiresAt!))throw new TelegramStoreErrorV1("claim_mismatch");let next:TelegramDeliveryRecordV1;
      if(settlement.outcome==="delivered"){if(!settlement.providerReceiptDigest)throw new TelegramStoreErrorV1("invalid_record");next={...current,state:"delivered",lastClaimId:settlement.claimId,providerReceiptDigest:settlement.providerReceiptDigest,updatedAt:settlement.now};}
      else if(settlement.outcome==="ambiguous")next={...current,state:"ambiguous",lastClaimId:settlement.claimId,safeReasonCode:settlement.safeReasonCode??"provider_outcome_ambiguous",updatedAt:settlement.now};
      else {if(current.attemptCount>=3&&settlement.retryAfterSeconds!==undefined)throw new TelegramStoreErrorV1("invalid_record");const retry=settlement.retryAfterSeconds??30;if(!Number.isInteger(retry)||retry<1||retry>3600)throw new TelegramStoreErrorV1("invalid_record");next=current.attemptCount>=3?{...current,state:"dead_letter",lastClaimId:settlement.claimId,safeReasonCode:settlement.safeReasonCode??"retry_exhausted",updatedAt:settlement.now}:{...current,state:"retry_wait",lastClaimId:settlement.claimId,nextAttemptAt:new Date(Date.parse(settlement.now)+retry*1000).toISOString(),safeReasonCode:settlement.safeReasonCode??"definite_transport_failure",updatedAt:settlement.now};}
      delete next.claimId;delete next.claimExpiresAt;next=await this.updateDelivery(tx,next);return{schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,deliveryId:next.deliveryId,state:next.state as TelegramDeliveryReceiptV1["state"],attemptCount:next.attemptCount,
        ...(next.providerReceiptDigest?{providerReceiptDigest:next.providerReceiptDigest}:{}),...(next.safeReasonCode?{safeReasonCode:next.safeReasonCode}:{}),recordedAt:settlement.now,grantsApproval:false,grantsExecutionAuthority:false};});
  }

  async recoverExpiredClaims(tenantId:string,now:string):Promise<number>{validId(tenantId);validTime(now);return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,tenantId);return this.recoverExpired(tx,tenantId,now);});}
  async getDelivery(tenantId:string,deliveryId:string):Promise<TelegramDeliveryRecordV1|undefined>{validId(tenantId);validId(deliveryId);return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,tenantId);const result=await tx.query<DeliveryRow>("SELECT * FROM control_telegram_deliveries WHERE tenant_id=$1 AND delivery_id=$2",[tenantId,deliveryId]);return result.rows[0]?this.verifyDelivery(result.rows[0]):undefined;});}
  async listRecipientPolicyHistory(tenantId:string,recipientId:string):Promise<TelegramRecipientPolicyEventV1[]>{validId(tenantId);validId(recipientId);return this.db.transaction(async(tx)=>{await this.lockAndVerifyTenantState(tx,tenantId);const result=await tx.query<PolicyEventRow>("SELECT * FROM control_telegram_recipient_policy_events WHERE tenant_id=$1 AND recipient_id=$2 ORDER BY occurred_at,policy_digest",[tenantId,recipientId]);return result.rows.map((row)=>this.verifyPolicyEvent(row));});}

  private async recoverExpired(tx:DatabaseSession,tenantId:string,now:string):Promise<number>{const rows=await tx.query<DeliveryRow>("SELECT * FROM control_telegram_deliveries WHERE tenant_id=$1 AND state='sending' AND claim_expires_at<=$2 FOR UPDATE",[tenantId,now]);
    for(const row of rows.rows){const current=this.verifyDelivery(row);const next={...current,state:"ambiguous" as const,lastClaimId:current.claimId,safeReasonCode:"claim_expired_outcome_unknown",updatedAt:now};delete next.claimId;delete next.claimExpiresAt;await this.updateDelivery(tx,next);}return rows.rows.length;}
  private async requireRecipient(source:Source,tenantId:string,recipientId:string,lock=false){const result=await source.query<RecipientRow>(`SELECT * FROM control_telegram_recipients WHERE tenant_id=$1 AND recipient_id=$2${lock?" FOR UPDATE":""}`,[tenantId,recipientId]);if(!result.rows[0])throw new TelegramStoreErrorV1("record_not_found");return this.verifyRecipient(result.rows[0]);}
  private verifyRecipient(row:RecipientRow){const policy=parse(telegramRecipientPolicySchemaV1,row.policy) as TelegramRecipientPolicyV1;const material={tenantId:row.tenant_id,recipientId:row.recipient_id,chatIdDigest:row.chat_id_digest,policyDigest:row.policy_digest,verifiedAt:iso(row.verified_at),expiresAt:iso(row.expires_at)};
    if(policy.tenantId!==row.tenant_id||policy.recipientId!==row.recipient_id||policy.chatIdDigest!==row.chat_id_digest||sha256Digest(policy)!==row.policy_digest||policy.verifiedAt!==iso(row.verified_at)||policy.policyExpiresAt!==iso(row.expires_at)||!equal(hmacSha256Tag(this.#key,material),row.policy_auth_tag))throw new TelegramStoreErrorV1("integrity_failed");safe(policy);return policy;}
  private policyEventTag(tenantId:string,recipientId:string,policyDigest:string,priorPolicyDigest:string|undefined,policy:TelegramRecipientPolicyV1,occurredAt:string){return hmacSha256Tag(this.#key,{tenantId,recipientId,policyDigest,priorPolicyDigest:priorPolicyDigest??null,policy,occurredAt});}
  private verifyPolicyEvent(row:PolicyEventRow):TelegramRecipientPolicyEventV1{const policy=parse(telegramRecipientPolicySchemaV1,row.policy) as TelegramRecipientPolicyV1;const occurredAt=iso(row.occurred_at);const priorPolicyDigest=row.prior_policy_digest??undefined;
    if(policy.tenantId!==row.tenant_id||policy.recipientId!==row.recipient_id||policy.verifiedAt!==occurredAt||sha256Digest(policy)!==row.policy_digest||!equal(this.policyEventTag(row.tenant_id,row.recipient_id,row.policy_digest,priorPolicyDigest,policy,occurredAt),row.policy_auth_tag))throw new TelegramStoreErrorV1("integrity_failed");safe(policy);return{tenantId:row.tenant_id,recipientId:row.recipient_id,policyDigest:row.policy_digest,...(priorPolicyDigest?{priorPolicyDigest}:{}),policy,occurredAt};}
  private verifyCallback(row:CallbackRow){const record=parse(telegramCallbackRecordSchemaV1,row.record) as TelegramCallbackRecordV1;const material={tenantId:row.tenant_id,callbackId:row.callback_id,projectId:row.project_id,recipientId:row.recipient_id,recordDigest:row.record_digest,issuedAt:iso(row.issued_at),expiresAt:iso(row.expires_at)};
    if(record.tenantId!==row.tenant_id||record.callbackId!==row.callback_id||record.projectId!==row.project_id||record.recipientId!==row.recipient_id||record.issuedAt!==iso(row.issued_at)||record.expiresAt!==iso(row.expires_at)||sha256Digest(record)!==row.record_digest||!equal(hmacSha256Tag(this.#key,material),row.record_auth_tag))throw new TelegramStoreErrorV1("integrity_failed");safe(record);return record;}
  private verifyUpdate(row:UpdateRow){const value=row.observation;const material={tenantId:row.tenant_id,updateId:Number(row.update_id),observationDigest:row.observation_digest,storedObservationDigest:sha256Digest(value),observedAt:iso(row.observed_at)};
    const exactKeys=["bodyDigest","callbackQueryIdDigest","callbackTokenDigest","chatIdDigest","observedAt","schemaVersion","updateId"];
    if(JSON.stringify(Object.keys(value).sort())!==JSON.stringify(exactKeys)||value.schemaVersion!==TELEGRAM_CONTRACT_VERSION_V1||value.updateId!==Number(row.update_id)||value.observedAt!==iso(row.observed_at)||
      !digestPattern.test(value.bodyDigest)||!digestPattern.test(value.chatIdDigest)||!digestPattern.test(value.callbackQueryIdDigest)||!digestPattern.test(value.callbackTokenDigest)||!equal(hmacSha256Tag(this.#key,material),row.observation_auth_tag))throw new TelegramStoreErrorV1("integrity_failed");safe(value);return value;}
  private verifyReceipt(row:ReceiptRow){const proposal=row.proposal;const material={tenantId:row.tenant_id,callbackId:row.callback_id,updateId:Number(row.update_id),proposalDigest:row.proposal_digest,recordedAt:iso(row.recorded_at)};
    if(proposal.tenantId!==row.tenant_id||proposal.callbackId!==row.callback_id||proposal.updateId!==Number(row.update_id)||proposal.observedAt!==iso(row.recorded_at)||sha256Digest(proposal)!==row.proposal_digest||!equal(hmacSha256Tag(this.#key,material),row.proposal_auth_tag))throw new TelegramStoreErrorV1("integrity_failed");safe(proposal);return proposal;}
  private deliveryTag(value:TelegramDeliveryRecordV1){return hmacSha256Tag(this.#key,value);}
  private verifyDelivery(row:DeliveryRow):TelegramDeliveryRecordV1{const presentation=parse(telegramPresentationSchemaV1,row.presentation) as TelegramPresentationV1;const value:TelegramDeliveryRecordV1={schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,deliveryId:row.delivery_id,tenantId:row.tenant_id,projectId:row.project_id,recipientId:row.recipient_id,idempotencyKey:row.idempotency_key,presentation,state:row.state,attemptCount:row.attempt_count,nextAttemptAt:iso(row.next_attempt_at),
      ...(row.claim_id?{claimId:row.claim_id}:{}),...(row.claim_expires_at?{claimExpiresAt:iso(row.claim_expires_at)}:{}),...(row.last_claim_id?{lastClaimId:row.last_claim_id}:{}),
      ...(row.provider_receipt_digest?{providerReceiptDigest:row.provider_receipt_digest}:{}),...(row.safe_reason_code?{safeReasonCode:row.safe_reason_code}:{}),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),grantsApproval:false,grantsExecutionAuthority:false};
    if(sha256Digest(presentation)!==row.presentation_digest||!equal(this.deliveryTag(value),row.state_auth_tag))throw new TelegramStoreErrorV1("integrity_failed");safe(value);return value;}
  private receipt(value:TelegramDeliveryRecordV1,recordedAt:string):TelegramDeliveryReceiptV1{return{schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,deliveryId:value.deliveryId,state:value.state as TelegramDeliveryReceiptV1["state"],attemptCount:value.attemptCount,...(value.providerReceiptDigest?{providerReceiptDigest:value.providerReceiptDigest}:{}),...(value.safeReasonCode?{safeReasonCode:value.safeReasonCode}:{}),recordedAt,grantsApproval:false,grantsExecutionAuthority:false};}
  private matchesSettlementReplay(value:TelegramDeliveryRecordV1,input:TelegramSettlementInputV1){if(input.outcome==="delivered")return value.state==="delivered"&&value.providerReceiptDigest===input.providerReceiptDigest;
    if(input.outcome==="ambiguous")return value.state==="ambiguous"&&value.safeReasonCode===(input.safeReasonCode??"provider_outcome_ambiguous");
    if(value.state==="retry_wait")return value.safeReasonCode===(input.safeReasonCode??"definite_transport_failure")&&Date.parse(value.nextAttemptAt)-Date.parse(value.updatedAt)===(input.retryAfterSeconds??30)*1000;
    return value.state==="dead_letter"&&input.retryAfterSeconds===undefined&&value.safeReasonCode===(input.safeReasonCode??"retry_exhausted");}
  private async insertDelivery(tx:DatabaseSession,value:TelegramDeliveryRecordV1){await tx.query(`INSERT INTO control_telegram_deliveries(tenant_id,delivery_id,project_id,recipient_id,idempotency_key,presentation_digest,presentation,state,attempt_count,next_attempt_at,claim_id,claim_expires_at,last_claim_id,provider_receipt_digest,safe_reason_code,created_at,updated_at,state_auth_tag) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [value.tenantId,value.deliveryId,value.projectId,value.recipientId,value.idempotencyKey,sha256Digest(value.presentation),JSON.stringify(value.presentation),value.state,value.attemptCount,value.nextAttemptAt,value.claimId??null,value.claimExpiresAt??null,value.lastClaimId??null,value.providerReceiptDigest??null,value.safeReasonCode??null,value.createdAt,value.updatedAt,this.deliveryTag(value)]);await this.refreshTenantState(tx,value.tenantId);}
  private async updateDelivery(tx:DatabaseSession,value:TelegramDeliveryRecordV1){safe(value);const result=await tx.query<{delivery_id:string}>(`UPDATE control_telegram_deliveries SET state=$3,attempt_count=$4,next_attempt_at=$5,claim_id=$6,claim_expires_at=$7,last_claim_id=$8,provider_receipt_digest=$9,safe_reason_code=$10,updated_at=$11,state_auth_tag=$12 WHERE tenant_id=$1 AND delivery_id=$2 RETURNING delivery_id`,
    [value.tenantId,value.deliveryId,value.state,value.attemptCount,value.nextAttemptAt,value.claimId??null,value.claimExpiresAt??null,value.lastClaimId??null,value.providerReceiptDigest??null,value.safeReasonCode??null,value.updatedAt,this.deliveryTag(value)]);if(!result.rows[0])throw new TelegramStoreErrorV1("record_not_found");await this.refreshTenantState(tx,value.tenantId);return value;}

  private checkpointScope(tenantId:string){return `telegram:${tenantId}`;}
  private tenantStateTag(tenantId:string,revision:number,recordCount:number,stateDigest:string){return hmacSha256Tag(this.#key,{module:"telegram",tenantId,revision,recordCount,stateDigest});}
  private checkpoint(tenantId:string,revision:number,recordCount:number,stateDigest:string,stateAuthTag:string):RollbackCheckpointV1{return{schema:ROLLBACK_CHECKPOINT_SCHEMA_V1,scope:this.checkpointScope(tenantId),revision,recordCount,stateDigest,stateAuthTag};}
  private readCheckpoint(tenantId:string){try{return this.#checkpointRead(this.checkpointScope(tenantId));}catch{throw new TelegramStoreErrorV1("integrity_failed");}}
  private assertCheckpoint(tenantId:string,row:TelegramIntegrityRow){try{const expected=this.checkpoint(tenantId,Number(row.revision),Number(row.record_count),row.state_digest,row.state_auth_tag),known=this.readCheckpoint(tenantId);if(!known||rollbackCheckpointDigestV1(known)!==rollbackCheckpointDigestV1(expected))throw new Error("mismatch");return expected;}catch{throw new TelegramStoreErrorV1("integrity_failed");}}
  private async computedTenantState(source:Source,tenantId:string){
    const [recipients,events,callbacks,updates,receipts,deliveries]=await Promise.all([
      source.query<RecipientRow>("SELECT * FROM control_telegram_recipients WHERE tenant_id=$1 ORDER BY recipient_id",[tenantId]),
      source.query<PolicyEventRow>("SELECT * FROM control_telegram_recipient_policy_events WHERE tenant_id=$1 ORDER BY recipient_id,occurred_at,policy_digest",[tenantId]),
      source.query<CallbackRow>("SELECT * FROM control_telegram_callbacks WHERE tenant_id=$1 ORDER BY callback_id",[tenantId]),
      source.query<UpdateRow>("SELECT * FROM control_telegram_updates WHERE tenant_id=$1 ORDER BY update_id",[tenantId]),
      source.query<ReceiptRow>("SELECT * FROM control_telegram_callback_receipts WHERE tenant_id=$1 ORDER BY callback_id",[tenantId]),
      source.query<DeliveryRow>("SELECT * FROM control_telegram_deliveries WHERE tenant_id=$1 ORDER BY delivery_id",[tenantId]),
    ]);
    for(const row of recipients.rows)this.verifyRecipient(row);for(const row of events.rows)this.verifyPolicyEvent(row);for(const row of callbacks.rows)this.verifyCallback(row);
    for(const row of updates.rows)this.verifyUpdate(row);for(const row of receipts.rows)this.verifyReceipt(row);for(const row of deliveries.rows)this.verifyDelivery(row);
    const state={
      recipients:recipients.rows.map((row)=>[row.recipient_id,row.policy_digest,row.policy_auth_tag]),
      policyEvents:events.rows.map((row)=>[row.recipient_id,row.policy_digest,row.prior_policy_digest,row.policy_auth_tag]),
      callbacks:callbacks.rows.map((row)=>[row.callback_id,row.record_digest,row.record_auth_tag]),
      updates:updates.rows.map((row)=>[Number(row.update_id),row.observation_digest,row.observation_auth_tag]),
      receipts:receipts.rows.map((row)=>[row.callback_id,Number(row.update_id),row.proposal_digest,row.proposal_auth_tag]),
      deliveries:deliveries.rows.map((row)=>[row.delivery_id,row.state,row.state_auth_tag]),
    };
    const recordCount=recipients.rows.length+events.rows.length+callbacks.rows.length+updates.rows.length+receipts.rows.length+deliveries.rows.length;
    return{recordCount,stateDigest:sha256Digest({tenantId,state})};
  }
  private async lockAndVerifyTenantState(source:DatabaseSession,tenantId:string){
    const result=await source.query<TelegramIntegrityRow>("SELECT * FROM control_telegram_integrity WHERE tenant_id=$1 FOR UPDATE",[tenantId]);
    const row=result.rows[0],computed=await this.computedTenantState(source,tenantId);
    if(!row||Number(row.revision)<1||Number(row.record_count)!==computed.recordCount||row.state_digest!==computed.stateDigest||!equal(row.state_auth_tag,this.tenantStateTag(tenantId,Number(row.revision),computed.recordCount,computed.stateDigest)))throw new TelegramStoreErrorV1("integrity_failed");this.assertCheckpoint(tenantId,row);
  }
  private async refreshTenantState(source:DatabaseSession,tenantId:string){const priorResult=await source.query<TelegramIntegrityRow>("SELECT * FROM control_telegram_integrity WHERE tenant_id=$1 FOR UPDATE",[tenantId]),prior=priorResult.rows[0];if(!prior)throw new TelegramStoreErrorV1("integrity_failed");const expected=this.assertCheckpoint(tenantId,prior),computed=await this.computedTenantState(source,tenantId),revision=Number(prior.revision)+1,stateAuthTag=this.tenantStateTag(tenantId,revision,computed.recordCount,computed.stateDigest),next=this.checkpoint(tenantId,revision,computed.recordCount,computed.stateDigest,stateAuthTag);
    const result=await source.query<{tenant_id:string}>(`UPDATE control_telegram_integrity SET revision=$2,record_count=$3,state_digest=$4,state_auth_tag=$5 WHERE tenant_id=$1 AND revision=$6 RETURNING tenant_id`,[tenantId,revision,computed.recordCount,computed.stateDigest,stateAuthTag,Number(prior.revision)]);if(!result.rows[0])throw new TelegramStoreErrorV1("integrity_failed");try{this.#checkpointAdvance(rollbackCheckpointDigestV1(expected),next);}catch{throw new TelegramStoreErrorV1("integrity_failed");}}
}
