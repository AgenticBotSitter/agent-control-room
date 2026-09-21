import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

const safePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && normalize(value) === value
  && !/[\u0000-\u001f\u007f]/u.test(value));
const safeArg = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const isResumeLikeArgument = (value: string) => value === "-r"
  || /^(?:--resume|--continue|--session-id)(?:=|$)/u.test(value);
const configurationSchema = z.object({ executablePath: safePath, args: z.array(safeArg).min(1).max(32)
  .refine(args => !args.some(isResumeLikeArgument), "resume is not supported"),
  workingDirectory: safePath, cleanupMs: z.number().int().min(1).max(5_000).default(2_000) }).strict();

export type PrivateClaudeCodeProcessAcquisitionConfigurationV1 = z.input<typeof configurationSchema>;

/** Validates fixed installation-owned command material without launching it.
 * This is containment/preflight only, not a Claude task runner: the existing
 * acquisition seam receives a digest binding but no canonical task input. */
export function capturePrivateClaudeCodeProcessAcquisitionConfigurationV1(value: unknown) {
  const parsed = configurationSchema.parse(value);
  return Object.freeze({ ...parsed, args: Object.freeze([...parsed.args]) });
}

/** No command, path, task, credential or acquisition capability is returned. */
export function preparePrivateClaudeCodeProcessHostPreflightV1(value: unknown) {
  capturePrivateClaudeCodeProcessAcquisitionConfigurationV1(value);
  return Object.freeze({ schema: "control-room.claude-code-private-process-host-preflight/v1" as const,
    configured: true as const, startsWork: false as const, grantsExecutionAuthority: false as const,
    permitsRetry: false as const, permitsResume: false as const });
}
