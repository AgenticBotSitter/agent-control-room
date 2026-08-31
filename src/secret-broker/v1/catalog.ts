import {assertNoSecretMaterial} from "../../security/redaction";
import {computeCredentialCatalogEntryDigestV1,parseCredentialCatalogEntryV1} from "./grant";
import type {CredentialCatalogEntryV1} from "./types";

function isolated(entry:CredentialCatalogEntryV1):CredentialCatalogEntryV1{const value=structuredClone(entry);Object.freeze(value.projectIds);Object.freeze(value.executorIds);Object.freeze(value.operationIds);Object.freeze(value.purposeIds);return Object.freeze(value);}
function returned(entry:CredentialCatalogEntryV1):CredentialCatalogEntryV1{return isolated(entry);}

export class SafeCredentialCatalogV1{
  readonly #entries=new Map<string,CredentialCatalogEntryV1>();
  register(value:unknown):{entry:CredentialCatalogEntryV1;replayed:boolean}{const entry=parseCredentialCatalogEntryV1(value);const known=this.#entries.get(entry.credentialRef);if(known){if(known.entryDigest!==entry.entryDigest)throw new Error("catalog conflict");return{entry:returned(known),replayed:true};}const stored=isolated(entry);this.#entries.set(stored.credentialRef,stored);return{entry:returned(stored),replayed:false};}
  replace(input:{expectedEntryDigest:string;entry:unknown}):CredentialCatalogEntryV1{const next=parseCredentialCatalogEntryV1(input.entry);const current=this.#entries.get(next.credentialRef);if(!current||current.entryDigest!==input.expectedEntryDigest)throw new Error("catalog conflict");
    if(next.tenantId!==current.tenantId||next.nodeId!==current.nodeId||next.createdAt!==current.createdAt||next.revision!==current.revision+1||Date.parse(next.rotatedAt)<Date.parse(current.rotatedAt)||next.entryDigest===current.entryDigest)throw new Error("catalog replacement invalid");const stored=isolated(next);this.#entries.set(stored.credentialRef,stored);return returned(stored);}
  resolve(credentialRef:string):CredentialCatalogEntryV1|undefined{const value=this.#entries.get(credentialRef);return value?returned(value):undefined;}
  safeSnapshot():CredentialCatalogEntryV1[]{const values=[...this.#entries.values()].sort((a,b)=>a.credentialRef.localeCompare(b.credentialRef));assertNoSecretMaterial(values,"credential catalog snapshot");return values.map(returned);}
}

export function buildCredentialCatalogEntryV1(input:Omit<CredentialCatalogEntryV1,"entryDigest">):CredentialCatalogEntryV1{return parseCredentialCatalogEntryV1({...input,entryDigest:computeCredentialCatalogEntryDigestV1({...input,entryDigest:"sha256:"+"0".repeat(64)})});}
