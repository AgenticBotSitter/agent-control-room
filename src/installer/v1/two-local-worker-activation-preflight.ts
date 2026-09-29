import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { verifyHermes021MacosProtectedWorkerReadinessV1 } from
  "../../harness/hermes-021-v1/protected-worker-readiness";
import { summarizeClaudeCodeLocalProcessReadinessV1,
  verifyClaudeCodeLocalProcessReadinessV1 } from "../../harness/claude-code-v1/local-process-readiness";

/**
 * Redacted, source-only view of the two local worker prerequisites. It is a
 * projection of evidence already produced by the existing Hermes and Claude
 * setup paths; it neither issues evidence nor changes either worker.
 */
export const TWO_LOCAL_WORKER_ACTIVATION_PREFLIGHT_V1 =
  "control-room.two-local-worker-activation-preflight/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const prerequisite = z.enum(["hermes_qualification_record", "claude_process_readiness"]);
const worker = z.object({ worker: z.enum(["hermes", "claude"]), prerequisite,
  status: z.enum(["prepared", "missing_local_proof"]), evidenceDigest: digest.optional() }).strict();
const materialSchema = z.object({ schema: z.literal(TWO_LOCAL_WORKER_ACTIVATION_PREFLIGHT_V1),
  status: z.enum(["prepared", "missing_local_proof"]), workers: z.array(worker).length(2),
  containsCredentialValue: z.literal(false), containsPrivatePath: z.literal(false),
  performsEffect: z.literal(false), readsProtectedFiles: z.literal(false), writesProtectedFiles: z.literal(false),
  startsService: z.literal(false), startsWorker: z.literal(false), invokesAgent: z.literal(false) }).strict();
const planSchema = materialSchema.extend({ preflightDigest: digest }).strict();

type LocalWorkerPreflightV1 = Readonly<{
  worker: "hermes" | "claude";
  prerequisite: "hermes_qualification_record" | "claude_process_readiness";
  status: "prepared" | "missing_local_proof";
  evidenceDigest?: string;
}>;

export type TwoLocalWorkerActivationPreflightV1 = Readonly<{
  schema: typeof TWO_LOCAL_WORKER_ACTIVATION_PREFLIGHT_V1;
  status: "prepared" | "missing_local_proof";
  workers: readonly LocalWorkerPreflightV1[];
  containsCredentialValue: false;
  containsPrivatePath: false;
  performsEffect: false;
  readsProtectedFiles: false;
  writesProtectedFiles: false;
  startsService: false;
  startsWorker: false;
  invokesAgent: false;
  preflightDigest: string;
}>;

function unavailable(): never {
  const error = new Error("two_local_worker_activation_preflight_unavailable");
  error.stack = undefined;
  throw error;
}

function freeze(value: z.infer<typeof planSchema>): TwoLocalWorkerActivationPreflightV1 {
  return Object.freeze({ ...value, workers: Object.freeze(value.workers.map(item => Object.freeze({ ...item }))) });
}

function coherentWorkers(workers: z.infer<typeof worker>[], status: "prepared" | "missing_local_proof") {
  if (workers.length !== 2) return false;
  const [hermes, claude] = workers;
  if (!hermes || !claude || hermes.worker !== "hermes" || hermes.prerequisite !== "hermes_qualification_record"
    || claude.worker !== "claude" || claude.prerequisite !== "claude_process_readiness") return false;
  if (workers.some(item => (item.status === "prepared") !== (typeof item.evidenceDigest === "string"))) return false;
  return (status === "prepared") === workers.every(item => item.status === "prepared");
}

/**
 * Reports only the exact local setup evidence already available to the
 * installer. Supplying malformed or stale evidence is refused rather than
 * converted into a misleading missing status. Omitting a prerequisite is the
 * sole way to report it as missing.
 */
export function projectTwoLocalWorkerActivationPreflightV1(input: Readonly<{
  hermes?: Readonly<{ readiness: unknown; currentInput: unknown }>;
  claude?: Readonly<{ readiness: unknown; planDigest: string }>;
}>): TwoLocalWorkerActivationPreflightV1 {
  try {
    const hermes = input.hermes === undefined ? undefined : verifyHermes021MacosProtectedWorkerReadinessV1(
      input.hermes.readiness, input.hermes.currentInput);
    const claude = input.claude === undefined ? undefined : verifyClaudeCodeLocalProcessReadinessV1(input.claude.readiness);
    if (claude && claude.planDigest !== digest.parse(input.claude?.planDigest)) return unavailable();
    const claudePrepared = claude !== undefined
      && summarizeClaudeCodeLocalProcessReadinessV1(claude.planDigest, claude).state === "readiness_recorded";
    const workers = [
      hermes === undefined ? { worker: "hermes" as const, prerequisite: "hermes_qualification_record" as const,
        status: "missing_local_proof" as const }
        : { worker: "hermes" as const, prerequisite: "hermes_qualification_record" as const,
          status: "prepared" as const, evidenceDigest: hermes.readinessDigest },
      !claudePrepared ? { worker: "claude" as const, prerequisite: "claude_process_readiness" as const,
        status: "missing_local_proof" as const }
        : { worker: "claude" as const, prerequisite: "claude_process_readiness" as const,
          status: "prepared" as const, evidenceDigest: claude.readinessDigest },
    ];
    const material = materialSchema.parse({ schema: TWO_LOCAL_WORKER_ACTIVATION_PREFLIGHT_V1,
      status: workers.every(item => item.status === "prepared") ? "prepared" : "missing_local_proof", workers,
      containsCredentialValue: false, containsPrivatePath: false, performsEffect: false, readsProtectedFiles: false,
      writesProtectedFiles: false, startsService: false, startsWorker: false, invokesAgent: false });
    return freeze(planSchema.parse({ ...material, preflightDigest: sha256Digest(material) }));
  } catch {
    return unavailable();
  }
}

/** Recomputes the redacted projection digest before it is presented elsewhere. */
export function verifyTwoLocalWorkerActivationPreflightV1(value: unknown): TwoLocalWorkerActivationPreflightV1 {
  try {
    const parsed = planSchema.parse(value), { preflightDigest, ...material } = parsed;
    if (!coherentWorkers(parsed.workers, parsed.status) || preflightDigest !== sha256Digest(material)) return unavailable();
    return freeze(parsed);
  } catch {
    return unavailable();
  }
}
