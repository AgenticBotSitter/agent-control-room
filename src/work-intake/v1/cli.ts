import { types } from "node:util";

export const WORK_INTAKE_CLI_V1 = "control-room.work-intake-cli/v1" as const;
export type WorkIntakeCliCommandV1 = "submit-batch" | "batch-status" | "batches";
type Client = Readonly<{ submit(value: unknown): Promise<unknown>; status(value: unknown): Promise<unknown>;
  list(value: unknown): Promise<unknown> }>;
export type WorkIntakeCliRuntimeV1 = Readonly<{ loadProtectedClient(): Promise<Client>;
  readInput(): Promise<unknown>; report(message: string): void; reportError(message: string): void }>;

function refused(): never { const error = new Error("work_intake_cli_refused"); error.stack = undefined; throw error; }

export function parseWorkIntakeArgumentsV1(args: unknown): { help: true } | { command: WorkIntakeCliCommandV1 } {
  if (!Array.isArray(args) || Object.getPrototypeOf(args) !== Array.prototype || Object.getOwnPropertySymbols(args).length
    || args.some(value => typeof value !== "string")) refused();
  if (args.length === 1 && args[0] === "--help") return { help: true };
  if (args.length === 1 && ["submit-batch", "batch-status", "batches"].includes(args[0]!))
    return { command: args[0] as WorkIntakeCliCommandV1 };
  return refused();
}

function runtime(value: unknown): WorkIntakeCliRuntimeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) refused();
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "loadProtectedClient,readInput,report,reportError"
    || typeof candidate.loadProtectedClient !== "function" || typeof candidate.readInput !== "function"
    || typeof candidate.report !== "function" || typeof candidate.reportError !== "function") refused();
  return value as WorkIntakeCliRuntimeV1;
}

function exactInput(command: WorkIntakeCliCommandV1, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) refused();
  const candidate = value as Record<string, unknown>;
  const expected = command === "submit-batch" ? ["idempotencyKey", "projectId", "proposal"]
    : command === "batch-status" ? ["batchId", "projectId"] : ["projectId"];
  if (Object.keys(candidate).sort().join(",") !== expected.sort().join(",")
    || typeof candidate.projectId !== "string"
    || (command === "submit-batch" && (typeof candidate.idempotencyKey !== "string"
      || !candidate.proposal || typeof candidate.proposal !== "object" || Array.isArray(candidate.proposal)))
    || (command === "batch-status" && typeof candidate.batchId !== "string")) refused();
  return candidate;
}

/** Runs one source-only command. Credential material remains behind loadProtectedClient. */
export async function runWorkIntakeCliV1(args: unknown, value: unknown): Promise<number> {
  let rt: WorkIntakeCliRuntimeV1;
  try { rt = runtime(value); } catch { return 2; }
  let parsed: ReturnType<typeof parseWorkIntakeArgumentsV1>;
  try { parsed = parseWorkIntakeArgumentsV1(args); }
  catch { rt.reportError("Work intake command refused its arguments."); return 2; }
  if ("help" in parsed) {
    rt.report("Usage: work-intake (submit-batch | batch-status | batches)\n");
    rt.report("Reads one bounded JSON request from standard input and a credential from the protected store.\n");
    return 0;
  }
  try {
    const [client, rawInput] = await Promise.all([rt.loadProtectedClient(), rt.readInput()]);
    const input = exactInput(parsed.command, rawInput);
    const operation = parsed.command === "submit-batch" ? client.submit.bind(client)
      : parsed.command === "batch-status" ? client.status.bind(client) : client.list.bind(client);
    const result = await operation(input);
    rt.report(`${JSON.stringify({ schema: WORK_INTAKE_CLI_V1, command: parsed.command, result })}\n`);
    return 0;
  } catch { rt.reportError("Work intake command did not complete."); return 1; }
}
