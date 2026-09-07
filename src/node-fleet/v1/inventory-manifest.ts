import { createHash } from "node:crypto";
import { inventoryEntrySchema } from "./schemas";

export type InventoryKind = "bridge" | "harness" | "executor" | "tool";

export interface ApprovedInventoryEntry {
  kind: InventoryKind;
  id: string;
  version: string;
}

export interface InventoryManifest {
  manifestDigest: string;
  entries: Array<ApprovedInventoryEntry & { manifestDigest: string }>;
}

function stableMaterial(entries: ApprovedInventoryEntry[]): string {
  return JSON.stringify(entries.map((entry) => ({ kind: entry.kind, id: entry.id, version: entry.version })));
}

/**
 * Receives an already selected local allow-list, not arbitrary command output.
 * The caller must deliberately declare every item it wants to report.
 */
export function createInventoryManifest(entries: ApprovedInventoryEntry[]): InventoryManifest {
  const ordered = [...entries].sort((left, right) => `${left.kind}:${left.id}:${left.version}`.localeCompare(`${right.kind}:${right.id}:${right.version}`));
  const identities = ordered.map((entry) => `${entry.kind}:${entry.id}`);
  if (new Set(identities).size !== identities.length) throw new Error("inventory manifest contains duplicate identities");
  const material = stableMaterial(ordered);
  const manifestDigest = `sha256:${createHash("sha256").update(material).digest("hex")}`;
  const normalized = ordered.map((entry) => inventoryEntrySchema.parse({ ...entry, manifestDigest }));
  return { manifestDigest, entries: normalized };
}
