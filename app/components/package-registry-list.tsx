import type { JSX } from "react";

export interface PackageRegistryProjectionV1 {
  packageId: string; projectId: string; kind: "procedure" | "knowledge"; name: string; version: string; packageDigest: string;
  state: "active" | "candidate" | "rejected" | "superseded"; trust: "unreviewed" | "reviewed" | "rejected";
  adapterId: string; adapterVersion: string; platform: "linux" | "macos" | "windows"; compatibility: "verified" | "rejected" | "pending";
}

function label(value: string): string { return value.replaceAll("_"," ").replace(/\b\w/g,(letter)=>letter.toUpperCase()); }

/** Read-only projection. Package activation remains a separately reviewed registry operation. */
export function PackageRegistryList({ packages }: { packages: readonly PackageRegistryProjectionV1[] }): JSX.Element {
  return <div className="package-registry" aria-label="Procedure and knowledge registry">
    <p className="package-registry-boundary">Packages supply reviewed instructions or facts. They never supply policy, approval, dispatch, credentials, or execution authority.</p>
    {packages.length === 0 ? <p className="empty-state">No package versions are visible in this scope.</p> : <ol className="package-registry-list">
      {packages.map((item)=><li key={item.packageId} className={`package-registry-item state-${item.state}`}>
        <div><span>{label(item.kind)} · {label(item.state)}</span><small>{label(item.trust)} · {label(item.compatibility)}</small></div>
        <h3>{item.name} <b>v{item.version}</b></h3><p>{item.projectId}</p>
        <small>{item.adapterId} v{item.adapterVersion} · {label(item.platform)} · {item.packageDigest.slice(0,19)}…</small>
      </li>)}
    </ol>}
  </div>;
}
