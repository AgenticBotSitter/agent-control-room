import {exactHostDataArrayV1,exactHostDataSnapshotV1,ownDataPropertyValueV1} from "../../security/host-value";

/** Snapshots an untrusted exact envelope before schema parsing. */
export function exactDataSnapshotV1(value:unknown,keys:readonly string[]):Record<string,unknown>|undefined {
  return exactHostDataSnapshotV1(value,keys,[],{allowNullPrototype:true});
}

export function ownDataValueV1(value:unknown,key:string):unknown {
  return ownDataPropertyValueV1(value,key);
}

export function exactDataArrayV1(value:unknown,maximum:number):unknown[]|undefined {
  return exactHostDataArrayV1(value,maximum);
}
