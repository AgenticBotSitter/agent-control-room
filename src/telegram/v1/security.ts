import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson, sha256Digest } from "../../security/digest";
import { assertNoSecretMaterial } from "../../security/redaction";
import { TELEGRAM_CALLBACK_TOKEN_PATTERN_V1, telegramCallbackRecordSchemaV1, telegramCallbackTokenSchemaV1, telegramResponseProposalSchemaV1, telegramWebhookObservationSchemaV1 } from "./schemas";
import { TELEGRAM_CONTRACT_VERSION_V1, type TelegramCallbackReceiptV1, type TelegramCallbackRecordV1, type TelegramResponseProposalV1, type TelegramWebhookObservationV1 } from "./types";

const TOKEN_TAG_BYTES=16;

function secretDigest(value:string):Buffer { return createHash("sha256").update(value,"utf8").digest(); }

export function verifyTelegramWebhookSecretV1(input:{presentedSecret:string;expectedSecretDigest:string}):void {
  if(typeof input.presentedSecret!=="string"||input.presentedSecret.length<32||input.presentedSecret.length>256) throw new Error("webhook authentication failed");
  if(!/^sha256:[a-f0-9]{64}$/.test(input.expectedSecretDigest)) throw new Error("webhook configuration invalid");
  const actual=secretDigest(input.presentedSecret);
  const expected=Buffer.from(input.expectedSecretDigest.slice(7),"hex");
  if(!timingSafeEqual(actual,expected)) throw new Error("webhook authentication failed");
}

function callbackTag(record:TelegramCallbackRecordV1,key:Uint8Array):Buffer {
  if(!(key instanceof Uint8Array)||key.byteLength<32) throw new Error("callback signing key invalid");
  return createHmac("sha256",key).update(canonicalJson(record),"utf8").digest().subarray(0,TOKEN_TAG_BYTES);
}

export function issueTelegramCallbackTokenV1(recordInput:unknown,key:Uint8Array):string {
  const record=telegramCallbackRecordSchemaV1.parse(recordInput) as TelegramCallbackRecordV1;
  const token=`${record.callbackId}.${callbackTag(record,key).toString("base64url")}`;
  if(Buffer.byteLength(token,"utf8")>64) throw new Error("callback token exceeds Telegram limit");
  return token;
}

export function parseTelegramCallbackTokenV1(token:string):{callbackId:string;tag:Buffer} {
  if(!telegramCallbackTokenSchemaV1.safeParse(token).success) throw new Error("callback token invalid");
  const match=TELEGRAM_CALLBACK_TOKEN_PATTERN_V1.exec(token);
  if(!match) throw new Error("callback token invalid");
  const tag=Buffer.from(match[2],"base64url");
  if(tag.length!==TOKEN_TAG_BYTES||tag.toString("base64url")!==match[2]) throw new Error("callback token invalid");
  return {callbackId:match[1],tag};
}

export function authenticateTelegramCallbackTokenV1(input:{token:string;record:unknown;now:string;key:Uint8Array}):TelegramCallbackRecordV1 {
  const record=telegramCallbackRecordSchemaV1.parse(input.record) as TelegramCallbackRecordV1;
  const now=Date.parse(input.now);if(!Number.isFinite(now)) throw new Error("current time invalid");
  const parsedToken=parseTelegramCallbackTokenV1(input.token);if(parsedToken.callbackId!==record.callbackId) throw new Error("callback identity mismatch");
  if(now<Date.parse(record.issuedAt)) throw new Error("callback not yet valid");
  if(now>=Date.parse(record.expiresAt)) throw new Error("callback expired");
  const expectedTag=callbackTag(record,input.key);
  if(parsedToken.tag.length!==expectedTag.length||!timingSafeEqual(parsedToken.tag,expectedTag)) throw new Error("callback authentication failed");
  return record;
}

