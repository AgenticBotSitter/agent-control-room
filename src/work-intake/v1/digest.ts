import { sha256Digest } from "../../security";
import { workBatchProposalSchemaV1 } from "./schemas";

/** Server-side canonical digest. Keep Node crypto out of browser wire schemas. */
export function workBatchProposalDigestV1(value: unknown): string {
  return sha256Digest(workBatchProposalSchemaV1.parse(value));
}
