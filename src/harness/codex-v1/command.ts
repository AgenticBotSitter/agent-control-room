import { isAbsolute, relative, resolve } from "node:path";
import type { AuthorityEnvelope } from "../../domain/v1/types";
import { assertAuthorityDigest } from "../../security";
import { CODEX_PINNED_EXECUTABLE_V1, codexAdapterManifestV1 } from "./manifest";
import { assertCodexWorkspaceLeaseV1, type CodexWorkspaceLeaseV1 } from "./workspace";
import { assertCodexCredentialBoundaryPermitV1, type CodexCredentialBoundaryPermitV1 } from "./credential-boundary";

export interface CodexExecPlanV1 {
  executable: string;
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
  resumable: boolean;
  sandbox: "read-only" | "workspace-write";
  verificationCommands: string[];
}

export interface CodexExecPlanInputV1 {
  runId: string;
  executable: string;
  cwd: string;
  prompt: string;
  model?: string;
  resumable: boolean;
  sandbox: "read-only" | "workspace-write";
  verificationCommands?: string[];
  authority: AuthorityEnvelope;
  now: string;
  workspaceLease?: CodexWorkspaceLeaseV1;
  credentialBoundaryPermit: CodexCredentialBoundaryPermitV1;
}

export function planCodexExecV1(input: CodexExecPlanInputV1): CodexExecPlanV1 {
  assertAuthorityDigest(input.authority);
  assertCodexCredentialBoundaryPermitV1(input.credentialBoundaryPermit, input.runId, input.now);
  if (input.model && input.model !== input.credentialBoundaryPermit.model) throw new Error("Codex model does not match credential boundary permit");
  const selectedModel = input.model ?? input.credentialBoundaryPermit.model;
  if (input.authority.allowedExecutor !== codexAdapterManifestV1.adapterId) throw new Error("Codex executor not authorized");
  if (Date.parse(input.authority.expiresAt) <= Date.parse(input.now)) throw new Error("Codex authority expired");
  if (!isAbsolute(input.executable) || !isAbsolute(input.cwd)) throw new Error("Codex executable and cwd must be absolute");
  if (resolve(input.executable) !== CODEX_PINNED_EXECUTABLE_V1) throw new Error("Codex executable is not the pinned binary");
  if (!input.prompt.trim() || input.prompt.length > 16_384) throw new Error("Codex prompt is invalid");
  if (!input.authority.filesystemRoots.some((root) => within(input.cwd, root))) throw new Error("Codex cwd outside authorized roots");
  if (input.authority.networkPolicy !== "none" || input.authority.allowedNetworkDestinations.length !== 0) throw new Error("Codex v1 requires node-enforced no-network authority");
  if (input.authority.credentialRefs.length !== 0) throw new Error("Codex v1 does not accept credential references in jobs");
  if (input.authority.effectPolicy !== "none" || input.authority.maxConcurrentEffects !== 0) throw new Error("Codex v1 effect authority must be none");
  if (input.sandbox === "workspace-write") {
    if (!input.authority.allowedOperations.includes("codex:workspace-write")) throw new Error("Codex workspace write not authorized");
    if (!input.workspaceLease) throw new Error("Codex workspace write requires an active workspace lease");
    assertCodexWorkspaceLeaseV1(input.workspaceLease);
    if (input.workspaceLease.runId !== input.runId || input.workspaceLease.checkoutPath !== resolve(input.cwd)) throw new Error("Codex workspace lease does not match the run and directory");
  } else if (input.workspaceLease) throw new Error("Codex read-only execution must not consume a write workspace lease");
  if (input.sandbox === "read-only" && !input.authority.allowedOperations.includes("codex:read")) throw new Error("Codex read not authorized");
  const verificationCommands = input.verificationCommands ?? [];
  if (verificationCommands.length > 20 || new Set(verificationCommands).size !== verificationCommands.length || verificationCommands.some((command) => !command.trim() || command.length > 1_024 || command.includes("\n"))) throw new Error("Codex verification commands are invalid");
  if (verificationCommands.length && !input.authority.allowedOperations.includes("codex:verify")) throw new Error("Codex verification not authorized");

  const args = [
    "exec", "--json", "--color", "never", "--strict-config", "--ignore-user-config", "--ignore-rules",
    "--sandbox", input.sandbox, "--cd", input.cwd, "--thread-source", "control-room-harness",
  ];
  if (!input.resumable) args.push("--ephemeral");
  args.push("--model", selectedModel);
  args.push("-");
  return { executable: resolve(input.executable), args, stdin: input.prompt, cwd: resolve(input.cwd), timeoutMs: input.authority.maxDurationSeconds * 1_000, resumable: input.resumable, sandbox: input.sandbox, verificationCommands };
}

export function planCodexResumeV1(input: Omit<CodexExecPlanInputV1, "resumable"> & { nativeThreadId: string }): CodexExecPlanV1 {
  if (!/^[0-9a-f-]{36}$/i.test(input.nativeThreadId)) throw new Error("invalid Codex native thread id");
  const base = planCodexExecV1({ ...input, resumable: true });
  base.args.pop();
  base.args.push("resume", input.nativeThreadId, "-");
  return base;
}

function within(child: string, root: string): boolean {
  if (!isAbsolute(root)) return false;
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
