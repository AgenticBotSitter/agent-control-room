import { randomBytes } from "node:crypto";
import { assertNoSecretMaterial } from "../../security/redaction";
import { TelegramDurableStoreV1, TelegramStoreErrorV1, type TelegramDeliveryReceiptV1 } from "./durable-store";
import { verifyTelegramWebhookSecretV1 } from "./security";
import type { TelegramCallbackReceiptV1, TelegramPresentationV1 } from "./types";

export class TelegramIngressServiceV1 {
  constructor(private readonly store:TelegramDurableStoreV1,private readonly expectedWebhookSecretDigest:string,private readonly clock:()=>string=()=>new Date().toISOString()){
    if(!/^sha256:[a-f0-9]{64}$/.test(expectedWebhookSecretDigest))throw new TelegramStoreErrorV1("integrity_failed");
  }
  async handleCallback(input:{presentedWebhookSecret:string;tenantId:string;recipientId:string;observation:unknown}):Promise<TelegramCallbackReceiptV1>{
    try{verifyTelegramWebhookSecretV1({presentedSecret:input.presentedWebhookSecret,expectedSecretDigest:this.expectedWebhookSecretDigest});}
    catch{throw new TelegramStoreErrorV1("callback_invalid");}
    const now=this.clock();if(typeof now!=="string"||!Number.isFinite(Date.parse(now)))throw new TelegramStoreErrorV1("callback_invalid");
    return this.store.consumeCallback({tenantId:input.tenantId,recipientId:input.recipientId,observation:input.observation,now});
  }
}

export type SyntheticTelegramTransportResultV1={outcome:"delivered";providerReceiptDigest:string}|{outcome:"definite_failure";safeReasonCode:string;retryAfterSeconds:number}|{outcome:"ambiguous";safeReasonCode:string};
export interface SyntheticTelegramTransportV1 {send(presentation:TelegramPresentationV1):Promise<SyntheticTelegramTransportResultV1>;}

/** Test-only orchestration seam. Production transport remains absent and disabled. */
export class TelegramSyntheticDeliveryCoordinatorV1 {
  constructor(private readonly store:TelegramDurableStoreV1,private readonly clock:()=>string){ }
  async drainOne(tenantId:string,transport:SyntheticTelegramTransportV1):Promise<TelegramDeliveryReceiptV1|undefined>{
    const claimId=`tgclaim:${randomBytes(16).toString("hex")}`;const claimed=await this.store.claimNext({tenantId,claimId,now:this.clock(),leaseSeconds:60});if(!claimed)return undefined;
    let result:SyntheticTelegramTransportResultV1;try{result=await transport.send(claimed.presentation);assertNoSecretMaterial(result,"synthetic Telegram result");}
    catch{return this.store.settle({tenantId,deliveryId:claimed.deliveryId,claimId,now:this.clock(),outcome:"ambiguous",safeReasonCode:"synthetic_transport_threw_outcome_unknown"});}
    if(result.outcome==="delivered")return this.store.settle({tenantId,deliveryId:claimed.deliveryId,claimId,now:this.clock(),outcome:"delivered",providerReceiptDigest:result.providerReceiptDigest});
    if(result.outcome==="definite_failure")return this.store.settle({tenantId,deliveryId:claimed.deliveryId,claimId,now:this.clock(),outcome:"definite_failure",safeReasonCode:result.safeReasonCode,retryAfterSeconds:result.retryAfterSeconds});
    return this.store.settle({tenantId,deliveryId:claimed.deliveryId,claimId,now:this.clock(),outcome:"ambiguous",safeReasonCode:result.safeReasonCode});
  }
}
