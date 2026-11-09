import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../security";
import { parseStrictJsonV1 } from "../../installer/shared/strict-json.mjs";
import type { SelectionSnapshotV1 } from "./loop-selection-service";

export const selectionSourceMaxBytesV1 = 1048576;
export const selectionSourceUnavailableV1 = () => new Error("selection_source_unavailable");
const safe = z.string().min(1).regex(/^[^\x00-\x1f\x7f-\x9f\ud800-\udfff]*$/u);
const version = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(v => Number.isSafeInteger(Number(v)));
const utc = z.string().refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
export const selectionAvailabilitySchemaV1 = z.object({ schema_version: z.literal(1), checked_at: utc,
  entries: z.array(z.object({ model: safe, route: safe, available: z.boolean() }).strict()).max(1000) }).strict()
  .refine(v => new Set(v.entries.map(e => canonicalJson([e.model, e.route]))).size === v.entries.length);
export type SelectionAvailabilityV1 = z.infer<typeof selectionAvailabilitySchemaV1>;
export const selectionSnapshotSchemaV1 = z.object({ rosterDigest: z.string().regex(/^[a-f0-9]{64}$/),
  availabilityDigest: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().regex(/^selection-source-v1:[a-f0-9]{32}$/) }).strict();
export const selectionSourceBundleSchemaV1 = z.object({ schemaVersion: z.literal(1),
  revision: selectionSnapshotSchemaV1.shape.revision,
  roster: z.object({ version, exportedVersion: version, text: z.string().min(1)
    .refine(v => !/[\x00-\x08\x0b-\x1f\x7f-\x9f\ud800-\udfff]/u.test(v)) }).strict()
    .refine(v => v.version === v.exportedVersion), availability: selectionAvailabilitySchemaV1 }).strict();
export type SelectionSourceBundleV1 = z.infer<typeof selectionSourceBundleSchemaV1>;
export const selectionSourceHashV1 = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function normalizeSelectionAvailabilityV1(value: unknown, now: number): SelectionAvailabilityV1 {
  const v = value as SelectionAvailabilityV1;
  z.string().datetime({ offset: true }).parse(v.checked_at);
  const health = selectionAvailabilitySchemaV1.parse({ ...v, checked_at: new Date(v.checked_at).toISOString() });
  const age = now - Date.parse(health.checked_at);
  if (!Number.isSafeInteger(now) || age < 0 || age > 3600000) throw selectionSourceUnavailableV1();
  health.entries.sort((a, b) => compare(a.model, b.model) || compare(a.route, b.route));
  return health;
}
export function encodeSelectionSourceBundleV1(value: SelectionSourceBundleV1): string {
  const text = canonicalJson(selectionSourceBundleSchemaV1.parse(value)) + "\n";
  if (Buffer.byteLength(text) > selectionSourceMaxBytesV1) throw selectionSourceUnavailableV1();
  return text;
}
export function decodeSelectionSourceBundleV1(bytes: Uint8Array, now: number): SelectionSourceBundleV1 {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const bundle = selectionSourceBundleSchemaV1.parse(parseStrictJsonV1(text, { maxBytes: selectionSourceMaxBytesV1 }));
  if (canonicalJson(bundle.availability) !== canonicalJson(normalizeSelectionAvailabilityV1(bundle.availability, now)))
    throw selectionSourceUnavailableV1();
  return bundle;
}
export function selectionSnapshotFromBundleV1(bundle: SelectionSourceBundleV1): SelectionSnapshotV1 {
  return Object.freeze({ revision: bundle.revision, rosterDigest: selectionSourceHashV1(bundle.roster.text),
    availabilityDigest: selectionSourceHashV1(canonicalJson(bundle.availability)) });
}
