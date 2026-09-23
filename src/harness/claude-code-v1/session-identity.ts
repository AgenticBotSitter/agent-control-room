import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { digestSchema, localId } from "../v1/native-run-identifiers";

/**
 * Derives the UUID-shaped session selected by a future fixed Claude CLI
 * invocation. It is pure: this module neither locates Claude, launches a
 * process, reads credentials, nor creates any new authority record.
 */
const bindingSchema = z.object({
  processAttemptId: localId,
  runId: localId,
  attemptId: localId,
  invocationDigest: digestSchema,
}).strict();

export type ClaudeCodeExpectedSessionBindingV1 = z.infer<typeof bindingSchema>;

export function deriveClaudeCodeExpectedSessionIdV1(value: unknown): string {
  const binding = bindingSchema.parse(value);
  const hex = sha256Digest({ schema: "control-room.claude-code-expected-session/v1", binding }).slice(7);
  const variant = ["8", "9", "a", "b"][Number.parseInt(hex[16]!, 16) & 3]!;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