export function buildTelegramResponseProposalV1(record:TelegramCallbackRecordV1,observation:TelegramWebhookObservationV1,observedAt:string):TelegramResponseProposalV1 {
  const proposal:TelegramResponseProposalV1={schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,
    proposalId:`tgproposal:${sha256Digest({callbackId:record.callbackId,callbackQueryIdDigest:observation.callbackQueryIdDigest}).slice(7,39)}`,
    tenantId:record.tenantId,projectId:record.projectId,recipientId:record.recipientId,attentionId:record.attentionId,
    attentionDigest:record.attentionDigest,responseKind:record.responseKind,...(record.responseValueDigest?{responseValueDigest:record.responseValueDigest}:{}),
    callbackId:record.callbackId,updateId:observation.updateId,callbackQueryIdDigest:observation.callbackQueryIdDigest,observedAt,
    grantsApproval:false,grantsExecutionAuthority:false,requiresIndependentPolicyEvaluation:true};
  telegramResponseProposalSchemaV1.parse(proposal);assertNoSecretMaterial(proposal,"Telegram response proposal");return proposal;
}

export interface TelegramCallbackStoreV1 {
  getCallback(callbackId:string):TelegramCallbackRecordV1|undefined;
  consume(input:{record:TelegramCallbackRecordV1;observation:TelegramWebhookObservationV1;proposal:TelegramResponseProposalV1}):TelegramCallbackReceiptV1;
}

export function consumeTelegramCallbackV1(input:{observation:unknown;expectedChatIdDigest:string;now:string;key:Uint8Array;store:TelegramCallbackStoreV1}):TelegramCallbackReceiptV1 {
  const observation=telegramWebhookObservationSchemaV1.parse(input.observation) as TelegramWebhookObservationV1;
  const now=Date.parse(input.now);
  if(!Number.isFinite(now)) throw new Error("current time invalid");
  if(observation.chatIdDigest!==input.expectedChatIdDigest) throw new Error("recipient chat binding mismatch");
  const parsedToken=parseTelegramCallbackTokenV1(observation.callbackToken);
  const record=input.store.getCallback(parsedToken.callbackId);
  if(!record) throw new Error("callback not found");
  telegramCallbackRecordSchemaV1.parse(record);
  if(record.chatIdDigest!==observation.chatIdDigest) throw new Error("callback recipient mismatch");
  authenticateTelegramCallbackTokenV1({token:observation.callbackToken,record,now:input.now,key:input.key});
  const proposal=buildTelegramResponseProposalV1(record,observation,input.now);
  return input.store.consume({record,observation,proposal});
}

export class InMemoryTelegramCallbackStoreV1 implements TelegramCallbackStoreV1 {
  readonly #callbacks=new Map<string,TelegramCallbackRecordV1>();
  readonly #receiptsByCallback=new Map<string,TelegramCallbackReceiptV1>();
  readonly #updates=new Map<number,string>();
  constructor(records:TelegramCallbackRecordV1[]) { for(const value of records){ const record=telegramCallbackRecordSchemaV1.parse(value) as TelegramCallbackRecordV1;
    if(this.#callbacks.has(record.callbackId)) throw new Error("duplicate callback id"); this.#callbacks.set(record.callbackId,structuredClone(record)); } }
  getCallback(callbackId:string):TelegramCallbackRecordV1|undefined { const value=this.#callbacks.get(callbackId); return value?structuredClone(value):undefined; }
  consume(input:{record:TelegramCallbackRecordV1;observation:TelegramWebhookObservationV1;proposal:TelegramResponseProposalV1}):TelegramCallbackReceiptV1 {
    const updateDigest=sha256Digest(input.observation);
    const knownUpdate=this.#updates.get(input.observation.updateId);
    if(knownUpdate&&knownUpdate!==updateDigest) throw new Error("Telegram update replay conflict");
    const existing=this.#receiptsByCallback.get(input.record.callbackId);
    if(existing){
      if(existing.proposal.callbackQueryIdDigest!==input.proposal.callbackQueryIdDigest||existing.proposal.updateId!==input.proposal.updateId)
        throw new Error("callback already consumed by different update");
      this.#updates.set(input.observation.updateId,updateDigest);
      return structuredClone({...existing,status:"replayed"});
    }
    if(knownUpdate) throw new Error("Telegram update already bound to another callback");
    const receipt:TelegramCallbackReceiptV1={schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,status:"recorded",proposal:structuredClone(input.proposal)};
    this.#updates.set(input.observation.updateId,updateDigest); this.#receiptsByCallback.set(input.record.callbackId,receipt);
    return structuredClone(receipt);
  }
}

export function telegramSecretDigestForConfigurationV1(secret:string):string {
  if(typeof secret!=="string"||secret.length<32||secret.length>256) throw new Error("webhook secret invalid");
  return `sha256:${secretDigest(secret).toString("hex")}`;
}
