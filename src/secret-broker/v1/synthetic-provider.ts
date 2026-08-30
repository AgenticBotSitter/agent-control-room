import type {NodeLocalSecretProviderV1,SecretProviderResultCollectorV1} from "./types";
import {exactHostUint8ArrayV1} from "../../security/host-value";

/** Test-only provider. Production provider construction remains disabled. */
export class SyntheticSecretProviderV1 implements NodeLocalSecretProviderV1{
  readonly providerKind="synthetic_test" as const;readonly #values=new Map<string,{referenceDigest:string;material:Uint8Array}>();#acquires=0;#releases=0;
  constructor(fixtures:Array<{credentialRef:string;providerReferenceDigest:string;material:Uint8Array}>){for(const fixture of fixtures){const material=exactHostUint8ArrayV1(fixture.material,65_536);if(!material||material.byteLength<1)throw new Error("synthetic credential fixture invalid");this.#values.set(fixture.credentialRef,{referenceDigest:fixture.providerReferenceDigest,material:material.copy()});}}
  async acquire(input:{credentialRef:string;providerReferenceDigest:string;invocationId:string},result:SecretProviderResultCollectorV1):Promise<void>{this.#acquires++;const value=this.#values.get(input.credentialRef);if(!value||value.referenceDigest!==input.providerReferenceDigest){result.submit({status:"unavailable",safeCode:"missing"});return;}const material=exactHostUint8ArrayV1(value.material,65_536)!.copy();result.submit({status:"resolved",material,release:async()=>{this.#releases++;}});}
  safeMetrics(){return{acquires:this.#acquires,releases:this.#releases};}
}
