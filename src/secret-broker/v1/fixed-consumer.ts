import {parseSecretInvocationGrantV1} from "./grant";
import type {NodeLocalSecretConsumerV1,SecretInvocationReceiptV1} from "./types";
import {NodeLocalSecretBrokerV1} from "./broker";
import {dataMethodV1,exactHostDataArrayV1,exactHostDataSnapshotV1} from "../../security/host-value";

export interface FixedSecretConsumerRouteV1 {executorId:string;operationId:string;purposeId:string;consumer:NodeLocalSecretConsumerV1;}
const routeKey=(value:{executorId:string;operationId:string;purposeId:string})=>`${value.executorId}\u0000${value.operationId}\u0000${value.purposeId}`;
const safeId=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;
/** Narrow production-facing seam: callers select no code and can invoke only a prewired local consumer. */
export class FixedConsumerSecretBrokerV1{
  readonly #routes=new Map<string,NodeLocalSecretConsumerV1>();constructor(private readonly broker:NodeLocalSecretBrokerV1,routes:FixedSecretConsumerRouteV1[]){const values=exactHostDataArrayV1(routes,500);if(!values||values.length<1)throw new Error("fixed credential consumer routes invalid");for(const value of values){const route=exactHostDataSnapshotV1(value,["executorId","operationId","purposeId","consumer"]);if(!route||typeof route.executorId!=="string"||typeof route.operationId!=="string"||typeof route.purposeId!=="string"||!safeId.test(route.executorId)||!safeId.test(route.operationId)||!safeId.test(route.purposeId))throw new Error("fixed credential consumer route invalid");const consume=dataMethodV1(route.consumer,"consume");if(!consume)throw new Error("fixed credential consumer route invalid");const key=routeKey(route as {executorId:string;operationId:string;purposeId:string});if(this.#routes.has(key))throw new Error("duplicate fixed credential consumer route");this.#routes.set(key,{consume:consume.bind(route.consumer) as NodeLocalSecretConsumerV1["consume"]});}}
  invoke(input:{grant:unknown;now:string}):Promise<SecretInvocationReceiptV1>{const grant=parseSecretInvocationGrantV1(input.grant);const consumer=this.#routes.get(routeKey(grant));if(!consumer)throw new Error("fixed credential consumer route denied");return this.broker.invoke({grant,now:input.now,consumer});}
}
